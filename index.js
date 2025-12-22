const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');

const app = express();
app.use(cors());

// --- ⚠️ SETTINGS ---
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TREASURY_ADDRESS = "0x496EBF196a00a331b72219B6bE1473CbD316383f".toLowerCase(); // ⚠️ PASTE YOUR ADDRESS HERE
const ETH_TO_USD_RATE = 3333; 

const ADMIN_PASSWORD = "emma$tiara"; 
const BID_FEE = 1.00;       
const JACKPOT_SHARE = 0.70; 
const HOUSE_SHARE = 0.30;   

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// GLOBAL STATE
let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,
  bidCost: BID_FEE,
  endTime: Date.now() + 299000, 
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  connectedUsers: 0,
  restartTimer: 0
};

// 🛡️ NEW: Track Bidders for Refund Logic
let currentRoundBidders = new Set();
let currentRoundBidCount = 0;

// --- SYNC ---
async function loadGameFromDB() {
    const { data } = await supabase.from('game_state').select('*').eq('id', 1).single();
    if (data) {
        gameState.jackpot = data.jackpot;
        gameState.houseBalance = data.house_balance;
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

app.get('/', (req, res) => { res.send('BidBlaze Server is Running! 🚀'); });

io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  socket.on('getUserBalance', async (email) => {
      if (!email) return;
      const { data } = await supabase.from('users').select('balance').eq('email', email).single();
      if (data) socket.emit('balanceUpdate', data.balance);
      else {
          await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
          socket.emit('balanceUpdate', 0.00);
      }
  });

  socket.on('confirmDeposit', async (data) => {
      const { email, txHash } = data;
      try {
          const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
          if (existing) { socket.emit('depositError', '⚠️ Receipt already used!'); return; }

          const tx = await provider.getTransaction(txHash);
          if (!tx) { socket.emit('depositError', '❌ Transaction not found. Wait a moment?'); return; }
          if (tx.to.toLowerCase() !== TREASURY_ADDRESS) { socket.emit('depositError', '❌ Money sent to wrong address!'); return; }

          const finalAmount = parseFloat((parseFloat(ethers.formatEther(tx.value)) * ETH_TO_USD_RATE).toFixed(2));
          if (finalAmount <= 0) { socket.emit('depositError', '❌ Amount too small.'); return; }

          await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: finalAmount }]);
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          const newBalance = (user ? user.balance : 0) + finalAmount;
          await supabase.from('users').update({ balance: newBalance }).eq('email', email);
          
          socket.emit('balanceUpdate', newBalance);
          socket.emit('depositSuccess', `✅ Added $${finalAmount}!`);
      } catch (err) {
          console.error(err);
          socket.emit('depositError', '❌ System Error. Check Hash.');
      }
  });

  socket.on('placeBid', async (userEmail) => {
    if (gameState.status === 'ENDED') return;
    if (!userEmail) return;

    const { data: user } = await supabase.from('users').select('*').eq('email', userEmail).single();
    if (!user || user.balance < BID_FEE) { socket.emit('bidError', 'Insufficient Balance!'); return; }

    // Deduct Balance
    const newBalance = user.balance - BID_FEE;
    await supabase.from('users').update({ balance: newBalance }).eq('email', userEmail);
    socket.emit('balanceUpdate', newBalance); 

    // Update Game State
    gameState.jackpot += JACKPOT_SHARE;      
    gameState.houseBalance += HOUSE_SHARE;    
    
    // 🛡️ Track Stats for Refund Logic
    currentRoundBidders.add(userEmail);
    currentRoundBidCount++;

    saveGameToDB(); 

    // Update History
    const newBid = { id: Date.now(), amount: BID_FEE, time: new Date().toLocaleTimeString(), user: userEmail };
    gameState.history.unshift(newBid);
    gameState.history = gameState.history.slice(0, 30);
    gameState.lastBidder = userEmail;

    // Timer Logic
    const now = Date.now();
    if ((gameState.endTime - now) / 1000 < 10) { // Bump to 10s if low
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
        currentRoundBidders.clear();
        currentRoundBidCount = 0;
        saveGameToDB(); 
        io.emit('gameState', gameState);
    }
    // ... Other admin actions remain the same
  });

  socket.on('disconnect', () => { gameState.connectedUsers--; io.emit('gameState', gameState); });
});

// --- 🔄 GAME LOOP & REFUND LOGIC ---
setInterval(async () => {
    const now = Date.now();

    // 1. END GAME
    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now;
        gameState.restartTimer = now + 15000; 

        if (gameState.lastBidder) {
            const winner = gameState.lastBidder;
            
            // 🛡️ CHECK: Is it a Refund? (Only 1 Player)
            if (currentRoundBidders.size === 1) {
                console.log(`🛡️ REFUND: Only 1 player (${winner}). Returning fees.`);
                
                // Refund Amount = Number of bids * Cost
                const refundAmount = currentRoundBidCount * BID_FEE;
                
                // Remove the "Profit" we thought we made
                gameState.houseBalance -= (currentRoundBidCount * HOUSE_SHARE);

                // Give money back
                const { data: user } = await supabase.from('users').select('balance').eq('email', winner).single();
                if (user) {
                   await supabase.from('users').update({ balance: user.balance + refundAmount }).eq('email', winner);
                }
            } 
            // 🏆 NORMAL WIN (2+ Players)
            else if (gameState.jackpot > 0) {
                console.log(`🏆 WINNER: ${winner} won $${gameState.jackpot}`);
                const { data: user } = await supabase.from('users').select('balance').eq('email', winner).single();
                if (user) {
                    await supabase.from('users').update({ balance: user.balance + gameState.jackpot }).eq('email', winner);
                }
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
        
        // Reset Tracker
        currentRoundBidders.clear();
        currentRoundBidCount = 0;

        gameState.restartTimer = 0;
        saveGameToDB(); 
        io.emit('gameState', gameState);
    }
}, 1000);

server.listen(3001, () => { console.log('SERVER RUNNING 🚀'); });

