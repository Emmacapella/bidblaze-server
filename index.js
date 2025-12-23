const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const axios = require('axios'); // Required for Blockchain checks

const app = express();
app.use(cors());

// --- 1. CONFIGURATION ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TELEGRAM_TOKEN = "8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI";
const MY_CHAT_ID = "6571047127";
const PING_URL = "https://bidblaze-server.onrender.com"; 

// ⚠️ IMPORTANT: REPLACE THESE WITH YOUR REAL ADDRESSES & KEYS ⚠️
const ADMIN_WALLETS = {
    EVM: "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c", // Address for BNB, ETH, BASE
    TRON: "TYourTronWalletHere"        // Address for TRON (USDT)
};

const API_KEYS = {
    BSC: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV",    // Get free key from bscscan.com
    ETH: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV",  // Get free key from etherscan.io
    BASE: "YQYHD2PR83K37I6D8Y87YU7QK9RVRJDUJV", //Get free key from basescan.org
    TRON: "None"                // Tron usually works without key
};

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 2. GAME VARIABLES ---
let gameState = {
  status: 'ACTIVE',
  endTime: Date.now() + 300000, 
  jackpot: 0.00,
  bidCost: 1.00,
  lastBidder: null,
  history: [],          
  // Dummy winners so the panel isn't empty on restart
  recentWinners: [
      { user: 'AlexKing@gmail.com', amount: 155.00, time: Date.now() },
      { user: 'SarahJ@yahoo.com', amount: 98.50, time: Date.now() },
      { user: 'CryptoFan@gmail.com', amount: 210.00, time: Date.now() }
  ],    
  connectedUsers: 0,
  restartTimer: null,
  bidders: [],          
  userInvestments: {}   
};

// --- 3. KEEP ALIVE (For Render) ---
setInterval(() => {
  https.get(PING_URL).on('error', () => {});
}, 300000);

