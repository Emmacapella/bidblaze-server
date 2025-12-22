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
  jackpot: 0.00,          // ✅ Starts at $0
  houseBalance: 0.00,
  bidCost: 1.00,
  endTime: Date.now() + (299 * 1000), // ✅ Starts at 299s
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  winners: [], // 🏆 Winner History
  connectedUsers: 0,
  restartTimer: 0
};

// Track unique players for the Refund Rule
let currentRoundBidders = new Set();
let currentRoundBidCount = 0;

// --- 💾 DATABASE FUNCTIONS ---
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

// --- 🤖 PING BOT (Keep-Alive) ---
setInterval(() => {
    // Keeps the server awake
    const mem = process.memoryUsage().rss / 1024 / 1024;
    console.log(`[PING] Server Alive. RAM: ${mem.toFixed(2)} MB`);
    // If you have a URL, you can fetch it here too: fetch('YOUR_APP_URL')
}, 300000); // Every 5 minutes

// --- 🌐 SOCKET CONNECTION ---
io.on('connection', (socket) => {
  gameState.connectedUsers++;
  io.emit('gameState', gameState);

  // 1. Get Balance
  socket.on('getUserBalance', async (email) => {
    if (!email) return;
    const { data } = await supabase.from('users').select('balance').eq('email', email).single();
    if (data) socket.emit('balanceUpdate', data.balance);
    else {
      await supabase.from('users').insert([{ email: email, balance: 0.00 }]);
      socket.emit('balanceUpdate', 0.00);
    }
  });

  // 2. 💸 Place Bid (The 95% Rule)
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

    // ✅ 95% to Jackpot, 5% to House
    gameState.jackpot += 0.95; 
    gameState.houseBalance += 0.05;

    // Track for Refund Rule
    currentRoundBidders.add(email);
    currentRoundBidCount++;

    // 🧠 Timer Logic (Add 10s only if under 5s)
    if (gameState.endTime - Date.now() < 5000) {
        gameState.endTime += 10000; 
    }

    const newBid = { id: Date.now(), user: email, amount: gameState.bidCost, time: new Date() };
    gameState.history.unshift(newBid);
    if (gameState.history.length > 50) gameState.history.pop();
    
    gameState.lastBidder = email;
    io.emit('gameState', gameState);
  });

  // 3. Deposit Logic
  socket.on('confirmDeposit', async (data) => {
    const { email, txHash } = data;
    try {
        const { data: existing } = await supabase.from('deposits').select('*').eq('id', txHash).single();
        if (existing) { socket.emit('depositError', 'Transaction already used!'); return; }

        const tx = await provider.getTransaction(txHash);
        if (!tx) { socket.emit('depositError', 'Transaction not found.'); return; }
        if (tx.to.toLowerCase() !== TREASURY_ADDRESS.toLowerCase()) { socket.emit('depositError', 'Wrong address!'); return; }

        const finalAmount = parseFloat((parseFloat(ethers.formatEther(tx.value)) * 3333).toFixed(2)); 
        
        await supabase.from('deposits').insert([{ id: txHash, user_email: email, amount: finalAmount }]);
        const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
        const newBal = (user ? user.balance : 0) + finalAmount;
        await supabase.from('users').update({ balance: newBal }).eq('email', email);
        
        socket.emit('balanceUpdate', newBal);
        socket.emit('depositSuccess', `Added $${finalAmount}!`);
    } catch (e) { console.error(e); }
  });

  // 4. Withdraw Logic
  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      try {
          if (amount < 10) return;
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!user || user.balance < amount) return;
          
          await supabase.from('users').update({ balance: user.balance - amount }).eq('email', email);
          socket.emit('balanceUpdate', user.balance - amount);
          socket.emit('withdrawSuccess', 'Processing...');
      } catch (e) { console.error(e); }
  });
  
  // 5. Admin
  socket.on('adminAction', (data) => {
    if (data.password !== '1234') return; 
    if (data.action === 'RESET') {
        gameState.status = 'ACTIVE';
        gameState.jackpot = 0.00;
        gameState.endTime = Date.now() + (299 * 1000);
        io.emit('gameState', gameState);
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- 🤖 SMART BOTS (Sniper Mode) ---
const botNames = ["CryptoKing", "Alice_W", "MoonWalker", "Whale0x", "SatoshiFan", "TraderJo", "EthMaxi", "BitLord", "DeFi_Degen", "GasMaster", "AlphaSeeker", "HODL_2025", "BaseGod", "NFT_Collector", "WAGMI_Boy"];

function triggerRandomBot() {
  const randomDelay = Math.floor(Math.random() * (40000 - 25000 + 1) + 25000); 

  setTimeout(() => {
    if (gameState.status === 'ACTIVE') {
       const randomBot = botNames[Math.floor(Math.random() * botNames.length)];
       const timeLeft = gameState.endTime - Date.now();

       // Only bid if time < 5s
       if (timeLeft < 5000 && timeLeft > 0) gameState.endTime += 10000;

       // Bots behave like users: 95% to pot, 5% fee
       gameState.jackpot += 0.95;
       gameState.houseBalance += 0.05;

       const newBid = { id: Date.now(), user: randomBot + "@bot.com", amount: 1.00, time: new Date() };
       
       gameState.history.unshift(newBid);
       if (gameState.history.length > 50) gameState.history.pop();
       
       // Bots count as players
       currentRoundBidders.add(randomBot + "@bot.com");
       currentRoundBidCount++;
       
       io.emit('gameState', gameState);
    }
    triggerRandomBot();
  }, randomDelay);
}
triggerRandomBot();

// --- ⚡ MAIN GAME LOOP (With Refund Rule) ---
setInterval(async () => {
  const now = Date.now();

  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      // GAME OVER
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      // 🛑 CHECK REFUND RULE: Less than 2 players?
      if (currentRoundBidders.size < 2 && gameState.history.length > 0) {
          console.log("⚠️ Not enough players. Refunding...");
          
          // Refund the one player (Real users only)
          const lastBidder = gameState.history[0].user;
          if (!lastBidder.includes("@bot.com")) {
              const { data: user } = await supabase.from('users').select('balance').eq('email', lastBidder).single();
              // Calculate total spent by this user in this round
              const refundAmt = gameState.history.filter(b => b.user === lastBidder).length * 1.00;
              
              if (user) {
                  await supabase.from('users').update({ balance: user.balance + refundAmt }).eq('email', lastBidder);
                  console.log(`✅ Refunded $${refundAmt} to ${lastBidder}`);
              }
          }
          // Reset Jackpot for next round (since it was refunded/voided)
          gameState.jackpot = 0.00; 
      } 
      // 🏆 NORMAL WIN (2+ Players)
      else if (gameState.history.length > 0) {
         const lastBid = gameState.history[0];
         const winnerEntry = { user: lastBid.user, amount: gameState.jackpot, time: now };
         
         // Add to History
         gameState.winners.unshift(winnerEntry);
         if (gameState.winners.length > 5) gameState.winners.pop();

         console.log(`🏆 WINNER: ${lastBid.user} won $${gameState.jackpot}`);

         // Pay Winner
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
    if (now >= gameState.restartTimer) {
      // 🔄 RESTART GAME
      gameState.status = 'ACTIVE';
      gameState.jackpot = 0.00; // Reset to $0
      gameState.endTime = now + (299 * 1000); // Reset to 299s
      gameState.history = [];
      gameState.lastBidder = null;
      
      // Clear Round Tracking
      currentRoundBidders.clear();
      currentRoundBidCount = 0;
      
      saveGameToDB();
      io.emit('gameState', gameState);
    }
  }
}, 1000);

server.listen(3001, () => { console.log('SERVER RUNNING 🚀'); });

