const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');
const { createPublicClient, http, formatEther } = require('viem');
const { base } = require('viem/chains');

const app = express();
app.use(cors());

// --- ⚠️ SETTINGS ---
// 1. SUPABASE KEYS
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz"; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// 2. CRYPTO SETTINGS
// 👇 PASTE YOUR WALLET ADDRESS HERE (Must match Frontend)
const TREASURY_ADDRESS = "0x496EBF196a00a331b72219B6bE1473CbD316383f".toLowerCase(); 
const ETH_TO_USD_RATE = 1 / 0.0003; // $1 = 0.0003 ETH (Approx 3333 Credits per ETH)

// 3. GAME SETTINGS
const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;       
const JACKPOT_SHARE = 0.70; 
const HOUSE_SHARE = 0.30;   

// --- BLOCKCHAIN CLIENT ---
const publicClient = createPublicClient({ 
  chain: base, 
  transport: http() 
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

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

// --- SYNC ---
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

  // --- 🔒 SECURE DEPOSIT HANDLER ---
  socket.on('confirmDeposit', async (data) => {
      const { email, txHash } = data; // We verify amount ourselves now!
      console.log(`🔍 Verifying TX: ${txHash}...`);

      try {
          // 1. Check Replay (DB)
          const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
          if (existing) {
              console.log("⚠️ REJECTED: Transaction already used.");
              return;
          }

          // 2. ASK BLOCKCHAIN (Verify Real Amount)
          const tx = await publicClient.getTransaction({ hash: txHash });
          
          // Check Receiver
          if (tx.to.toLowerCase() !== TREASURY_ADDRESS) {
              console.log("⚠️ REJECTED: Money sent to wrong address.");
              return;
          }

          // Calculate Real Credits
          const ethValue = parseFloat(formatEther(tx.value));
          const creditsToAdd = ethValue * ETH_TO_USD_RATE; // Convert ETH to Credits
          const finalAmount = parseFloat(creditsToAdd.toFixed(2));

          if (finalAmount <= 0) {
             console.log("⚠️ REJECTED: Amount too small.");
             return;
          }

          // 3. Save to DB
          await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: finalAmount }]);
          
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          const newBalance = (user ? user.balance : 0) + finalAmount;
          
          await supabase.from('users').update({ balance: newBalance }).eq('email', email);
          
          // 4. Notify
          socket.emit('balanceUpdate', newBalance);
          console.log(`✅ VERIFIED: Added $${finalAmount} to ${email}`);

      } catch (err) {
          console.error("❌ VERIFICATION FAILED:", err.message);
      }
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

setInterval(async () => {
    const now = Date.now();

    if (gameState.status === 'ACTIVE' && now > gameState.endTime) {
        gameState.status = 'ENDED';
        gameState.endTime = now;
        gameState.restartTimer = now + 15000; 

        if (gameState.lastBidder && gameState.jackpot > 0) {
            const winner = gameState.lastBidder;
            const prize = gameState.jackpot;
            console.log(`🏆 PAYING WINNER: ${winner} won $${prize}`);
            const { data: user } = await supabase.from('users').select('balance').eq('email', winner).single();
            if (user) {
                await supabase.from('users').update({ balance: user.balance + prize }).eq('email', winner);
            }
        }
        io.emit('gameState', gameState);
    }

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
  console.log('SECURE SERVER RUNNING ON 3001 🚀');
});

