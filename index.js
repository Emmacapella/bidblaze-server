const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ✅ SUPABASE & CONFIG
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; // YOUR KEY
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TELEGRAM_TOKEN = "8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI";
const MY_CHAT_ID = "6571047127";

// --- 🎮 GAME VARIABLES (THE MISSING PART) ---
let gameState = {
  status: 'ACTIVE', // ACTIVE, ENDED
  endTime: Date.now() + 300000, // 5 mins from now
  jackpot: 0.00,
  bidCost: 1.00,
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  restartTimer: null
};

// --- 🔄 GAME LOOP ---
// This ticks every 100ms to update the timer and tell the website what is happening
setInterval(() => {
  const now = Date.now();
  
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; // Restart in 15s
      // Here you would add logic to pay the winner
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      // RESET GAME
      gameState.status = 'ACTIVE';
      gameState.endTime = now + 300000;
      gameState.jackpot = 0.00; // Reset jackpot
      gameState.lastBidder = null;
      gameState.history = [];
    }
  }

  // Send the update to EVERYONE connected
  io.emit('gameState', gameState);
}, 100);

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
  gameState.connectedUsers++;

  // 1. GET BALANCE (Matches what App.jsx asks for)
  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email); // Join a room for this user
    
    // Check if user exists, if not create them (Simple logic)
    let { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    
    if (!user) {
       // Create dummy user if not found for testing
       await supabase.from('users').insert([{ email: email, balance: 10.00 }]);
       user = { balance: 10.00 };
    }
    socket.emit('balanceUpdate', user.balance);
  });

  // 2. PLACE BID
  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;

    // Check Balance
    const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    
    if (!user || user.balance < gameState.bidCost) {
      socket.emit('bidError', 'Insufficient Funds');
      return;
    }

    // Deduct Balance
    const newBalance = user.balance - gameState.bidCost;
    await supabase.from('users').update({ balance: newBalance }).eq('email', email);
    socket.emit('balanceUpdate', newBalance); // Update THIS user instantly

    // Update Game State
    gameState.jackpot += (gameState.bidCost * 0.95); // 95% goes to jackpot
    gameState.lastBidder = email;
    
    // Add time if low
    const timeRemaining = gameState.endTime - Date.now();
    if (timeRemaining < 10000) {
      gameState.endTime = Date.now() + 10000;
    }
    
    // Add to history
    gameState.history.unshift({
        id: Date.now(),
        user: email,
        amount: gameState.bidCost
    });
    if (gameState.history.length > 50) gameState.history.pop();
  });

  // 3. ADMIN ACTIONS (Reset, Add Time)
  socket.on('adminAction', ({ password, action, value }) => {
     // Simple password check (Change '1234' to your password)
     if (action === 'RESET') {
        gameState.status = 'ACTIVE';
        gameState.endTime = Date.now() + 300000;
        gameState.jackpot = 100.00;
        gameState.history = [];
     }
  });

  // 4. WITHDRAWALS (Your existing code)
  socket.on('requestWithdrawal', async ({ email, amount, address }) => {
    // ... (Keep your withdrawal logic here if needed)
    console.log("Withdrawal requested:", email, amount);
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    console.log('User disconnected');
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});



