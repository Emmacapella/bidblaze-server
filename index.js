const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');

// --- TELEGRAM CONFIG (SAFE MODE) ---
const TELEGRAM_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_CHAT_ID';

let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("✅ Telegram Bot Active");
    } else {
        console.log("⚠️ Telegram Token missing - Alerts disabled (Server Running Safe Mode)");
    }
} catch (err) {
    console.log("⚠️ Telegram tool not installed - Alerts disabled (Server Running Safe Mode)");
}

const app = express();
app.use(cors());

// --- SUPABASE & WALLET ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c";

// --- HELPER: SAFE TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// --- ROBUST PROVIDER SETUP (WITH ROTATION) ---
// This prevents "Tx not found" when one RPC node is busy
const getProvider = (networkKey) => {
    const urls = {
        BSC: [
          'https://bsc-dataseed.binance.org/', 
          'https://bsc-dataseed1.defibit.io/', 
          'https://bsc-dataseed1.ninicoin.io/'
        ],
        ETH: [
          'https://cloudflare-eth.com', 
          'https://rpc.ankr.com/eth'
        ],
        BASE: [
          'https://mainnet.base.org', 
          'https://1rpc.io/base'
        ]
    };

    try {
        // Safe check for Ethers v5 FallbackProvider
        if (ethers.providers && ethers.providers.FallbackProvider) {
            const providers = urls[networkKey].map(u => new ethers.providers.JsonRpcProvider(u));
            return new ethers.providers.FallbackProvider(providers, 1);
        }
        // Fallback for simple provider
        return new ethers.providers.JsonRpcProvider(urls[networkKey][0]);
    } catch (e) { return null; }
};

const providers = {
    BSC: getProvider('BSC'),
    ETH: getProvider('ETH'),
    BASE: getProvider('BASE')
};

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

let gameState = { 
    status: 'ACTIVE', 
    endTime: Date.now() + 300000, 
    jackpot: 100.00, 
    bidCost: 1.00, 
    lastBidder: null, 
    history: [], 
    recentWinners: [], 
    connectedUsers: 0, 
    restartTimer: null, 
    bidders: [], 
    userInvestments: {} // ⚠️ Tracks how much each user spent for refunds
};

// GAME LOOP
setInterval(async () => {
  const now = Date.now();
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED'; 
      gameState.restartTimer = now + 15000;

      // --- WIN CONDITION (>1 Player) ---
      if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const win = gameState.lastBidder;
          const amt = gameState.jackpot;

          const { data: u } = await supabase.from('users').select('balance').eq('email', win).single();
          if (u) await supabase.from('users').update({ balance: u.balance + amt }).eq('email', win);

          gameState.recentWinners.unshift({ user: win, amount: amt, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();

          sendTelegram(`🏆 *JACKPOT WON!*\n\n👤 User: \`${win}\`\n💰 Amount: *$${amt.toFixed(2)}*\n🔥 The game is restarting!`);
      
      // --- REFUND CONDITION (1 Player) ---
      } else if (gameState.bidders.length === 1 && gameState.lastBidder) {
          const solePlayer = gameState.lastBidder;
          const refundAmount = gameState.userInvestments[solePlayer] || 0;

          if (refundAmount > 0) {
              const { data: u } = await supabase.from('users').select('balance').eq('email', solePlayer).single();
              if (u) {
                  await supabase.from('users').update({ balance: u.balance + refundAmount }).eq('email', solePlayer);
                  sendTelegram(`♻️ *REFUND ISSUED*\n\n👤 User: \`${solePlayer}\`\n💰 Refunded: *$${refundAmount.toFixed(2)}*\n⚠️ Reason: No opponents found.`);
              }
          }
      } else {
          sendTelegram(`⚠️ *GAME ENDED*\nNo participants.`);
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE'; 
      gameState.endTime = now + 300000; 
      gameState.jackpot = 50.00; 
      gameState.lastBidder = null; 
      gameState.history = []; 
      gameState.bidders = []; 
      gameState.userInvestments = {}; 
      
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

    try {
        const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('withdrawalHistory', w || []);
    } catch(e) { socket.emit('withdrawalHistory', []); }
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!u || u.balance < gameState.bidCost) { socket.emit('bidError', 'Insufficient Funds'); return; }

    await supabase.from('users').update({ balance: u.balance - gameState.bidCost }).eq('email', email);
    socket.emit('balanceUpdate', u.balance - gameState.bidCost);

    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;

    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);

    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;

    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();

    io.emit('gameState', gameState);
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
          sendTelegram(`💸 *WITHDRAWAL REQUEST*\n\nUser: \`${email}\`\nAmount: *$${amount}*\nNet: ${network}\nAddr: \`${address}\``);

      } catch (e) {
          console.error("Withdraw Error:", e.message);
          socket.emit('withdrawalError', 'System Error: ' + e.message);
      }
  });

  // --- UPDATED VERIFY DEPOSIT: 60s TIMEOUT ---
  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      try {
          console.log(`Verifying ${txHash} on ${network}...`);
          const provider = providers[network];
          if (!provider) { socket.emit('depositError', 'Invalid Network'); return; }

          // Wait up to 60 seconds
          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          
          if (!tx) { 
              socket.emit('depositError', 'Verification timed out. Contact Admin.'); 
              return; 
          }

          const txDetails = await provider.getTransaction(txHash);
          
          // Case-insensitive check
          if (txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { 
              socket.emit('depositError', 'Wrong Receiver'); 
              return; 
          }

          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          const formatEther = ethers.utils ? ethers.utils.formatEther : ethers.formatEther;
          const amt = parseFloat(formatEther(txDetails.value));
          let rate = network === 'BSC' ? 600 : 3000;
          const newBal = u.balance + (amt * rate);

          await supabase.from('users').update({ balance: newBal }).eq('email', email);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);

          sendTelegram(`💰 *DEPOSIT CONFIRMED*\n\nUser: \`${email}\`\nAmount: $${(amt*rate).toFixed(2)}\nTx: ${txHash}`);

      } catch (e) {
          console.error("Deposit Crash:", e);
          socket.emit('depositError', 'Verification Error. Check Explorer.');
      }
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') { gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 50.00, history: [], bidders: [], userInvestments: {} }; }
  });
  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

