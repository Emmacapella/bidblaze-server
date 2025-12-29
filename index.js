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
    console.log("⚠️ Telegram disabled (Safe Mode)");
}

const app = express();
app.use(cors());

// --- SUPABASE CONFIG ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
// ⚠️ IMPORTANT: Ensure this is your SERVICE_ROLE_KEY if RLS is enabled, or disable RLS in Supabase.
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const ADMIN_WALLET = "0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c";

// --- HELPER: TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// --- UNIVERSAL PROVIDER SETUP (Fixes v5/v6 Crash) ---
const getProvider = (networkKey) => {
    const urls = {
        BSC: ['https://bsc-dataseed1.binance.org/', 'https://bsc-dataseed.binance.org/'],
        ETH: ['https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
        BASE: ['https://mainnet.base.org', 'https://1rpc.io/base']
    };

    const url = urls[networkKey][0];

    try {
        // Try Ethers v6 Syntax
        if (ethers.JsonRpcProvider) {
            return new ethers.JsonRpcProvider(url);
        }
        // Try Ethers v5 Syntax
        if (ethers.providers && ethers.providers.JsonRpcProvider) {
            return new ethers.providers.JsonRpcProvider(url);
        }
        return null;
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
}, 1000);

io.on('connection', (socket) => {
  gameState.connectedUsers++;

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
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    
    if (!u || u.balance < gameState.bidCost) { 
        socket.emit('bidError', 'Insufficient Funds'); 
        return; 
    }

    await supabase.from('users').update({ balance: u.balance - gameState.bidCost }).eq('email', email);
    socket.emit('balanceUpdate', u.balance - gameState.bidCost);

    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;
    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    
    io.emit('gameState', gameState);
  });

  // --- CRITICAL FIX: VERIFY DEPOSIT WITH LOGS ---
  socket.on('verifyDeposit', async ({ email, txHash, network }) => {
      console.log(`[DEPOSIT START] ${email} - ${network} - ${txHash}`);
      
      try {
          const provider = providers[network];
          if (!provider) {
              console.log("[DEPOSIT ERROR] No Provider found for " + network);
              socket.emit('depositError', 'Invalid Network Provider');
              return;
          }

          // 1. Wait for Transaction
          console.log("[DEPOSIT] Waiting for TX...");
          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          
          if (!tx) { 
              console.log("[DEPOSIT FAIL] Timeout waiting for TX");
              socket.emit('depositError', 'Verification Timed Out'); 
              return; 
          }

          // 2. Get Transaction Details
          const txDetails = await provider.getTransaction(txHash);
          if (!txDetails) {
              socket.emit('depositError', 'TX Details Missing');
              return;
          }

          // 3. Verify Receiver
          if (txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { 
              console.log(`[DEPOSIT FAIL] Wrong Wallet. Sent to: ${txDetails.to}`);
              socket.emit('depositError', 'Funds sent to wrong address'); 
              return; 
          }

          // 4. Calculate Amount
          const formatEther = ethers.formatEther || ethers.utils.formatEther; // Handle v5/v6
          const rawAmt = parseFloat(formatEther(txDetails.value));
          
          if (rawAmt <= 0) {
              socket.emit('depositError', 'Zero amount detected');
              return;
          }

          let rate = network === 'BSC' ? 600 : 3000;
          const dollarAmount = rawAmt * rate;

          console.log(`[DEPOSIT] Found $${dollarAmount} (${rawAmt} ${network})`);

          // 5. Update Database
          let { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u) {
              // Create user if they don't exist yet
              const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().single();
              u = newUser;
          }

          const newBal = u.balance + dollarAmount;
          
          const { error } = await supabase.from('users').update({ balance: newBal }).eq('email', email);

          if (error) {
              console.error("[DB ERROR] Supabase Update Failed:", error.message);
              socket.emit('depositError', 'Database Error: ' + error.message);
          } else {
              console.log(`[SUCCESS] Balance updated to $${newBal}`);
              socket.emit('depositSuccess', newBal);
              socket.emit('balanceUpdate', newBal);
              sendTelegram(`💰 *DEPOSIT SUCCESS*\nUser: ${email}\nAmt: $${dollarAmount.toFixed(2)}`);
          }

      } catch (e) {
          console.error("[DEPOSIT CRASH]", e);
          socket.emit('depositError', 'Server Error. Check Logs.');
      }
  });

  socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
      // Withdrawal logic remains the same (verified working)
      try {
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          const { error } = await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          if (error) throw error;

          await supabase.from('withdrawals').insert([{ user_email: email, amount, wallet_address: address, network, status: 'PENDING' }]);
          
          socket.emit('withdrawalSuccess', u.balance - amount);
          socket.emit('balanceUpdate', u.balance - amount);
          sendTelegram(`💸 *WITHDRAWAL*\nUser: ${email}\nAmt: $${amount}`);
      } catch (e) {
          socket.emit('withdrawalError', 'Withdrawal Failed');
      }
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') { 
         gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 0.00, history: [], bidders: [], userInvestments: {} }; 
         io.emit('gameState', gameState);
     }
  });

  socket.on('disconnect', () => { gameState.connectedUsers--; });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));

