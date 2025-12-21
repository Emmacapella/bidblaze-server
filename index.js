const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();
app.use(cors());

// --- 🏦 BANK CONFIGURATION (SUPABASE) ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
// ⚠️ YOUR SECRET KEY (Small 's' fixed):
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

// --- 🔐 SETTINGS ---
const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;       
const JACKPOT_SHARE = 0.70; 
const HOUSE_SHARE = 0.30;   

// GLOBAL VARS
let globalFailures = 0;
let adminLockedUntil = 0;

let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,
  bidCost: BID_FEE,             // <--- FIXED: Displays $1.00 correctly
  endTime: Date.now() + 299000, 
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  restartTimer: 0
};

// --- 🔄 SYNC ---
async function loadGameFromDB() {
    const { data } = await supabase.from('game_state').select('*').eq('id', 1).single();
    if (data) {
        gameState.jackpot = data.jackpot;
        gameState.houseBalance = data.house_balance;
        console.log(`✅ BANK LOADED: Jackpot=$${gameState.jackpot}, Profit=$${gameState.houseBalance}`);
    } else {
        await supabase.from('game_state').insert([{ id: 1, jackpot: 0.00, house_balance: 0.00, end_time: 0 }]);
    }
}
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

  socket.on('getUserBalance', async (email) => {
      if (!email) return;
      const { data } = await supabase.from('users').select('balance').eq('email', email).single();
      if (data) {
          socket.emit('balanceUpdate', data.balance);
      } else {
          await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
          socket.emit('balanceUpdate', 0.00);
      }
  });

  socket.on('confirmDeposit', async (data) => {
      const { email, amount, txHash } = data;
      const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
      if (existing) return;

      await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: parseFloat(amount) }]);
      
      const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
      const newBalance = (user ? user.balance : 0) + parseFloat(amount);
      
      await supabase.from('users').update({ balance: newBalance }).eq('email', email);
      socket.emit('balanceUpdate', newBalance);
      console.log(`✅ DEPOSIT: $${amount} for ${email}`);
  });

  socket.on('placeBid', async (userEmail) => {
    if (gameState.status === 'ENDED') return;
    if (!userEmail) return;

    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user || user.balance < BID_FEE) {
        socket.emit('bidError', 'Insufficient Balance!');
        return; 
    }

    const newBalance = user.balance - BID_FEE;
    await supabase.from('users').update({ balance: newBalance }).eq('email', userEmail);
    socket.emit('balanceUpdate', newBalance); 

    gameState.jackpot += JACKPOT_SHARE;      
    gameState.houseBalance += HOUSE_SHARE;    
    saveGameToDB(); 

    const newBid = {
      id: Date.now(),
      amount: BID_FEE,
      time: new Date().toLocaleTimeString(),
      user: userEmail
    };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 30);
    gameState.lastBidder = userEmail;

    const now = Date.now();
    if ((gameState.endTime - now) / 1000 < 5) {
        gameState.endTime = now + 10000; 
    }

    io.emit('gameState', gameState);
  });

  socket.on('adminAction', (data) => {
    const { password, action, value } = data;
    if (password !== ADMIN_PASSWORD) return;

    if (action === 'RESET') {
        gameState.jackpot = 0.00;      
        gameState.endTime = Date.now() + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        saveGameToDB(); 
        io.emit('gameState', gameState);
    }
    if (action === 'SET_JACKPOT') {
        gameState.jackpot = parseFloat(value);
        saveGameToDB();
        io.emit('gameState', gameState);
    }
    if (action === 'ADD_TIME') {
        gameState.endTime = Date.now() + (parseInt(value) * 1000);
        gameState.status = 'ACTIVE';
        io.emit('gameState', gameState);
    }
    if (action === 'CHECK_PROFIT') {
        console.log(`💰 HOUSE PROFIT: $${gameState.houseBalance.toFixed(2)}`);
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- 🏆 AUTO-PAYOUT & RESTART LOOP ---
setInterval(async () => {
    const now = Date.now();

    // 1. END GAME & PAY WINNER
    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now;
        gameState.restartTimer = now + 15000; 

        // 💰 PAYOUT LOGIC 💰
        if (gameState.lastBidder && gameState.jackpot > 0) {
            const winner = gameState.lastBidder;
            const prize = gameState.jackpot;
            
            console.log(`🏆 PAYING WINNER: ${winner} won $${prize}`);

            // Fetch current balance
            const { data: user } = await supabase.from('users').select('balance').eq('email', winner).single();
            if (user) {
                const newBalance = user.balance + prize;
                // Update Balance in DB
                await supabase.from('users').update({ balance: newBalance }).eq('email', winner);
            }
        }

        io.emit('gameState', gameState);
    }

    // 2. RESTART GAME
    if (gameState.status === 'ENDED' && now > gameState.restartTimer) {
        gameState.jackpot = 0.00;        
        gameState.endTime = now + 299000; 
        gameState.history = [];
        gameState.status = 'ACTIVE';
        gameState.lastBidder = null;
        gameState.restartTimer = 0;
        
        saveGameToDB(); 
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => {
  console.log('BUSINESS SERVER RUNNING ON 3001 🚀');
});

