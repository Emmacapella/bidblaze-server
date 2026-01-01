// 1. Load Environment Variables
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');

// --- CONFIGURATION ---
// ⚠️ If .env is missing, these default strings prevent immediate crashes
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'MISSING_KEY';
const ADMIN_WALLET = process.env.ADMIN_WALLET || '0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// --- TELEGRAM CONFIG ---
let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN) {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("✅ Telegram Bot Active");
    } else {
        console.log("⚠️ Telegram Token missing - Alerts disabled");
    }
} catch (e) {
    console.log("⚠️ Telegram disabled (Tool missing)");
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

    const urlList = urls[networkKey];

    try {
        // Try to use Ethers v5 FallbackProvider if available
        if (ethers.providers && ethers.providers.FallbackProvider) {
            const providers = urlList.map(u => new ethers.providers.JsonRpcProvider(u));
            return new ethers.providers.FallbackProvider(providers, 1);
        }
        // Fallback to simple provider (v6 or v5)
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

          const { data: u } = await supabase.from('users').select('balance').eq('email', win).maybeSingle();
          if (u) await supabase.from('users').update({ balance: u.balance + amt }).eq('email', win);

          gameState.recentWinners.unshift({ user: win, amount: amt, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();

          sendTelegram(`🏆 *JACKPOT WON!*\nUser: \`${win}\`\nAmount: $${amt.toFixed(2)}`);

      } else if (gameState.bidders.length === 1 && gameState.lastBidder) {
          const solePlayer = gameState.lastBidder;
          const refundAmount = gameState.userInvestments[solePlayer] || 0;

          if (refundAmount > 0) {
              const { data: u } = await supabase.from('users').select('balance').eq('email', solePlayer).maybeSingle();
              if (u) {
                  await supabase.from('users').update({ balance: u.balance + refundAmount }).eq('email', solePlayer);
                  sendTelegram(`♻️ *REFUND*\nUser: \`${solePlayer}\`\nAmt: $${refundAmount.toFixed(2)}`);
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
  // --- 🛡️ ANTI-SPAM RATE LIMITER ---
  let messageCount = 0;
  const rateLimitInterval = setInterval(() => { messageCount = 0; }, 1000);

  socket.use((packet, next) => {
      messageCount++;
      if (messageCount > 20) { // Increased slightly to prevent accidental kicks
          socket.disconnect(true);
          console.log(`🚫 Kicked spammer: ${socket.id}`);
          clearInterval(rateLimitInterval);
          return;
      }
      next();
  });

  socket.on('disconnect', () => {
      clearInterval(rateLimitInterval);
      gameState.connectedUsers--;
  });
  // ----------------------------------------

  gameState.connectedUsers++;

  socket.on('getGameConfig', () => {
      socket.emit('gameConfig', { adminWallet: ADMIN_WALLET });
  });

  // --- USER BALANCE LOGIC ---
  socket.on('getUserBalance', async (rawEmail) => {
    if (!rawEmail) return;
    const email = rawEmail.toLowerCase().trim(); // ⚠️ FIX: Normalize email case
    socket.join(email);

    // ⚠️ CRITICAL FIX: Use maybeSingle() to handle missing users without crashing
    let { data: u, error } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();

    if (!u) {
        console.log(`Creating new user: ${email}`);
        const { data: newUser, error: insertError } = await supabase
            .from('users')
            .insert([{ email, balance: 0.00 }])
            .select()
            .maybeSingle();

        if (insertError) {
            console.error("DB Insert Error:", insertError.message);
            // Fallback object so app doesn't crash
            u = { balance: 0.00 };
        } else {
            u = newUser;
        }
    }

    socket.emit('balanceUpdate', u ? u.balance : 0.00);

    // Fetch History (Safely)
    try {
        const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('withdrawalHistory', w || []);
    } catch(e) { socket.emit('withdrawalHistory', []); }

    try {
        // If deposits table doesn't exist yet, this might fail, so we catch it
        const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('depositHistory', d || []);
    } catch(e) {}
  });

  // --- BID LOGIC ---
  socket.on('placeBid', async (rawEmail) => {
    if (gameState.status !== 'ACTIVE') return;
    const email = rawEmail.toLowerCase().trim(); // ⚠️ FIX: Normalize email case

    // Server-Side Cooldown
    const now = Date.now();
    const lastBidTime = lastBidTimes[email] || 0;
    if (now - lastBidTime < 500) { // 0.5s absolute minimum between bids
        return; // Silent ignore for spam
    }

    const { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
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

    // Anti-Snipe: Add time if < 10s
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;

    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();

    io.emit('gameState', gameState);
  });

  // --- DEPOSIT LOGIC ---
  socket.on('verifyDeposit', async ({ email: rawEmail, txHash, network }) => {
      const email = rawEmail.toLowerCase().trim(); // ⚠️ FIX: Normalize email case
      console.log(`[DEPOSIT START] ${email} - ${network} - ${txHash}`);

      try {
          const provider = providers[network];
          if (!provider) { socket.emit('depositError', 'Invalid Network Provider'); return; }

          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          if (!tx) { socket.emit('depositError', 'Verification Timed Out or TX not found'); return; }

          const txDetails = await provider.getTransaction(txHash);
          if (!txDetails) { socket.emit('depositError', 'TX Details Missing'); return; }

          // Verify Recipient safely
          if (!ADMIN_WALLET || txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
              socket.emit('depositError', 'Funds sent to wrong address');
              return;
          }

          const formatEther = ethers.formatEther || ethers.utils.formatEther;
          const rawAmt = parseFloat(formatEther(txDetails.value));
          if (rawAmt <= 0) { socket.emit('depositError', 'Zero amount detected'); return; }

          let rate = network === 'BSC' ? 600 : 3000;
          const dollarAmount = rawAmt * rate;

          // Prevent Replay Attacks via DB
          const { error: insertError } = await supabase.from('deposits').insert([{
              user_email: email,
              amount: dollarAmount,
              network: network,
              tx_hash: txHash,
              status: 'COMPLETED'
          }]);

          if (insertError) {
              // Duplicate error code check (Postgres specific)
              if (insertError.code === '23505') {
                  socket.emit('depositError', 'Transaction already claimed!');
              } else {
                  console.error("DB Error:", insertError);
                  socket.emit('depositError', 'Database Error. Check support.');
              }
              return;
          }

          let { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
          if (!u) {
              const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().maybeSingle();
              u = newUser;
          }

          const newBal = u.balance + dollarAmount;
          await supabase.from('users').update({ balance: newBal }).eq('email', email);

          console.log(`[SUCCESS] Credited $${dollarAmount} to ${email}`);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);

          sendTelegram(`💰 *DEPOSIT SUCCESS*\nUser: \`${email}\`\nAmt: $${dollarAmount.toFixed(2)}`);

      } catch (e) {
          console.error("[DEPOSIT CRASH]", e);
          socket.emit('depositError', 'Server Error during verification.');
      }
  });

  // --- WITHDRAWAL LOGIC ---
  socket.on('requestWithdrawal', async ({ email: rawEmail, amount, address, network }) => {
      try {
          const email = rawEmail.toLowerCase().trim(); // ⚠️ FIX: Normalize email case
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          const { error: updateError } = await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          if (updateError) throw updateError;

          // Save to DB
          const { error: insertError } = await supabase.from('withdrawals').insert([{
              user_email: email,
              amount,
              wallet_address: address,
              network,
              status: 'PENDING'
          }]);

          if (insertError) {
              // Rollback balance if DB save fails
              await supabase.from('users').update({ balance: u.balance }).eq('email', email);
              throw insertError;
          }

          socket.emit('withdrawalSuccess', u.balance - amount);
          socket.emit('balanceUpdate', u.balance - amount);

          const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', w || []);

          sendTelegram(`💸 *WITHDRAWAL*\nUser: \`${email}\`\nAmt: $${amount}\nAddr: \`${address}\``);
      } catch (e) {
          console.error("Withdraw Error:", e);
          socket.emit('withdrawalError', 'Withdrawal System Error');
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
