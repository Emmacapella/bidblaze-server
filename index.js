const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

// 1. SETUP SERVER
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// 2. DATABASE (Supabase)
const supabase = createClient(
  'https://zshodgjnjqirmcqbzujm.supabase.co',
  'sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz'
);

// 3. GAME VARIABLES
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

// 4. GAME LOOP
setInterval(async () => {
  const now = Date.now();
  
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      // REFUND LOGIC
      if (gameState.bidders.length === 1) {
          const lonePlayer = gameState.bidders[0];
          const refundAmount = gameState.userInvestments[lonePlayer] || 0;
          console.log("REFUND:", lonePlayer);
          
          const { data: user } = await supabase.from('users').select('balance').eq('email', lonePlayer).single();
          if (user) {
              await supabase.from('users').update({ balance: user.balance + refundAmount }).eq('email', lonePlayer);
          }
      } 
      // WINNER LOGIC
      else if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const winnerEmail = gameState.lastBidder;
          const winAmount = gameState.jackpot;
          console.log("WINNER:", winnerEmail);
          
          const { data: winner } = await supabase.from('users').select('balance').eq('email', winnerEmail).single();
          if (winner) {
              await supabase.from('users').update({ balance: winner.balance + winAmount }).eq('email', winnerEmail);
          }
          gameState.recentWinners.unshift({ user: winnerEmail, amount: winAmount, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();
      }
    }
  } else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE';
      gameState.endTime = now + 300000;
      gameState.jackpot = 50.00;
      gameState.lastBidder = null;
      gameState.history = [];
      gameState.bidders = [];
      gameState.userInvestments = {};
    }
  }
  io.emit('gameState', gameState);
}, 100);

// 5. CLIENT CONNECTION
io.on('connection', (socket) => {
  console.log('User connected');
  gameState.connectedUsers++;

  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    socket.join(email);
    let { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!user) {
       await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
       user = { balance: 0.00 };
    }
    socket.emit('balanceUpdate', user.balance);
  });

  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;
    const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
    if (!user || user.balance < gameState.bidCost) {
      socket.emit('bidError', 'Insufficient Funds');
      return;
    }
    const newBalance = user.balance - gameState.bidCost;
    await supabase.from('users').update({ balance: newBalance }).eq('email', email);
    socket.emit('balanceUpdate', newBalance);

    gameState.jackpot += (gameState.bidCost * 0.95); 
    gameState.lastBidder = email;
    
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (!gameState.userInvestments[email]) gameState.userInvestments[email] = 0;
    gameState.userInvestments[email] += gameState.bidCost;

    const timeRemaining = gameState.endTime - Date.now();
    if (timeRemaining < 10000) gameState.endTime = Date.now() + 10000;
    
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();

    io.emit('gameState', gameState);
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') {
        gameState.status = 'ACTIVE';
        gameState.endTime = Date.now() + 300000;
        gameState.jackpot = 50.00;
        gameState.history = [];
        gameState.bidders = [];
        gameState.userInvestments = {};
     } else if (action === 'SET_JACKPOT') gameState.jackpot = parseFloat(value);
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
  });
});

// 6. ROUTES & START
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

