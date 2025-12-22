const path = require('path'); // ✅ Fixed: lowercase 'const'
const express = require('express');
const http = require('http');
const https = require('https'); 
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// --- ⚙️ CONFIGURATION ---
const app = express();
app.use(cors());

// --- 📂 SERVE WEBSITE FILES ---
// This tells the server to look for the 'dist' folder created by Vite
app.use(express.static(path.join(__dirname, 'dist')));

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// ⚠️ CREDENTIALS 
// (For security, try to use Render Environment Variables for these!)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; 
const MY_CHAT_ID = process.env.MY_CHAT_ID;

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// --- 🤖 KEEP-ALIVE BOT ---
const PING_URL = "https://bidblaze.onrender.com"; 
setInterval(() => {
    // Only ping if the URL is valid
    if (PING_URL) {
        https.get(PING_URL, (res) => {}).on('error', (e) => console.error(`Ping Error: ${e.message}`));
    }
}, 300000); // 5 Minutes

// --- 📨 TELEGRAM HELPER ---
function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !MY_CHAT_ID) return;
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;
    https.get(url, (res) => {}).on('error', (e) => console.error(`Telegram Error: ${e.message}`));
}

// --- 🔌 SOCKET CONNECTION ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', async (email) => {
      if(!email) return;
      socket.join(email); 
      const { data } = await supabase.from('users').select('balance').eq('email', email).single();
      if(data) socket.emit('balanceUpdate', data.balance);
  });

  socket.on('confirmDeposit', async (data) => {
      // Placeholder for future deposit logic
  });

  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      try {
          if (amount < 10) { socket.emit('withdrawError', 'Min withdrawal is $10'); return; }
          
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!user || user.balance < amount) { socket.emit('withdrawError', 'Insufficient funds'); return; }
          
          const newBalance = user.balance - amount;
          await supabase.from('users').update({ balance: newBalance }).eq('email', email);
          
          const { error } = await supabase.from('withdrawals').insert([
            { user_email: email, amount: amount, address: address, status: 'pending' }
          ]);
          
          if (error) throw error;

          // ✅ Fixed truncated strings below
          const alertMsg = `💰 *NEW WITHDRAWAL REQUEST*\n\n👤 User: ${email}\n💵 Amount: $${amount}\n🏦 Address: \`${address}\`\n\n_Check Supabase to approve._`;
          sendTelegramAlert(alertMsg);

          socket.emit('balanceUpdate', newBalance);
          socket.emit('withdrawSuccess', 'Request Sent!');
          
          const { data: history } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', history);

      } catch (e) { 
          console.error("Withdrawal Error:", e.message); 
          socket.emit('withdrawError', 'Server Error');
      }
  });

  socket.on('getWithdrawals', async (email) => {
      const { data } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
      socket.emit('withdrawalHistory', data);
  });
});

// --- 🌍 HANDLE ALL OTHER REQUESTS (Serve index.html) ---
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- 🚀 START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

