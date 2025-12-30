// 1. Load Environment Variables at the very top
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');

// --- SECRETS FROM ENVIRONMENT VARIABLES ---
// These are no longer hardcoded. You must set them in Render/Netlify settings.
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co'; // This is public, can stay
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_WALLET = process.env.ADMIN_WALLET;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- TELEGRAM CONFIG ---
let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    // Only start bot if the token exists in environment variables
    if (TELEGRAM_TOKEN) {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("✅ Telegram Bot Active");
    } else {
        console.log("⚠️ Telegram Token missing in .env - Alerts disabled");
    }
} catch (e) {
    console.log("⚠️ Telegram disabled (Safe Mode)");
}

const app = express();
app.use(cors());

// --- SUPABASE SETUP ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- HELPER: TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// --- ROBUST PROVIDER SETUP ---
const getProvider = (networkKey) => {
    const urls = {
        BSC: [
          'https://bsc-dataseed1.binance.org/', 
          'https://bsc-dataseed.binance.org/', 
          'https://bsc-dataseed1.defibit.io/'
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

    const urlList = urls[networkKey];
    
    try {
        if (ethers.providers && ethers.providers.FallbackProvider) {
            const providers = urlList.map(u => new ethers.providers.JsonRpcProvider(u));
            return new ethers.providers.FallbackProvider(providers, 1);
        }
        if (ethers.JsonRpcProvider) return new ethers.JsonRpcProvider(urlList[0]);
        return new ethers.providers.JsonRpcProvider(urlList[0]);
    } catch (e) { 
        console.error(`Provider Error (${networkKey}):`, e.message);
        return null; 
    }
};

const providers = {
    BSC: getProvider('BSC'),
    ETH: getProvider('ETH'),
    BASE: getProvider('BASE')
};

const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000 
});

// 🛡️ SECURITY: Track User Cooldowns Server-Side
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

// --- GAME LOOP ---
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

          gameState.recentWinners.unshift({ user: win, amount: amt, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();

          sendTelegram(`🏆 *JACKPOT WON!*\nUser: ${win}\nAmount: $${amt.toFixed(2)}`);
      
      } else if (gameState.bidders.length === 1 && gameState.lastBidder) {
          const solePlayer = gameState.lastBidder;
          const refundAmount = gameState.userInvestments[solePlayer] || 0;

          if (refundAmount > 0) {
              const { data: u } = await supabase.from('users').select('balance').eq('email', solePlayer).single();
              if (u) {
                  await supabase.from('users').update({ balance: u.balance + refundAmount }).eq('email', solePlayer);
                  sendTelegram(`♻️ *REFUND*\nUser: ${solePlayer}\nAmt: $${refundAmount.toFixed(2)}`);
              }
          }
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState = { 
          ...gameState, 
          status: 'ACTIVE', 
          endTime: now + 300000, 
          jackpot: 0.00, 
          lastBidder: null, 
          history: [], 
          bidders: [], 
          userInvestments: {} 
      };
      lastBidTimes = {}; // Reset cooldowns
      io.emit('gameState', gameState);
    }
  }
  io.emit('gameState', gameState);
}, 1000);

io.on('connection', (socket) => {
  // --- 🛡️ STEP 3: ANTI-SPAM RATE LIMITER ---
  let messageCount = 0;
  // Reset counter every 1 second
  const rateLimitInterval = setInterval(() => { messageCount = 0; }, 1000);

  // Middleware to check every incoming message
  socket.use((packet, next) => {
      messageCount++;
      if (messageCount > 15) { // Limit: 15 messages per second
          socket.disconnect(true);
          console.log(`🚫 Kicked spammer: ${socket.id}`);
          clearInterval(rateLimitInterval);
          return; 
      }
      next();
  });

  // Clean up timer on disconnect
  socket.on('disconnect', () => { 
      clearInterval(rateLimitInterval);
      gameState.connectedUsers--; 
  });
  // ----------------------------------------

  gameState.connectedUsers++;

  // 🛡️ SECURITY RISK 3 FIX: Send Admin Wallet securely from ENV
  socket.on('getGameConfig', () => {
      socket.emit('gameConfig', { adminWallet: ADMIN_WALLET });
  });

  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email);
    let { data: u, error } = await supabase.from('users').select('balance').eq('email', email).single();
    
    if (!u || error) { 
        const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().single();
        u = newUser || { balance: 0.00 }; 
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

    // 🛡️ SERVER-SIDE COOLDOWN CHECK
    const now = Date.now();
    const lastBidTime = lastBidTimes[email] || 0;
    if (now - lastBidTime < 8000) { 
        socket.emit('bidError', '⏳ Cooldown Active! Please wait.');
        return;
    }

    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!u || u.balance < gameState.bidCost) { 
        socket.emit('bidError', 'Insufficient Funds'); 
        return; 
    }

    await supabase.from('users').update({ balance: u.balance - gameState.bidCost }).eq('email', email);
    socket.emit('balanceUpdate', u.balance - gameState.bidCost);

    lastBidTimes[email] = now;
    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;
    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    
    io.emit('gameState', gameState);
  });

  // --- 🛡️ SECURITY RISK 4 FIX: SECURE VERIFY DEPOSIT ---
  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      console.log(`[DEPOSIT START] ${email} - ${network} - ${txHash}`);
      
      try {
          const provider = providers[network];
          if (!provider) { socket.emit('depositError', 'Invalid Network Provider'); return; }

          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          if (!tx) { socket.emit('depositError', 'Verification Timed Out'); return; }

          const txDetails = await provider.getTransaction(txHash);
          if (!txDetails) { socket.emit('depositError', 'TX Details Missing'); return; }

          // Verify Recipient using ENV Variable
          if (txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { 
              socket.emit('depositError', 'Funds sent to wrong address'); 
              return; 
          }

          const formatEther = ethers.formatEther || ethers.utils.formatEther;
          const rawAmt = parseFloat(formatEther(txDetails.value));
          if (rawAmt <= 0) { socket.emit('depositError', 'Zero amount detected'); return; }

          let rate = network === 'BSC' ? 600 : 3000;
          const dollarAmount = rawAmt * rate;

          // Prevent Replay Attacks
          const { error: insertError } = await supabase.from('deposits').insert([{
              user_email: email,
              amount: dollarAmount,
              network: network,
              tx_hash: txHash, 
              status: 'COMPLETED'
          }]);

          if (insertError) {
              console.error("Replay Attack Detected or DB Error:", insertError);
              if (insertError.code === '23505') { 
                  socket.emit('depositError', 'Transaction already claimed!');
              } else {
                  socket.emit('depositError', 'Database Error. Contact Support.');
              }
              return; 
          }

          let { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u) {
              const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().single();
              u = newUser;
          }

          const newBal = u.balance + dollarAmount;
          await supabase.from('users').update({ balance: newBal }).eq('email', email);

          console.log(`[SUCCESS] Credited $${dollarAmount} to ${email}`);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);
          
          const { data: history } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('depositHistory', history || []);

          sendTelegram(`💰 *DEPOSIT SUCCESS*\nUser: ${email}\nAmt: $${dollarAmount.toFixed(2)}`);

      } catch (e) {
          console.error("[DEPOSIT CRASH]", e);
          socket.emit('depositError', 'Server Error. Check Logs.');
      }
  });

  socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
      try {
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          const { error } = await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          if (error) throw error;

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
     if (action === 'RESET') { 
         gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 50.00, history: [], bidders: [], userInvestments: {} }; 
         io.emit('gameState', gameState);
     }
  });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
