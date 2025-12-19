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

// --- MASTER GAME STATE ---
let gameState = {
  status: 'ACTIVE', // Can be 'ACTIVE' or 'ENDED'
  jackpot: 1250,
  timeLeft: 299,
  bidCost: 1,
  bidCount: 0,
  lastBidder: "No bids yet",
  history: []
};

// --- HELPER: RESET GAME ---
function resetGame() {
  console.log("Starting New Round...");
  gameState.status = 'ACTIVE';
  gameState.jackpot = 1250;
  gameState.timeLeft = 299;
  gameState.bidCost = 1;
  gameState.bidCount = 0;
  gameState.lastBidder = "No bids yet";
  gameState.history = [];
  io.emit('gameState', gameState); // Tell everyone new game started
}

// --- CLOCK LOOP ---
setInterval(() => {
  if (gameState.status === 'ACTIVE') {
    if (gameState.timeLeft > 0) {
      gameState.timeLeft--;
      io.emit('timerUpdate', gameState.timeLeft);
    } else {
      // TIME IS UP! GAME OVER.
      gameState.status = 'ENDED';
      io.emit('gameState', gameState); // Notify frontend (Game Over)
      
      console.log("Game Ended! Waiting 30s...");
      
      // Wait 30 Seconds, then Restart
      setTimeout(() => {
        resetGame();
      }, 30000); 
    }
  }
}, 1000);

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
  socket.emit('gameState', gameState);

  socket.on('placeBid', (userEmail) => {
    // REJECT BID IF GAME IS OVER
    if (gameState.status !== 'ACTIVE') return;

    gameState.bidCount++;
    
    // Jackpot Logic
    if (gameState.bidCount % 5 === 0) {
      gameState.jackpot += 2;
    }

    // History Logic
    const newBid = {
      id: Date.now(),
      amount: gameState.bidCost,
      time: new Date().toLocaleTimeString(),
      user: userEmail || "Anonymous"
    };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 5);

    gameState.lastBidder = userEmail;
    gameState.bidCost++;

    // --- FIXED TIMER LOGIC ---
    // If under 20s, add 10s.
    if (gameState.timeLeft < 20) {
      gameState.timeLeft += 10;
    }

    // Broadcast Update
    io.emit('gameState', gameState);
  });
});

server.listen(3001, () => {
  console.log('SERVER IS RUNNING ON PORT 3001 🚀');
});