function sendTelegramAlert(message) {
  if (!TELEGRAM_TOKEN || !MY_CHAT_ID) return;
  const text = encodeURIComponent(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;
  https.get(url).on('error', () => {});
}

// --- 4. GAME LOOP ---
setInterval(async () => {
  const now = Date.now();
  
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      // SCENARIO A: REFUND (Only 1 Player)
      if (gameState.bidders.length === 1) {
          const lonePlayer = gameState.bidders[0];
          const refundAmount = gameState.userInvestments[lonePlayer] || 0;
          
          console.log(`VOID: Refund ${lonePlayer}`);
          const { data: user } = await supabase.from('users').select('balance').eq('email', lonePlayer).single();
          if (user) {
              await supabase.from('users').update({ balance: user.balance + refundAmount }).eq('email', lonePlayer);
          }
      } 
      // SCENARIO B: WINNER (2+ Players)
      else if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const winnerEmail = gameState.lastBidder;
          const winAmount = gameState.jackpot;
          
          console.log(`WIN: ${winnerEmail}`);
          const { data: winner } = await supabase.from('users').select('balance').eq('email', winnerEmail).single();
          if (winner) {
              await supabase.from('users').update({ balance: winner.balance + winAmount }).eq('email', winnerEmail);
              sendTelegramAlert(`🏆 WINNER: ${winnerEmail} won $${winAmount.toFixed(2)}!`);
          }
          gameState.recentWinners.unshift({ user: winnerEmail, amount: winAmount, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE';
      gameState.endTime = now + 300000;
      gameState.jackpot = 0.00;
      gameState.lastBidder = null;
      gameState.history = [];
      gameState.bidders = [];
      gameState.userInvestments = {};
    }
  }
  io.emit('gameState', gameState);
}, 100);

// --- 5. SOCKET HANDLERS ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  gameState.connectedUsers++;

  // A. GET BALANCE
  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email);
    let { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!user) {
       await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
       user = { balance: 0.00 };
    }
    socket.emit('balanceUpdate', user.balance);
  });

  // B. PLACE BID
  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!user || user.balance < gameState.bidCost) {
      socket.emit('bidError', 'Insufficient Funds');
      return;
    }
    const newBalance = user.balance - gameState.bidCost;
    await supabase.from('users').update({ balance: newBalance }).eq('email', email);
    socket.emit('balanceUpdate', newBalance);

    gameState.jackpot += (gameState.bidCost * 0.95); 
    gameState.lastBidder = email;
    
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (!gameState.userInvestments[email]) gameState.userInvestments[email] = 0;
    gameState.userInvestments[email] += gameState.bidCost;

    const timeRemaining = gameState.endTime - Date.now();
    if (timeRemaining < 10000) gameState.endTime = Date.now() + 10000;
    
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();

    io.emit('gameState', gameState);
  });

  // C. LINK WALLET (Security Step 1)
  socket.on('linkWallet', async ({ email, walletAddress }) => {
      // 1. Check if user already has a pending deposit
      const { data: user } = await supabase.from('users').select('wallet_address').eq('email', email).single();
      if (user.wallet_address && user.wallet_address.length > 5) {
          socket.emit('depositError', 'You already have an active deposit. Cancel it to start new.');
          return;
      }
      // 2. Check if address is taken by someone else
      const { data: existing } = await supabase.from('users').select('email').eq('wallet_address', walletAddress).single();
      if (existing && existing.email !== email) {
          socket.emit('depositError', 'Wallet address linked to another user!');
          return;
      }
      // 3. Save it
      await supabase.from('users').update({ wallet_address: walletAddress }).eq('email', email);
      // Determine which admin wallet to show based on length (simplified) or generic
      socket.emit('walletLinked', { success: true, adminWallet: ADMIN_WALLETS.EVM }); 
  });

  // D. CANCEL DEPOSIT
  socket.on('cancelDeposit', async (email) => {
      await supabase.from('users').update({ wallet_address: null }).eq('email', email);
      socket.emit('depositCancelled', 'Deposit session cancelled.');
  });

  // E. VERIFY DEPOSIT (Multi-Chain)
  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      const { data: user } = await supabase.from('users').select('wallet_address, balance').eq('email', email).single();
      if (!user || !user.wallet_address) {
          socket.emit('depositError', 'No active deposit found.');
          return;
      }

      let apiUrl = "";
      let isTron = false;

      // Select API based on Network
      switch (network) {
          case 'BSC': apiUrl = `https://api.bscscan.com/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.BSC}`; break;
          case 'ETH': apiUrl = `https://api.etherscan.io/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.ETH}`; break;
          case 'BASE': apiUrl = `https://api.basescan.org/api?module=proxy&action=eth_getTransactionByHash&txhash=${txHash}&apikey=${API_KEYS.BASE}`; break;
          case 'TRON': apiUrl = `https://apilist.tronscan.org/api/transaction-info?hash=${txHash}`; isTron = true; break;
          default: socket.emit('depositError', 'Invalid Network'); return;
      }

      try {
          const response = await axios.get(apiUrl);
          let valid = false;
          let amount = 0;
          let sender = "";
          let receiver = "";

          // --- TRON LOGIC ---
          if (isTron) {
              const data = response.data;
              if (!data || !data.contractRet || data.contractRet !== "SUCCESS") {
                  socket.emit('depositError', 'Transaction failed or not found.');
                  return;
              }
              // Check for USDT Transfer (TRC20)
              if (data.tokenTransferInfo) {
                  sender = data.tokenTransferInfo.from_address;
                  receiver = data.tokenTransferInfo.to_address;
                  amount = parseFloat(data.tokenTransferInfo.amount_str) / 1e6; // USDT (6 decimals)
              } else {
                  // Direct TRX
                  sender = data.ownerAddress;
                  receiver = data.toAddress;
                  amount = data.amount / 1e6; 
              }
              
              if (sender === user.wallet_address && receiver === ADMIN_WALLETS.TRON) valid = true;
          } 
          // --- EVM LOGIC (BSC, ETH, BASE) ---
          else {
              const tx = response.data.result;
              if (!tx) { socket.emit('depositError', 'Transaction not found.'); return; }
              sender = tx.from.toLowerCase();
              receiver = tx.to.toLowerCase();
              amount = parseInt(tx.value, 16) / 1e18; // 18 decimals

              if (sender === user.wallet_address.toLowerCase() && receiver === ADMIN_WALLETS.EVM.toLowerCase()) valid = true;
          }

          if (valid) {
              // Check Duplicate
              const { data: used } = await supabase.from('deposits').select('id').eq('tx_hash', txHash).single();
              if (used) { socket.emit('depositError', 'Transaction already used.'); return; }

              // Calculate Credits (Rate: 1 Coin = $X credits)
              let rate = 1;
              if (network === 'BSC') rate = 600; 
              if (network === 'ETH' || network === 'BASE') rate = 3000;
              if (network === 'TRON') rate = 1; // USDT $1 = 1 Credit

              const credits = amount * rate;
              const newBal = user.balance + credits;

              // Update DB
              await supabase.from('users').update({ balance: newBal, wallet_address: null }).eq('email', email);
              await supabase.from('deposits').insert([{
                  user_email: email, amount: amount, tx_hash: txHash, 
                  sender_address: sender, status: 'COMPLETED', network: network
              }]);

              socket.emit('depositSuccess', newBal);
              socket.emit('balanceUpdate', newBal);
          } else {
              socket.emit('depositError', 'Verification Failed: Sender/Receiver mismatch.');
          }

      } catch (err) {
          console.error(err);
          socket.emit('depositError', 'Network Error. Try again.');
      }
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

// --- 6. SERVE FRONTEND (REGEX FIX) ---
app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- 7. START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

