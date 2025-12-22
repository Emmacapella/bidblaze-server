const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const { ethers } = require('ethers');
const cors = require('cors');

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
  // 🏆 PRE-FILLED WINNERS (For visual test)
  winners: [
      { user: "Whale0x@bot.com", amount: 142.00, time: Date.now() - 100000 },
      { user: "SatoshiFan@bot.com", amount: 89.00, time: Date.now() - 500000 },
      { user: "CryptoKing@bot.com", amount: 210.50, time: Date.now() - 900000 }
  ],
  connectedUsers: 0,
  restartTimer: 0
};

// Track unique players for Refund Rule
let currentRoundBidders = new Set();

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

    // 95% to Jackpot, 5% to House
    gameState.jackpot += 0.95; 
    gameState.houseBalance += 0.05;

    currentRoundBidders.add(email);

    // Timer Logic: Only add 10s if under 5s
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

  // 4. 📤 Withdraw Logic (With Telegram Alert)
  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      try {
          if (amount < 10) { socket.emit('withdrawError', 'Min withdrawal is $10'); return; }
          
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!user || user.balance < amount) { socket.emit('withdrawError', 'Insufficient funds'); return; }
          
          // Deduct
          await supabase.from('users').update({ balance: user.balance - amount }).eq('email', email);
          
          // Save
          const { error } = await supabase.from('withdrawals').insert([
            { user_email: email, amount: amount, address: address, status: 'pending' }
          ]);
          
          if (error) throw error;

          // ... inside your successful withdrawal logic ...

          // 🔔 SEND TELEGRAM ALERT (New Method)
          const alertMsg = `💰 *NEW WITHDRAWAL REQUEST*\n\n👤 User: ${email}\n💵 Amount: $${amount}\n🏦 Address: \`${address}\`\n\n_Check Supabase to approve._`;
          
          sendTelegramAlert(alertMsg); // <--- USE THE NEW FUNCTION HERE

          // ... continue with socket.emit success ...

          // Success Response
          socket.emit('balanceUpdate', user.balance - amount);
          socket.emit('withdrawSuccess', 'Request Sent!');
          
          const { data: history } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', history);

      } catch (e) { 
          console.error(e); 
          socket.emit('withdrawError', 'Server Error processing withdrawal');
      }
  });

  // 5. 🆕 Get Withdrawal History (Listener)
  socket.on('getWithdrawals', async (email) => {
      const { data } = await supabase
          .from('withdrawals')
          .select('*')
          .eq('user_email', email)
          .order('created_at', { ascending: false });
      
      if (data) socket.emit('withdrawalHistory', data);
  });

  // 6. Admin
  socket.on('adminAction', (data) => {
    if (data.password !== '1234') return; 
    if (data.action === 'RESET') {
        gameState.status = 'ACTIVE';
        gameState.jackpot = 0.00; // Reset to 0
        gameState.endTime = Date.now() + (299 * 1000);
        io.emit('gameState', gameState);
        saveGameToDB();
    }
  });

  socket.on('disconnect', () => {
    gameState.connectedUsers--;
    io.emit('gameState', gameState);
  });
});

// --- 🤖 SMART BOTS ---
const botNames = ["CryptoKing", "Alice_W", "MoonWalker", "Whale0x", "SatoshiFan", "TraderJo", "EthMaxi", "BitLord", "DeFi_Degen", "GasMaster", "AlphaSeeker", "HODL_2025", "BaseGod", "NFT_Collector", "WAGMI_Boy"];

function triggerRandomBot() {
  const randomDelay = Math.floor(Math.random() * (40000 - 25000 + 1) + 25000); 

  setTimeout(() => {
    if (gameState.status === 'ACTIVE') {
       const randomBot = botNames[Math.floor(Math.random() * botNames.length)];
       const timeLeft = gameState.endTime - Date.now();

       if (timeLeft < 5000 && timeLeft > 0) gameState.endTime += 10000;

       gameState.jackpot += 0.95;
       gameState.houseBalance += 0.05;

       const newBid = { id: Date.now(), user: randomBot + "@bot.com", amount: 1.00, time: new Date() };
       gameState.history.unshift(newBid);
       if (gameState.history.length > 50) gameState.history.pop();
       
       currentRoundBidders.add(randomBot + "@bot.com");
       
       io.emit('gameState', gameState);
    }
    triggerRandomBot();
  }, randomDelay);
}
triggerRandomBot();

