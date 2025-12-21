const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

// --- 🏦 BANK CONFIGURATION (SUPABASE) ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
// ⚠️ YOUR SECRET KEY:
const SUPABASE_KEY = "Sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 🔐 SECURITY ---
const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;
const JACKPOT_SHARE = 0.70; // 70% to Winner
const HOUSE_SHARE = 0.30;   // 30% to You

// GLOBAL VARS
let globalFailures = 0;
let adminLockedUntil = 0;

// Local state (Syncs with DB)
let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,
  endTime: Date.now() + 299000, 
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  connectedUsers: 0
};

// --- 🔄 SYNC WITH DATABASE ---
async function loadGameFromDB() {
    // We try to find the game state row (ID=1)
    const { data, error } = await supabase.from('game_state').select('*').eq('id', 1).single();
    
    if (data) {
        gameState.jackpot = data.jackpot;
        gameState.houseBalance = data.house_balance;
        console.log(`✅ LOADED FROM BANK: Jackpot=$${gameState.jackpot}, Profit=$${gameState.houseBalance}`);
    } else {
        // If it doesn't exist, create it!
        console.log("⚠️ No DB record found. Creating first entry...");
        await supabase.from('game_state').insert([{ id: 1, jackpot: 0.00, house_balance: 0.00, end_time: 0 }]);
    }
}
// Run this immediately when server starts
loadGameFromDB(); 

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

  // 1. PLACE BID
  socket.on('placeBid', async (userEmail) => {
    if (gameState.status === 'ENDED') return;

    // A. Create User Account if missing
    if (userEmail) {
        let { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
        if (!user) {
            await supabase.from('users').insert([{ email: userEmail, balance: 0.00 }]);
            console.log(`🆕 New Account Created: ${userEmail}`);
        }
    }

    // B. Update Game State (Money Split)
    gameState.jackpot += JACKPOT_SHARE;      // +$0.70
    gameState.houseBalance += HOUSE_SHARE;    // +$0.30
    
    // C. SAVE TO BANK IMMEDIATELY
    saveGameToDB();

    // D. Update History
    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail || "Anonymous"
    };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 30);
    gameState.lastBidder = userEmail;

    // E. Timer Logic (5 Second Rule)
    const now = Date.now();
    if ((gameState.endTime - now) / 1000 < 5) {
        gameState.endTime = now + 10000; 
    }

    io.emit('gameState', gameState);
  });

  // 2. 🔐 ADMIN HANDLER
  socket.on('adminAction', (data) => {
    const { password, action, value } = data;
    const now = Date.now();

    if (now < adminLockedUntil) return; 

    if (password !== ADMIN_PASSWORD) {
        globalFailures++;
        if (globalFailures >= 3) {
            adminLockedUntil = now + (10 * 60 * 60 * 1000); 
            globalFailures = 0;
        }
        return;
    }
    globalFailures = 0; 

    if (action === 'RESET') {
        gameState.jackpot = 0.00;      
        gameState.endTime = Date.now() + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        saveGameToDB(); // Sync Reset to Bank
        io.emit('gameState', gameState);
    }
    
    if (action === 'SET_JACKPOT') {
        gameState.jackpot = parseFloat(value);
        saveGameToDB(); // Save manual change
        io.emit('gameState', gameState);
    }

    if (action === 'ADD_TIME') {
        gameState.endTime = Date.now() + (parseInt(value) * 1000);
        gameState.status = 'ACTIVE';
        io.emit('gameState', gameState);
    }

    if (action === 'CHECK_PROFIT') {
        // This prints to your server logs so you can see how much you made
        console.log(`💰 REAL PROFIT IN BANK: $${gameState.houseBalance.toFixed(2)}`);
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- AUTO-RESTART LOOP ---
setInterval(() => {
    const now = Date.now();

    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now;
        gameState.restartTimer = now + 15000; 
        io.emit('gameState', gameState);
    }

    if (gameState.status === 'ENDED' && now > gameState.restartTimer) {
        gameState.jackpot = 0.00;        
        gameState.endTime = now + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        gameState.restartTimer = 0;
        
        saveGameToDB(); // Reset Bank State
        console.log("🔄 Game Auto-Restarted!");
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => {
  console.log('BANKING SERVER RUNNING ON 3001 🚀');
});

