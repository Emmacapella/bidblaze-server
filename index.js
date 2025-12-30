const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');

// --- TELEGRAM CONFIG ---
const TELEGRAM_TOKEN = '8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI';
const TELEGRAM_CHAT_ID = '6571047127';

let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("✅ Telegram Bot Active");
    }
} catch (e) {
    console.log("⚠️ Telegram disabled");
}

const app = express();
app.use(cors());

// --- SUPABASE & WALLET ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c";

const sendTelegram = (msg) => { if(bot) bot.sendMessage(TELEGRAM_CHAT_ID, msg, {parse_mode:'Markdown'}).catch(()=>{}); };

// --- PROVIDER SETUP ---
const getProvider = (key) => {
    const urls = {
        BSC: ['https://bsc-dataseed1.binance.org/', 'https://bsc-dataseed.binance.org/'],
        ETH: ['https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
        BASE: ['https://mainnet.base.org', 'https://1rpc.io/base']
    };
    try {
        if (ethers.JsonRpcProvider) return new ethers.JsonRpcProvider(urls[key][0]);
        return new ethers.providers.JsonRpcProvider(urls[key][0]);
    } catch (e) { return null; }
};
const providers = { BSC: getProvider('BSC'), ETH: getProvider('ETH'), BASE: getProvider('BASE') };

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, pingTimeout: 60000 });

// 🛡️ SECURITY: Track Cooldowns Here
let lastBidTimes = {}; 

let gameState = { 
    status: 'ACTIVE', 
    endTime: Date.now() + 300000, 
    jackpot: 0.00, 
    bidCost: 1.00, 
    lastBidder: null, 
    history: [], 
    recentWinners: [], 
    connectedUsers: 0, 
    restartTimer: null, 
    bidders: [], 
    userInvestments: {} 
};

// GAME LOOP
setInterval(async () => {
  const now = Date.now();
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED'; 
      gameState.restartTimer = now + 15000;

      if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const win = gameState.lastBidder;
          const amt = gameState.jackpot;
          const { data: u } = await supabase.from('users').select('balance').eq('email', win).single();
          if (u) await supabase.from('users').update({ balance: u.balance + amt }).eq('email', win);
          gameState.recentWinners.unshift({ user: win, amount: amt });
          sendTelegram(`🏆 *JACKPOT WON!* $${amt.toFixed(2)} by ${win}`);
      } else if (gameState.bidders.length === 1 && gameState.lastBidder) {
          const sole = gameState.lastBidder;
          const ref = gameState.userInvestments[sole] || 0;
          if (ref > 0) {
              const { data: u } = await supabase.from('users').select('balance').eq('email', sole).single();
              if (u) await supabase.from('users').update({ balance: u.balance + ref }).eq('email', sole);
              sendTelegram(`♻️ *REFUND* $${ref.toFixed(2)} to ${sole}`);
          }
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
       // Reset Game & Clear Cooldowns
       gameState = { ...gameState, status: 'ACTIVE', endTime: now+300000, jackpot: 0.00, lastBidder: null, history: [], bidders: [], userInvestments: {} };
       lastBidTimes = {}; // Clear cooldowns for new round
       io.emit('gameState', gameState);
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
    if (!u) { 
        const { data: nu } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().single();
        u = nu || { balance: 0.00 }; 
    }
    socket.emit('balanceUpdate', u.balance);
    
    try {
        const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('withdrawalHistory', w || []);
    } catch(e) {}

    try {
        const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('depositHistory', d || []);
    } catch(e) {}
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;

    // 🛡️ SECURITY CHECK 1: COOLDOWN ENFORCEMENT
    const now = Date.now();
    const lastBidTime = lastBidTimes[email] || 0;
    if (now - lastBidTime < 8000) { // 8000ms = 8 seconds
        socket.emit('bidError', '⏳ Cooldown Active! Please wait.');
        return;
    }

    // 🛡️ SECURITY CHECK 2: BALANCE CHECK
    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!u || u.balance < gameState.bidCost) { 
        socket.emit('bidError', 'Insufficient Funds'); 
        return; 
    }

    // Apply Bid
    await supabase.from('users').update({ balance: u.balance - gameState.bidCost }).eq('email', email);
    socket.emit('balanceUpdate', u.balance - gameState.bidCost);
    
    // Update State
    lastBidTimes[email] = now; // Set new cooldown
    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;
    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    io.emit('gameState', gameState);
  });

  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      console.log(`[DEPOSIT] Checking ${txHash} (${network}) for ${email}`);
      try {
          const provider = providers[network];
          if(!provider) { socket.emit('depositError', 'Invalid Network'); return; }

          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          if(!tx) { socket.emit('depositError', 'Timeout. Contact Support.'); return; }

          const txData = await provider.getTransaction(txHash);
          if(txData.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { 
              socket.emit('depositError', 'Wrong Receiver Wallet'); 
              return; 
          }

          const fmt = ethers.formatEther || ethers.utils.formatEther;
          const amt = parseFloat(fmt(txData.value));
          if(amt <= 0) { socket.emit('depositError', 'Zero Amount'); return; }

          const rate = network === 'BSC' ? 600 : 3000;
          const usd = amt * rate;

          let { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if(!u) {
              const { data: nu } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().single();
              u = nu;
          }
          const newBal = u.balance + usd;
          await supabase.from('users').update({ balance: newBal }).eq('email', email);

          await supabase.from('deposits').insert([{
              user_email: email,
              amount: usd,
              network: network,
              tx_hash: txHash,
              status: 'COMPLETED'
          }]);

          console.log(`[SUCCESS] Deposited $${usd} to ${email}`);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);
          
          const { data: history } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('depositHistory', history || []);

          sendTelegram(`💰 *DEPOSIT ($${usd.toFixed(2)})*\nUser: ${email}\nTx: ${txHash}`);

      } catch (e) {
          console.error("Deposit Error:", e);
          socket.emit('depositError', 'System Error. Check Logs.');
      }
  });

  socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
      try {
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          await supabase.from('withdrawals').insert([{ user_email: email, amount, wallet_address: address, network, status: 'PENDING' }]);
          
          socket.emit('withdrawalSuccess', u.balance - amount);
          socket.emit('balanceUpdate', u.balance - amount);
          
          const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', w || []);

          sendTelegram(`💸 *WITHDRAWAL*\nUser: ${email}\nAmt: $${amount}`);
      } catch (e) {
          socket.emit('withdrawalError', 'Withdrawal Failed');
      }
  });

  socket.on('adminAction', ({ password, action, value }) => {
      if(action === 'RESET') { 
          gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now()+300000 };
          io.emit('gameState', gameState);
      }
  });
  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server on ${PORT}`));

