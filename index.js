const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

// --- CONFIG ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TELEGRAM_TOKEN = "8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI";
const MY_CHAT_ID = "6571047127";
const PING_URL = "https://bidblaze-server.onrender.com"; 

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// --- GAME VARIABLES ---
let gameState = {
  status: 'ACTIVE',
  endTime: Date.now() + 300000, 
  jackpot: 0.00,
  bidCost: 1.00,
  lastBidder: null,
  history: [],          
  recentWinners:   // Replace the empty [] with this:
  recentWinners: [
      { user: 'AlexKing@gmail.com', amount: 155.00, time: Date.now() },
      { user: 'SarahJ@yahoo.com', amount: 98.50, time: Date.now() },
      { user: 'CryptoFan@gmail.com', amount: 210.00, time: Date.now() }
  ],
,    
  connectedUsers: 0,
  restartTimer: null,
  bidders: [],          
  userInvestments: {}   
};

// --- KEEP ALIVE ---
setInterval(() => {
  https.get(PING_URL).on('error', () => {});
}, 300000);

function sendTelegramAlert(message) {
  if (!TELEGRAM_TOKEN || !MY_CHAT_ID) return;
  const text = encodeURIComponent(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;
  https.get(url).on('error', () => {});
}

// --- GAME LOOP ---
setInterval(async () => {
  const now = Date.now();
  
  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      if (gameState.bidders.length === 1) {
          const lonePlayer = gameState.bidders[0];
          const refundAmount = gameState.userInvestments[lonePlayer] || 0;
          
          console.log(`VOID: Refund ${lonePlayer}`);
          const { data: user } = await supabase.from('users').select('balance').eq('email', lonePlayer).single();
          if (user) {
              await supabase.from('users').update({ balance: user.balance + refundAmount }).eq('email', lonePlayer);
          }
      } else if (gameState.bidders.length > 1 && gameState.lastBidder) {
          const winnerEmail = gameState.lastBidder;
          const winAmount = gameState.jackpot;
          
          console.log(`WIN: ${winnerEmail}`);
          const { data: winner } = await supabase.from('users').select('balance').eq('email', winnerEmail).single();
          if (winner) {
              await supabase.from('users').update({ balance: winner.balance + winAmount }).eq('email', winnerEmail);
              sendTelegramAlert(`🏆 WINNER: ${winnerEmail} won $${winAmount.toFixed(2)}!`);
          }
          gameState.recentWinners.unshift({ user: winnerEmail, amount: winAmount, time: Date.now() });
          if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();
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
}, 100);

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);
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

// --- ROUTES ---
app.use(express.static(path.join(__dirname, 'dist')));

app.get(/.*/, (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

