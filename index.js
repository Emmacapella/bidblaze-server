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

const ADMIN_PASSWORD = "bidblaze-boss"; 
const BID_FEE = 1.00;       
const JACKPOT_SHARE = 0.95; 
const HOUSE_SHARE = 0.05;   

const provider = new ethers.JsonRpcProvider('https://mainnet.base.org');

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

// --- 🌍 GLOBAL STATE ---
let gameState = {
  jackpot: 50.00,        
  houseBalance: 0.00,
  bidCost: 1.00,
  endTime: Date.now() + 60000,
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  // 🏆 Fake winners so the list isn't empty at start
  winners: [
      { user: "Whale0x@bot.com", amount: 142.00, time: Date.now() - 100000 },
      { user: "SatoshiFan@bot.com", amount: 89.00, time: Date.now() - 500000 },
      { user: "CryptoKing@bot.com", amount: 210.50, time: Date.now() - 900000 }
  ],
  connectedUsers: 0,
  restartTimer: 0
};

// --- 💾 DATABASE FUNCTIONS ---
async function loadGameFromDB() {
  const { data } = await supabase.from('game_state').select('*').eq('id', 1).single();
  if (data) {
    gameState.jackpot = data.jackpot;
    gameState.houseBalance = data.house_balance;
  } else {
    await supabase.from('game_state').insert([{ id: 1, jackpot: 50.00, house_balance: 0.00, end_time: 0 }]);
  }
}
loadGameFromDB();

async function saveGameToDB() {
  await supabase.from('game_state').update({
    jackpot: gameState.jackpot,
    house_balance: gameState.houseBalance
  }).eq('id', 1);
}

