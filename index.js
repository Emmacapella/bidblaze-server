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

// --- SILENT GAME STATE ---
let gameState = {
  status: 'ACTIVE',
  jackpot: 1250,
  // We use "endTime" (Target Time) instead of counting down seconds
  endTime: Date.now() + 300000, 
  bidCost: 1,
  bidCount: 0,
  lastBidder: "No bids yet",
  history: []
};

// --- CHECK GAME OVER (Internal Loop) ---
setInterval(() => {
  const timeLeft = Math.max(0, Math.ceil((gameState.endTime - Date.now()) / 1000));
  
  if (gameState.status === 'ACTIVE' && timeLeft <= 0) {
    gameState.status = 'ENDED';
    io.emit('gameState', gameState); // Only speak if game ends
    
    setTimeout(() => {
      resetGame();
    }, 30000);
  }
}, 1000);

function resetGame() {
  gameState.status = 'ACTIVE';
  gameState.jackpot = 1250;
  gameState.endTime = Date.now() + 300000;
  gameState.bidCost = 1;
  gameState.bidCount = 0;
  gameState.lastBidder = "No bids yet";
  gameState.history = [];
  io.emit('gameState', gameState);
}

io.on('connection', (socket) => {
  socket.emit('gameState', gameState);

  socket.on('placeBid', (userEmail) => {
    if (gameState.status !== 'ACTIVE') return;

    gameState.bidCount++;
    if (gameState.bidCount % 5 === 0) gameState.jackpot += 2;

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

    // --- RESET TIMER ---
    // Push the target time 5 minutes into the future
    gameState.endTime = Date.now() + 300000; 

    io.emit('gameState', gameState);
  });
});

server.listen(3001, () => {
  console.log('SILENT SERVER RUNNING ON 3001 🚀');
});