// --- ⚡ MAIN GAME LOOP ---
setInterval(async () => {
  const now = Date.now();

  if (gameState.status === 'ACTIVE') {
    if (now >= gameState.endTime) {
      // GAME OVER
      gameState.status = 'ENDED';
      gameState.restartTimer = now + 15000; 

      // 🛑 REFUND RULE
      if (currentRoundBidders.size < 2 && gameState.history.length > 0) {
          console.log("⚠️ Refund: Not enough players.");
          const lastBidder = gameState.history[0].user;
          if (!lastBidder.includes("@bot.com")) {
              const { data: user } = await supabase.from('users').select('balance').eq('email', lastBidder).single();
              const refundAmt = gameState.history.filter(b => b.user === lastBidder).length * 1.00;
              if (user) await supabase.from('users').update({ balance: user.balance + refundAmt }).eq('email', lastBidder);
          }
          gameState.jackpot = 0.00; 
      } 
      // 🏆 NORMAL WIN
      else if (gameState.history.length > 0) {
         const lastBid = gameState.history[0];
         const winnerEntry = { user: lastBid.user, amount: gameState.jackpot, time: now };
         
         gameState.winners.unshift(winnerEntry);
         if (gameState.winners.length > 5) gameState.winners.pop();

         // Pay User
         if (!lastBid.user.includes("@bot.com")) {
             const { data: userData } = await supabase.from('users').select('balance').eq('email', lastBid.user).single();
             if (userData) await supabase.from('users').update({ balance: userData.balance + gameState.jackpot }).eq('email', lastBid.user);
         }
         saveGameToDB();
      }
      io.emit('gameState', gameState);
    }
  } 
  else if (gameState.status === 'ENDED') {
    if (now >= gameState.restartTimer) {
      gameState.status = 'ACTIVE';
      gameState.jackpot = 0.00;
      gameState.endTime = now + (299 * 1000);
      gameState.history = [];
      gameState.lastBidder = null;
      currentRoundBidders.clear();
      
      saveGameToDB();
      io.emit('gameState', gameState);
    }
  }
}, 1000);
// --- 🧪 DEBUG: TEST DATABASE CONNECTION ---
async function testDatabase() {
  console.log("🧪 TESTING DATABASE WRITE...");
  const { data, error } = await supabase.from('withdrawals').insert([
    { 
      user_email: 'test@admin.com', // OR 'email' if your column is named 'email'
      amount: 10.00, 
      address: '0xTestAddress', 
      status: 'DEBUG_TEST' 
    }
  ]);
  
  if (error) {
    console.error("❌ DATABASE WRITE FAILED:", error.message);
    console.error("👉 Check your Column Names and RLS Policies!");
  } else {
    console.log("✅ DATABASE WRITE SUCCESS! The problem is in the Socket Event.");
  }
}
testDatabase(); // Run immediately on start
// --- 🤖 KEEPALIVE BOT (Bulletproof Version) ---
const PING_URL = "https://bidblaze.onrender.com"; 

setInterval(() => {
    console.log(`[BOT] ⏰ Pinging server to keep awake...`);
    
    https.get(PING_URL, (res) => {
        console.log(`[BOT] ✅ Server responded with status: ${res.statusCode}`);
    }).on('error', (e) => {
        console.error(`[BOT] ❌ Ping failed: ${e.message}`);
    });

}, 300000); // Runs every 5 minutes

// --- 📨 TELEGRAM FUNCTION (Paste at the bottom of index.js) ---
function sendTelegramAlert(message) {
    const token = process.env.TELEGRAM_TOKEN;
    const chatId = process.env.MY_CHAT_ID;
    
    // Safety check: Don't crash if keys are missing
    if (!token || !chatId) {
        console.log("⚠️ Telegram keys missing. Skipping alert.");
        return;
    }

    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${token}/sendMessage?chat_id=${chatId}&text=${text}&parse_mode=Markdown`;
    
    const https = require('https');
    https.get(url, (res) => {
        // Just silently succeed
    }).on('error', (e) => {
        console.error(`Telegram Error: ${e.message}`);
    });
}

server.listen(3001, () => { console.log('SERVER RUNNING 🚀'); });

