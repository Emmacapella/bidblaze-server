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

// --- CONSTANTS ---
const GAME_DURATION_MS = 299 * 1000; // 5 Minutes
const BID_FEE = 1.00;     // 1 USDC
const JACKPOT_SHARE = 0.70; // 70% goes to winner
const DEV_SHARE = 0.30;     // 30% goes to you

// --- GAME STATE ---
let gameState = {
  status: 'ACTIVE',
  jackpot: 0.00, // Starts at $0 (Progressive)
  devWallet: 0.00, // Tracks your earnings
  endTime: Date.now() + GAME_DURATION_MS,
  bidCost: BID_FEE,
  bidCount: 0,
  lastBidder: "No bids yet",
  history: []
};

// --- INTERNAL LOOP ---
setInterval(() => {
  const timeLeft = Math.max(0, Math.ceil((gameState.endTime - Date.now()) / 1000));
  
  if (gameState.status === 'ACTIVE' && timeLeft <= 0) {
    gameState.status = 'ENDED';
    io.emit('gameState', gameState);
    
    // Wait 30s then reset
    setTimeout(() => {
      resetGame();
    }, 30000);
  }
}, 1000);

function resetGame() {
  gameState.status = 'ACTIVE';
  gameState.jackpot = 0; 
  gameState.endTime = Date.now() + GAME_DURATION_MS;
  gameState.bidCost = BID_FEE;
  gameState.bidCount = 0;
  gameState.lastBidder = "No bids yet"; // FIXED THIS LINE
  gameState.history = [];
  io.emit('gameState', gameState);
}

io.on('connection', (socket) => {
  socket.emit('gameState', gameState);

  socket.on('placeBid', (userEmail) => {
    if (gameState.status !== 'ACTIVE') return;

    // 1. UPDATE MONEY
    gameState.bidCount++;
    gameState.jackpot += (BID_FEE * JACKPOT_SHARE); // Add $0.70
    gameState.devWallet += (BID_FEE * DEV_SHARE);   // Add $0.30 

    // 2. LOG ENTRY
    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail || "Anonymous"
    };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 5);
    gameState.lastBidder = userEmail;

    // 3. UPDATE TIME (Under 20s Rule)
    const now = Date.now();
    const timeRemaining = gameState.endTime - now;
    if (timeRemaining < 20000) {
      gameState.endTime += 10000; 
    }

    io.emit('gameState', gameState);
    
    console.log(`Bid Placed! Jackpot: $${gameState.jackpot.toFixed(2)}`);
  });
});

server.listen(3001, () => {
  console.log('NO-LOSS SERVER RUNNING ON 3001 🚀');
});