// --- 🌐 SOCKET CONNECTION & PAYMENTS ---
io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  // 1. 💰 Get Balance
  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    const { data } = await supabase.from('users').select('balance').eq('email', email).single();
    if (data) socket.emit('balanceUpdate', data.balance);
    else {
      // Create user if not exists
      await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
      socket.emit('balanceUpdate', 0.00);
    }
  });

  // 2. 💸 Place Bid
  socket.on('placeBid', async (email) => {
    if (gameState.status !== 'ACTIVE') return;

    // Deduct Balance (Real Users)
    if (!email.includes('@bot.com')) {
        const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
        if (!user || user.balance < gameState.bidCost) {
            socket.emit('bidError', 'Insufficient Funds');
            return;
        }
        await supabase.from('users').update({ balance: user.balance - gameState.bidCost }).eq('email', email);
        socket.emit('balanceUpdate', user.balance - gameState.bidCost);
    }

    // Update Game
    gameState.jackpot += gameState.bidCost;
    
    // 🧠 Time Logic: Only add 10s if under 5s
    if (gameState.endTime - Date.now() < 5000) {
        gameState.endTime += 10000; 
    }

    const newBid = { id: Date.now(), user: email, amount: gameState.bidCost, time: new Date() };
    gameState.history.unshift(newBid);
    if (gameState.history.length > 50) gameState.history.pop();
    
    gameState.lastBidder = email;
    io.emit('gameState', gameState);
  });

  // 3. 📥 Deposit Logic
  socket.on('confirmDeposit', async (data) => {
    const { email, txHash } = data;
    try {
        const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
        if (existing) { socket.emit('depositError', 'Transaction already used!'); return; }

        const tx = await provider.getTransaction(txHash);
        if (!tx) { socket.emit('depositError', 'Transaction not found. Wait a moment?'); return; }
        // Note: Ensure TREASURY_ADDRESS is defined in your top section
        if (tx.to.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) { socket.emit('depositError', 'Money sent to wrong address!'); return; }

        const finalAmount = parseFloat((parseFloat(ethers.formatEther(tx.value)) * 3333).toFixed(2)); 
        
        await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: finalAmount }]);
        
        const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
        const newBal = (user ? user.balance : 0) + finalAmount;
        
        await supabase.from('users').update({ balance: newBal }).eq('email', email);
        
        socket.emit('balanceUpdate', newBal);
        socket.emit('depositSuccess', `Added $${finalAmount}!`);
    } catch (e) {
        console.error(e);
        socket.emit('depositError', 'System Error checking Hash.');
    }
  });

  // 4. 📤 Withdrawal Logic
  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      try {
          if (amount < 10) { socket.emit('withdrawError', 'Min withdrawal is $10'); return; }
          
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!user || user.balance < amount) { socket.emit('withdrawError', 'Insufficient funds'); return; }
          
          await supabase.from('users').update({ balance: user.balance - amount }).eq('email', email);
          console.log(`WITHDRAWAL REQUEST: ${email} wants $${amount} to ${address}`);
          
          socket.emit('balanceUpdate', user.balance - amount);
          socket.emit('withdrawSuccess', 'Withdrawal Processing!');
      } catch (e) { console.error(e); }
  });
  
  // 5. 🔐 Admin Action
  socket.on('adminAction', (data) => {
    if (data.password !== '1234') return; 
    if (data.action === 'RESET') {
        gameState.status = 'ACTIVE';
        gameState.jackpot = 50.00;
        gameState.endTime = Date.now() + 60000;
        io.emit('gameState', gameState);
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- 🤖 SMART BOT SYSTEM ---
const botNames = ["CryptoKing", "Alice_W", "MoonWalker", "Whale0x", "SatoshiFan", "TraderJo", "EthMaxi", "BitLord", "DeFi_Degen", "GasMaster", "AlphaSeeker", "HODL_2025", "BaseGod", "NFT_Collector", "WAGMI_Boy"];

function triggerRandomBot() {
  const randomDelay = Math.floor(Math.random() * (40000 - 25000 + 1) + 25000); // 25-40s

  setTimeout(() => {
    if (gameState.status === 'ACTIVE') {
       const randomBot = botNames[Math.floor(Math.random() * botNames.length)];
       const timeLeft = gameState.endTime - Date.now();

       if (timeLeft < 5000 && timeLeft > 0) {
           gameState.endTime += 10000;
           console.log("🤖 Bot extended time!");
       }

       gameState.jackpot += 1.00;
       const newBid = { id: Date.now(), user: randomBot + "@bot.com", amount: 1.00, time: new Date() };
       
       gameState.history.unshift(newBid);
       if (gameState.history.length > 50) gameState.history.pop();
       
       io.emit('gameState', gameState);
    }
    triggerRandomBot();
  }, randomDelay);
}
triggerRandomBot();

// --- ⚡ MAIN GAME LOOP (The Engine) ---
setInterval(async () => {
  const now = Date.now();

  if (gameState.status === 'ACTIVE') {
    // Check if Time is Up
    if (now >= gameState.endTime) {
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; // 15 Second cooldown

      // 🏆 SAVE WINNER
      if (gameState.history.length > 0) {
         const lastBid = gameState.history[0];
         const winnerEntry = { user: lastBid.user, amount: gameState.jackpot, time: now };
         
         // Add to list
         gameState.winners.unshift(winnerEntry);
         if (gameState.winners.length > 5) gameState.winners.pop();

         console.log(`🏆 WINNER: ${lastBid.user} won $${gameState.jackpot}`);

         // Pay Real User
         if (!lastBid.user.includes("@bot.com")) {
             const { data: userData } = await supabase.from('users').select('balance').eq('email', lastBid.user).single();
             if (userData) {
                 await supabase.from('users').update({ balance: userData.balance + gameState.jackpot }).eq('email', lastBid.user);
             }
         }
         saveGameToDB();
      }
      io.emit('gameState', gameState);
    }
  } 
  else if (gameState.status === 'ENDED') {
    // Check if Cooldown is Over
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE';
      gameState.jackpot = 50.00;
      gameState.endTime = now + 60000;
      gameState.history = [];
      gameState.lastBidder = null;
      
      saveGameToDB();
      io.emit('gameState', gameState);
    }
  }
}, 1000);

server.listen(3001, () => { console.log('SERVER RUNNING ON PORT 3001 🚀'); });

