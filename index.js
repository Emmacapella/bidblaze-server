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

// GLOBAL STATE
let gameState = {
  jackpot: 0.00,        
  houseBalance: 0.00,
  bidCost: BID_FEE,
  endTime: Date.now() + 299000, 
  status: 'ACTIVE',
  lastBidder: null,
  history: [],
  winners: [],
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
  // --- 💸 WITHDRAWAL REQUEST HANDLER ---
  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      console.log(`📉 WITHDRAWAL REQUEST: ${email} wants $${amount}`);

      try {
          if (amount < 10) {
              socket.emit('withdrawError', '❌ Minimum withdrawal is $10');
              return;
          }

          // 1. Check Balance
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          
          if (!user || user.balance < amount) {
              socket.emit('withdrawError', '❌ Insufficient Funds');
              return;
          }

          // 2. Deduct Balance
          const newBalance = user.balance - amount;
          await supabase.from('users').update({ balance: newBalance }).eq('email', email);

          // 3. Save Request to DB (You need to create this table!)
          await supabase.from('withdrawals').insert([{
              user_email: email,
              amount: amount,
              wallet_address: address,
              status: 'PENDING',
              created_at: new Date()
          }]);

          // 4. Notify Success
          socket.emit('balanceUpdate', newBalance);
          socket.emit('withdrawSuccess', '✅ Request Sent! Admin will process shortly.');
          console.log(`✅ WITHDRAWAL LOGGED: $${amount} for ${email}`);

      } catch (err) {
          console.error("❌ WITHDRAWAL ERROR:", err.message);
          socket.emit('withdrawError', '❌ System Error. Try again.');
      }
  });
  // --- 📜 FETCH WITHDRAWAL HISTORY ---
  socket.on('getWithdrawals', async (email) => {
      const { data } = await supabase
          .from('withdrawals')
          .select('*')
          .eq('user_email', email)
          .order('created_at', { ascending: false })
          .limit(5); // Show last 5
      
      socket.emit('withdrawalHistory', data || []);
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
    if (password !== bidblaze-boss) return;

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

// --- 🤖 SMART BOT & GAME ENGINE (With Database Saving) ---
const botNames = [
  "cryptoking", "alicewhe", "moonwalker", "whale0x", "satoshifan", 
  "traderjo", "ethmaxi", "bitlord", "deFidegen", "gasmaster", 
  "alphaseeker", "mayami2025", "basegod", "nftcollector", "WAGMIboy"
];

// 1. Bot Function (Recursive with Random Delay)
function triggerRandomBot() {
  // Random delay between 25 and 40 seconds
  const randomDelay = Math.floor(Math.random() * (40000 - 25000 + 1) + 25000);

  setTimeout(() => { 
    if (gameState.status === 'ACTIVE') {
       const randomBot = botNames[Math.floor(Math.random() * botNames.length)];
       const timeLeft = gameState.endTime - Date.now();

       // 🧠 SMART BOT: Only adds 10s if time is < 5s
       if (timeLeft < 5000 && timeLeft > 0) {
           gameState.endTime += 10000;
           console.log("🤖 Bot saved the game! +10s");
       }

       // Bot Bids
       gameState.jackpot += 1.00;
       const newBid = { id: Date.now(), user: randomBot + "@bot.com", amount: 1.00, time: new Date() };
       
       gameState.history.unshift(newBid);
       if (gameState.history.length > 50) gameState.history.pop();
       
       io.emit('gameState', gameState);
    }
    triggerRandomBot(); // Schedule next bid
  }, randomDelay);
}
// Start Bots
triggerRandomBot();

// 2. Main Game Loop (Handles Time & Saving Winners)
setInterval(async () => {
  const now = Date.now();

  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      // --- 🛑 GAME OVER ---
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; // 15s Break

      // 🏆 WINNER LOGIC
      if (gameState.history.length > 0) {
         const lastBid = gameState.history[0];
         
         // A. Create Winner Entry
         const winnerEntry = {
             user: lastBid.user,
             amount: gameState.jackpot,
             time: now
         };
         
         // B. Add to Local List (For Dashboard)
         if (!gameState.winners) gameState.winners = [];
         gameState.winners.unshift(winnerEntry);
         if (gameState.winners.length > 5) gameState.winners.pop();

         console.log(`🏆 WINNER: ${lastBid.user} won $${gameState.jackpot}`);

         // C. SAVE TO DATABASE (Supabase) 💾
         // Only save if it's a REAL user (not a bot)
         if (!lastBid.user.includes("@bot.com")) {
             try {
                // 1. Get current user balance
                const { data: userData } = await supabase
                    .from('users')
                    .select('balance')
                    .eq('email', lastBid.user)
                    .single();

                if (userData) {
                    const newBalance = userData.balance + gameState.jackpot;
                    
                    // 2. Update Balance in DB
                    await supabase
                        .from('users')
                        .update({ balance: newBalance })
                        .eq('email', lastBid.user);
                        
                    console.log(`✅ Database Updated: ${lastBid.user} now has $${newBalance}`);
                }
             } catch (err) {
                 console.error("❌ Database Save Error:", err);
             }
         }
         
         // Save the Game State
         saveGameToDB(); 
      }
      io.emit('gameState', gameState);
    }
  } 
  else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      // --- 🔄 RESTART GAME ---
      gameState.status = 'ACTIVE';
      gameState.jackpot = 50.00; // Reset Jackpot
      gameState.endTime = now + 60000; // 60s new round
      gameState.history = [];
      gameState.lastBidder = null;
      
      // Clear tracking if it exists
      if (typeof currentRoundBidders !== 'undefined') {
          currentRoundBidders.clear();
          currentRoundBidCount = 0;
      }
      
      saveGameToDB(); // Save reset state
      io.emit('gameState', gameState);
    }
  }
}, 1000);

server.listen(3001, () => { console.log('SERVER RUNNING 🚀'); });

