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
const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;
const JACKPOT_SHARE = 0.70; // 70% to Winner
const HOUSE_SHARE = 0.30;   // 30% to You

// GLOBAL SECURITY VARIABLES
let globalFailures = 0;
let adminLockedUntil = 0;

let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,   // <--- TRACKS YOUR PROFIT
  bidCost: BID_FEE,
  endTime: Date.now() + 299000, 
  restartTimer: 0,
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  status: 'ACTIVE'
};

io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  // 1. PLACE BID HANDLER (With Profit Split)
  socket.on('placeBid', (userEmail) => {
    if (gameState.status === 'ENDED') return;

    // --- THE SPLIT LOGIC ---
    gameState.jackpot += JACKPOT_SHARE;      // +$0.70
    gameState.houseBalance += HOUSE_SHARE;    // +$0.30
    
    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail || "Anonymous"
    };

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
        gameState.restartTimer = 0;
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
    
    // NEW: Check House Profits
    if (action === 'CHECK_PROFIT') {
        console.log(`💰 HOUSE PROFIT: $${gameState.houseBalance.toFixed(2)}`);
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
        console.log("🔄 Game Auto-Restarted!");
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => {
  console.log('SERVER RUNNING ON 3001 🚀');
});

