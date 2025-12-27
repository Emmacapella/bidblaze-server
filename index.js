const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');
const TelegramBot = require('node-telegram-bot-api'); // ⚠️ NEW IMPORT

const app = express();
app.use(cors());

// --- TELEGRAM CONFIGURATION (REPLACE THESE!) ---
const TELEGRAM_TOKEN = '8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI'; // Get from @BotFather
const TELEGRAM_CHAT_ID = '6571047127'; // Get from @userinfobot or your channel ID
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// --- SUPABASE & WALLET ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c"; 

// --- HELPER: SEND TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (TELEGRAM_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN') return; // Don't send if not set
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// PROVIDER SETUP
const getProvider = (url) => {
    if (ethers.providers && ethers.providers.JsonRpcProvider) {
        return new ethers.providers.JsonRpcProvider(url); 
    }
    return new ethers.JsonRpcProvider(url); 
};

const providers = {
    BSC: getProvider('https://bsc-dataseed.binance.org/'),
    ETH: getProvider('https://cloudflare-eth.com'),
    BASE: getProvider('https://mainnet.base.org')
};

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let gameState = { status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 100.00, bidCost: 1.00, lastBidder: null, history: [], recentWinners: [], connectedUsers: 0, restartTimer: null, bidders: [], userInvestments: {} };

// GAME LOOP
setInterval(async () => {
  const now = Date.now();
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED'; gameState.restartTimer = now + 15000; 
      
      if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const win = gameState.lastBidder;
          const amt = gameState.jackpot;
          
          // DATABASE UPDATE
          const { data: u } = await supabase.from('users').select('balance').eq('email', win).single();
          if (u) await supabase.from('users').update({ balance: u.balance + amt }).eq('email', win);
          
          gameState.recentWinners.unshift({ user: win, amount: amt, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();

          // 🚨 TELEGRAM ALERT: WINNER
          sendTelegram(`🏆 *JACKPOT WON!*\n\n👤 User: \`${win}\`\n💰 Amount: *$${amt.toFixed(2)}*\n🔥 The game is restarting!`);
      } else {
          // REFUND IF NO OPPONENTS
          if (gameState.lastBidder) {
             sendTelegram(`⚠️ *NO CONTEST*\nGame ended with only 1 player. Refund issued.`);
          }
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE'; gameState.endTime = now + 300000; gameState.jackpot = 50.00; gameState.lastBidder = null; gameState.history = []; gameState.bidders = []; gameState.userInvestments = {};
      sendTelegram(`🚀 *NEW GAME STARTED*\nJackpot: $50.00\nBid Cost: $1.00`);
    }
  }
  io.emit('gameState', gameState);
}, 1000);

io.on('connection', (socket) => {
  gameState.connectedUsers++;
  
  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email);
    let { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!u) { await supabase.from('users').insert([{ email, balance: 0.00 }]); u = { balance: 0.00 }; }
    socket.emit('balanceUpdate', u.balance);
    
    const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
    socket.emit('withdrawalHistory', w || []);
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!u || u.balance < gameState.bidCost) { socket.emit('bidError', 'Insufficient Funds'); return; }
    
    await supabase.from('users').update({ balance: u.balance - gameState.bidCost }).eq('email', email);
    socket.emit('balanceUpdate', u.balance - gameState.bidCost);
    
    gameState.jackpot += (gameState.bidCost * 0.95); 
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    
    // Anti-Snipe: Add time if < 10s
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();
    
    io.emit('gameState', gameState);

    // 🚨 TELEGRAM ALERT: BID (Optional: Comment out if too spammy)
    // sendTelegram(`⚡ *New Bid*\nUser: ${email}\nJackpot: $${gameState.jackpot.toFixed(2)}`);
  });

  socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
      try {
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          const { error: updateError } = await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          if (updateError) throw updateError;

          const { error: insertError } = await supabase.from('withdrawals').insert([
              { user_email: email, amount, wallet_address: address, network, status: 'PENDING' }
          ]);
          
          if (insertError) {
              await supabase.from('users').update({ balance: u.balance }).eq('email', email);
              throw insertError; 
          }

          socket.emit('withdrawalSuccess', u.balance - amount);
          socket.emit('balanceUpdate', u.balance - amount);
          
          const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', w || []);

          // 🚨 TELEGRAM ALERT: WITHDRAWAL
          sendTelegram(`💸 *WITHDRAWAL REQUEST*\n\nUser: \`${email}\`\nAmount: *$${amount}*\nNet: ${network}\nAddr: \`${address}\``);

      } catch (e) {
          console.error("Withdraw Error:", e.message);
          socket.emit('withdrawalError', 'System Error. Try again.');
      }
  });

  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      try {
          console.log(`Verifying ${txHash} on ${network}...`);
          const provider = providers[network];
          if (!provider) { socket.emit('depositError', 'Invalid Network'); return; }

          const tx = await provider.waitForTransaction(txHash, 1, 10000); 
          if (!tx) { socket.emit('depositError', 'Tx not found yet. Wait.'); return; }
          
          const txDetails = await provider.getTransaction(txHash);
          if (txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { socket.emit('depositError', 'Wrong Receiver'); return; }

          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          const formatEther = ethers.utils ? ethers.utils.formatEther : ethers.formatEther;
          const amt = parseFloat(formatEther(txDetails.value));
          let rate = network === 'BSC' ? 600 : 3000; 
          const newBal = u.balance + (amt * rate);

          await supabase.from('users').update({ balance: newBal }).eq('email', email);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);

          // 🚨 TELEGRAM ALERT: DEPOSIT
          sendTelegram(`💰 *DEPOSIT CONFIRMED*\n\nUser: \`${email}\`\nAmount: $${(amt*rate).toFixed(2)}\nTx: [View](${network === 'BSC' ? 'https://bscscan.com/tx/' : 'https://etherscan.io/tx/'}${txHash})`);

      } catch (e) {
          console.error("Deposit Crash:", e);
          socket.emit('depositError', 'Verification Error. Check Explorer.');
      }
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') { gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 50.00, history: [], bidders: [] }; }
  });
  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

