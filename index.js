const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

// --- 🏦 BANK CONFIGURATION (SUPABASE) ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; // Your Secret Key
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 🔐 SETTINGS ---
const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;       // Cost per bid
const JACKPOT_SHARE = 0.70; // 70% to Winner
const HOUSE_SHARE = 0.30;   // 30% to You

// GLOBAL SECURITY VARS
let globalFailures = 0;
let adminLockedUntil = 0;

// Local State (Syncs with DB)
let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,
  bidCost: BID_FEE,
  endTime: Date.now() + 299000, // 299 Seconds
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  restartTimer: 0
};

// --- 🔄 SYNC WITH DATABASE ---
async function loadGameFromDB() {
    // Try to find the game state row (ID=1)
    const { data, error } = await supabase.from('game_state').select('*').eq('id', 1).single();
    
    if (data) {
        gameState.jackpot = data.jackpot;
        gameState.houseBalance = data.house_balance;
        console.log(`✅ BANK LOADED: Jackpot=$${gameState.jackpot}, Profit=$${gameState.houseBalance}`);
    } else {
        // If missing, create it
        console.log("⚠️ No DB record found. Creating first entry...");
        await supabase.from('game_state').insert([{ id: 1, jackpot: 0.00, house_balance: 0.00, end_time: 0 }]);
    }
}
loadGameFromDB(); // Run on startup

async function saveGameToDB() {
    await supabase.from('game_state').update({
        jackpot: gameState.jackpot,
        house_balance: gameState.houseBalance
    }).eq('id', 1);
}

// --- 🎮 GAME LOOP ---
io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  // --- 1. GET USER BALANCE ---
  socket.on('getUserBalance', async (email) => {
      if (!email) return;
      const { data } = await supabase.from('users').select('balance').eq('email', email).single();
      if (data) {
          socket.emit('balanceUpdate', data.balance);
      } else {
          // Create account if new
          await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
          socket.emit('balanceUpdate', 0.00);
      }
  });

  // --- 2. DEPOSIT HANDLER (Client says "I paid") ---
  socket.on('confirmDeposit', async (data) => {
      const { email, amount, txHash } = data;
      console.log(`Processing deposit: $${amount} for ${email}`);
      
      // A. Prevent Replay Attack (Check if TxHash used)
      const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
      if (existing) {
          console.log("⚠️ Duplicate transaction attempt detected.");
          return;
      }

      // B. Record Deposit
      await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: parseFloat(amount) }]);

      // C. Credit User Balance
      const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
      const newBalance = (user ? user.balance : 0) + parseFloat(amount);
      
      await supabase.from('users').update({ balance: newBalance }).eq('email', email);
      
      // D. Notify User
      socket.emit('balanceUpdate', newBalance);
      console.log(`✅ Deposit Success! New Balance: $${newBalance}`);
  });

  // --- 3. PLACE BID (The Money Maker) ---
  socket.on('placeBid', async (userEmail) => {
    if (gameState.status === 'ENDED') return;
    if (!userEmail) return;

    // A. Check Balance
    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    
    // Safety check: Does user exist and have money?
    if (!user || user.balance < BID_FEE) {
        socket.emit('bidError', 'Insufficient Balance! Please Deposit.');
        return; // STOP HERE if broke
    }

    // B. Deduct Money from User
    const newBalance = user.balance - BID_FEE;
    await supabase.from('users').update({ balance: newBalance }).eq('email', userEmail);
    socket.emit('balanceUpdate', newBalance); // Update phone display immediately

    // C. Split the Profit & Update Game
    gameState.jackpot += JACKPOT_SHARE;      // +$0.70 to Jackpot
    gameState.houseBalance += HOUSE_SHARE;    // +$0.30 to You
    
    saveGameToDB(); // Save to Bank immediately

    // D. Update History
    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail
    };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 30);
    gameState.lastBidder = userEmail;

    // E. Smart Timer (5 Second Rule)
    const now = Date.now();
    if ((gameState.endTime - now) / 1000 < 5) {
        gameState.endTime = now + 10000; 
    }

    io.emit('gameState', gameState);
  });

  // --- 4. 🔐 ADMIN PANEL HANDLER ---
  socket.on('adminAction', (data) => {
    const { password, action, value } = data;
    const now = Date.now();

    // Check Lockout
    if (now < adminLockedUntil) return; 

    // Check Password
    if (password !== ADMIN_PASSWORD) {
        globalFailures++;
        if (globalFailures >= 3) {
            adminLockedUntil = now + (10 * 60 * 60 * 1000); // 10 Hour Lock
            globalFailures = 0;
            console.log("🚨 ADMIN LOCKED FOR 10 HOURS");
        }
        return;
    }
    globalFailures = 0; // Reset fails on success

    // Action: RESET GAME
    if (action === 'RESET') {
        gameState.jackpot = 0.00;      
        gameState.endTime = Date.now() + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        gameState.restartTimer = 0;
        saveGameToDB(); 
        io.emit('gameState', gameState);
    }
    
    // Action: SET JACKPOT
    if (action === 'SET_JACKPOT') {
        gameState.jackpot = parseFloat(value);
        saveGameToDB();
        io.emit('gameState', gameState);
    }

    // Action: ADD TIME
    if (action === 'ADD_TIME') {
        gameState.endTime = Date.now() + (parseInt(value) * 1000);
        gameState.status = 'ACTIVE';
        io.emit('gameState', gameState);
    }

    // Action: CHECK PROFIT
    if (action === 'CHECK_PROFIT') {
        console.log(`💰 REAL PROFIT IN BANK: $${gameState.houseBalance.toFixed(2)}`);
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- AUTO-RESTART LOOP (15 Seconds) ---
setInterval(() => {
    const now = Date.now();

    // 1. End Game if Time is Up
    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now;
        gameState.restartTimer = now + 15000; // 15s Break
        io.emit('gameState', gameState);
    }

    // 2. Restart Game after Break
    if (gameState.status === 'ENDED' && now > gameState.restartTimer) {
        gameState.jackpot = 0.00;        
        gameState.endTime = now + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        gameState.restartTimer = 0;
        
        saveGameToDB(); // Reset DB state
        console.log("🔄 Game Auto-Restarted!");
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => {
  console.log('BUSINESS SERVER RUNNING ON 3001 🚀');
});

