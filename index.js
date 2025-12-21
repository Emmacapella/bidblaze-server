const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 🔐 SECURITY CONFIGURATION ---
const ADMIN_PASSWORD = "bidblaze-boss"; // <--- CHANGE THIS TO SOMETHING STRONG!
const BID_FEE = 1.00;

// GLOBAL SECURITY VARIABLES (Must be at the top)
let globalFailures = 0;
let adminLockedUntil = 0;

let gameState = {
  jackpot: 100.00,
  bidCost: BID_FEE,
  endTime: Date.now() + 60000,
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  status: 'ACTIVE'
};

io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  // 1. PLACE BID HANDLER
  socket.on('placeBid', (userEmail) => {
    if (gameState.status === 'ENDED') return;

    gameState.jackpot += BID_FEE;
    
    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail || "Anonymous"
    };

    // Keep 30 items in history
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 30);
    gameState.lastBidder = userEmail;

    // Smart Timer Logic (5 Second Rule)
    const now = Date.now();
    const timeLeft = (gameState.endTime - now) / 1000;
    if (timeLeft < 5) {
        gameState.endTime = now + 10000; 
    }

    io.emit('gameState', gameState);
  });

  // 2. 🔐 ADMIN HANDLER (3 Tries = 10 Hour Lockdown)
  socket.on('adminAction', (data) => {
    const { password, action, value } = data;
    const now = Date.now();

    // A. CHECK IF LOCKED
    if (now < adminLockedUntil) {
        const hoursLeft = ((adminLockedUntil - now) / (1000 * 60 * 60)).toFixed(1);
        console.log(`⛔ SECURITY LOCKDOWN ACTIVE. Try again in ${hoursLeft} hours.`);
        return; // REJECT EVERYONE
    }

    // B. CHECK PASSWORD
    if (password !== ADMIN_PASSWORD) {
        globalFailures++;
        console.log(`⚠️ Failed Login [Total: ${globalFailures}/3]`);

        // TRIGGER LOCKDOWN AFTER 3 FAILS
        if (globalFailures >= 3) {
            adminLockedUntil = now + (10 * 60 * 60 * 1000); // 10 Hours
            globalFailures = 0; 
            console.log("🚨 MAXIMUM FAILURES REACHED. Admin Panel locked for 10 hours.");
        }
        return;
    }

    // C. SUCCESS (Reset counter)
    globalFailures = 0;

    if (action === 'RESET') {
        gameState.jackpot = 100.00;
        gameState.endTime = Date.now() + 60000;
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        io.emit('gameState', gameState);
    }
    
    if (action === 'SET_JACKPOT') {
        gameState.jackpot = parseFloat(value);
        io.emit('gameState', gameState);
    }

    if (action === 'ADD_TIME') {
        gameState.endTime = Date.now() + (parseInt(value) * 1000);
        gameState.status = 'ACTIVE';
        io.emit('gameState', gameState);
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

    // 1. Check if Game Should End
    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now; // Freeze main timer
        gameState.restartTimer = now + 15000; // Set restart for 15s later
        io.emit('gameState', gameState);
    }

    // 2. Check if Game Should Restart
    if (gameState.status === 'ENDED' && now > gameState.restartTimer) {
        gameState.jackpot = 100.00;
        gameState.endTime = now + 60000; // New 60s timer
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        gameState.restartTimer = 0;
        console.log("🔄 Game Auto-Restarted!");
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => {
  console.log('SECURE SERVER RUNNING ON 3001 🚀');
});

