const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');

// --- TELEGRAM CONFIG ---
const TELEGRAM_TOKEN = 'YOUR_TELEGRAM_BOT_TOKEN';
const TELEGRAM_CHAT_ID = 'YOUR_CHAT_ID';

let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN && TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_BOT_TOKEN') {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("✅ Telegram Bot Active");
    }
} catch (e) {
    console.log("⚠️ Telegram disabled (Safe Mode)");
}

const app = express();
app.use(cors());

// --- SUPABASE & WALLET ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 🛡️ SECURITY RISK 3 SOLUTION:
// The Admin Wallet is defined ONLY here on the secure server.
// It is never exposed in the public frontend code until the app requests it.
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c";

// --- HELPER: TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// --- ROBUST PROVIDER SETUP (Ethers v5/v6 Compatible) ---
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
        // Try FallbackProvider (Best for redundancy)
        if (ethers.providers && ethers.providers.FallbackProvider) {
            const providers = urlList.map(u => new ethers.providers.JsonRpcProvider(u));
            return new ethers.providers.FallbackProvider(providers, 1);
        }
        // Fallback for simple provider (v6 or simplified v5)
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
    jackpot: 100.00, 
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
          jackpot: 50.00, 
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
  gameState.connectedUsers++;

  // 🛡️ SECURITY RISK 3 FIX:
  // Securely transmit the Admin Wallet to the frontend ONLY when requested.
  // This prevents crawlers/scrapers from finding your wallet in the source code.
  socket.on('getGameConfig', () => {
      socket.emit('gameConfig', { adminWallet: ADMIN_WALLET });
  });

  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email);
    let { data: u, error } = await supabase.from('users').select('balance').eq('email', email).single();
    
    // Auto-create user if missing
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

    // Update State
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

          // 1. Verify on Blockchain (The Truth Source)
          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          if (!tx) { socket.emit('depositError', 'Verification Timed Out'); return; }

          const txDetails = await provider.getTransaction(txHash);
          if (!txDetails) { socket.emit('depositError', 'TX Details Missing'); return; }

          // 2. Verify Recipient
          if (txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { 
              socket.emit('depositError', 'Funds sent to wrong address'); 
              return; 
          }

          // 3. Calculate Amount Strictly from Blockchain (Ignore Client)
          const formatEther = ethers.formatEther || ethers.utils.formatEther;
          const rawAmt = parseFloat(formatEther(txDetails.value));
          if (rawAmt <= 0) { socket.emit('depositError', 'Zero amount detected'); return; }

          let rate = network === 'BSC' ? 600 : 3000;
          const dollarAmount = rawAmt * rate;

          // 4. PREVENT REPLAY ATTACKS (Risk 4 Solution)
          // We attempt to insert the transaction into the database FIRST.
          // Since `tx_hash` is UNIQUE in the schema, this will FAIL if the user tries to use the same hash twice.
          const { error: insertError } = await supabase.from('deposits').insert([{
              user_email: email,
              amount: dollarAmount,
              network: network,
              tx_hash: txHash, // UNIQUE CONSTRAINT
              status: 'COMPLETED'
          }]);

          if (insertError) {
              console.error("Replay Attack Detected or DB Error:", insertError);
              // If it's a constraint error, it means the TX was already used.
              if (insertError.code === '23505') { 
                  socket.emit('depositError', 'Transaction already claimed!');
              } else {
                  socket.emit('depositError', 'Database Error. Contact Support.');
              }
              return; // STOP HERE. Do not credit balance.
          }

          // 5. Update User Balance (Only if insert succeeded)
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
          
          // Refresh History
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

  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
