const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios'); 

const app = express();
app.use(cors());

// --- 1. CONFIGURATION ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ⚠️ TELEGRAM SETTINGS
const TELEGRAM_TOKEN = "8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI";
const MY_CHAT_ID = "6571047127"; 
const PING_URL = "https://bidblaze-server.onrender.com"; 

// ⚠️ YOUR ADMIN WALLET
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c"; 

const API_KEYS = {
    BSC: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV",    
    ETH: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV",  
    BASE: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV"
};

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 2. GAME VARIABLES ---
let gameState = {
  status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 0.00, bidCost: 1.00,
  lastBidder: null, history: [], recentWinners: [], connectedUsers: 0,
  restartTimer: null, bidders: [], userInvestments: {}
};

// --- 3. TELEGRAM ALERT (FIXED) ---
function sendTelegramAlert(message) {
  if (!TELEGRAM_TOKEN || !MY_CHAT_ID) {
      console.log("❌ Telegram Error: Missing Token or Chat ID");
      return;
  }
  const text = encodeURIComponent(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;
  
  https.get(url, (res) => {
      if (res.statusCode !== 200) {
          console.log(`❌ Telegram Failed: Status Code ${res.statusCode}`);
      }
  }).on('error', (e) => {
      console.error(`❌ Telegram Error: ${e.message}`);
  });
}

// Keep-Alive
setInterval(() => { https.get(PING_URL).on('error', () => {}); }, 300000);

// --- 4. GAME LOOP ---
setInterval(async () => {
  const now = Date.now();
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      if (gameState.bidders.length === 1) {
          const lonePlayer = gameState.bidders[0];
          const refundAmount = gameState.userInvestments[lonePlayer] || 0;
          const { data: user } = await supabase.from('users').select('balance').eq('email', lonePlayer).single();
          if (user) await supabase.from('users').update({ balance: user.balance + refundAmount }).eq('email', lonePlayer);
      } 
      else if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const winnerEmail = gameState.lastBidder;
          const winAmount = gameState.jackpot;
          const { data: winner } = await supabase.from('users').select('balance').eq('email', winnerEmail).single();
          if (winner) {
              await supabase.from('users').update({ balance: winner.balance + winAmount }).eq('email', winnerEmail);
              sendTelegramAlert(`🏆 *WINNER:* ${winnerEmail} won $${winAmount.toFixed(2)}!`);
          }
          gameState.recentWinners.unshift({ user: winnerEmail, amount: winAmount, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE'; gameState.endTime = now + 300000;
      gameState.jackpot = 0.00; gameState.lastBidder = null;
      gameState.history = []; gameState.bidders = []; gameState.userInvestments = {};
    }
  }
  io.emit('gameState', gameState);
}, 100);

// --- 5. SOCKET HANDLERS ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  gameState.connectedUsers++;

  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    const cleanEmail = email.toLowerCase();
    socket.join(email);
    let { data: user } = await supabase.from('users').select('balance').eq('email', cleanEmail).single();
    if (!user) {
       await supabase.from('users').insert([{ email: cleanEmail, balance: 0.00 }]);
       user = { balance: 0.00 };
    }
    socket.emit('balanceUpdate', user.balance);

    const { data: withdrawals } = await supabase.from('withdrawals').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
    socket.emit('withdrawalHistory', withdrawals || []);
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const cleanEmail = email.toLowerCase();
    const { data: user } = await supabase.from('users').select('balance').eq('email', cleanEmail).single();
    if (!user || user.balance < gameState.bidCost) {
      socket.emit('bidError', 'Insufficient Funds'); return;
    }
    const newBalance = user.balance - gameState.bidCost;
    await supabase.from('users').update({ balance: newBalance }).eq('email', cleanEmail);
    socket.emit('balanceUpdate', newBalance);

    gameState.jackpot += (gameState.bidCost * 0.95); 
    gameState.lastBidder = cleanEmail;
    if (!gameState.bidders.includes(cleanEmail)) gameState.bidders.push(cleanEmail);
    if (!gameState.userInvestments[cleanEmail]) gameState.userInvestments[cleanEmail] = 0;
    gameState.userInvestments[cleanEmail] += gameState.bidCost;

    const timeRemaining = gameState.endTime - Date.now();
    if (timeRemaining < 10000) gameState.endTime = Date.now() + 10000;
    
    gameState.history.unshift({ id: Date.now(), user: cleanEmail, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();
    io.emit('gameState', gameState);
  });

  // --- AUTOMATIC VERIFY (No Link Needed) ---
  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      const cleanEmail = email.toLowerCase();
      // Only check if user exists, don't need linked wallet anymore
      const { data: user } = await supabase.from('users').select('balance').eq('email', cleanEmail).single();
      if (!user) { socket.emit('depositError', 'User not found.'); return; }

      let apiUrl = "";
      switch (network) {
          case 'BSC': apiUrl = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.BSC}`; break;
          case 'ETH': apiUrl = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.ETH}`; break;
          case 'BASE': apiUrl = `https://api.basescan.org/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.BASE}`; break;
          default: socket.emit('depositError', 'Invalid Network'); return;
      }

      try {
          const response = await axios.get(apiUrl);
          const tx = response.data.result;
          if (!tx) { socket.emit('depositError', 'Transaction not found on Blockchain.'); return; }
          
          const receiver = tx.to.toLowerCase();
          const sender = tx.from.toLowerCase(); // We capture this automatically now
          const amount = parseInt(tx.value, 16) / 1e18; 

          // Verify it went to ADMIN
          if (receiver !== ADMIN_WALLET.toLowerCase()) { 
              socket.emit('depositError', 'Money was not sent to our Admin Wallet.'); 
              return; 
          }

          // Check Reuse
          const { data: used } = await supabase.from('deposits').select('id').eq('tx_hash', txHash).single();
          if (used) { socket.emit('depositError', 'Transaction already processed.'); return; }

          let rate = 1;
          if (network === 'BSC') rate = 600; 
          if (network === 'ETH' || network === 'BASE') rate = 3000;

          const credits = amount * rate;
          const newBal = user.balance + credits;

          await supabase.from('users').update({ balance: newBal }).eq('email', cleanEmail);
          
          await supabase.from('deposits').insert([{
              user_email: cleanEmail, amount: amount, tx_hash: txHash, 
              sender_address: sender, status: 'COMPLETED', network: network
          }]);

          sendTelegramAlert(`💰 *DEPOSIT:* ${cleanEmail} deposited $${amount} (${network})!`);

          socket.emit('depositSuccess', newBalance);
          socket.emit('balanceUpdate', newBalance);

      } catch (err) {
          console.error(err);
          socket.emit('depositError', 'Verification Error. Try again.');
      }
  });

  socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
      const cleanEmail = email.toLowerCase();
      const { data: user } = await supabase.from('users').select('balance').eq('email', cleanEmail).single();
      
      if (!user || user.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }
      if (amount < 10) { socket.emit('withdrawalError', 'Min withdrawal is $10'); return; }

      const newBalance = user.balance - amount;
      const { error } = await supabase.from('users').update({ balance: newBalance }).eq('email', cleanEmail);
      if (error) { socket.emit('withdrawalError', 'Database Error'); return; }

      await supabase.from('withdrawals').insert([{
          user_email: cleanEmail, amount: amount, wallet_address: address, network: network, status: 'PENDING'
      }]);

      sendTelegramAlert(`💸 *WITHDRAWAL REQUEST:* \nUser: ${cleanEmail}\nAmount: $${amount}\nNet: ${network}\nAddr: \`${address}\``);

      socket.emit('withdrawalSuccess', newBalance);
      socket.emit('balanceUpdate', newBalance);
      
      const { data: withdrawals } = await supabase.from('withdrawals').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
      socket.emit('withdrawalHistory', withdrawals || []);
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') {
        gameState.status = 'ACTIVE'; gameState.endTime = Date.now() + 300000;
        gameState.jackpot = 50.00; gameState.history = [];
        gameState.bidders = []; gameState.userInvestments = {};
     } else if (action === 'SET_JACKPOT') gameState.jackpot = parseFloat(value);
  });

  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

// --- ROUTES ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => { res.sendFile(path.join(__dirname, 'dist', 'index.html')); });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => { console.log(`Server running on port ${PORT}`); });

