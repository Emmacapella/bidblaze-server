const path = require('path');
const express = require('express');
const http = require('http');
const https = require('https');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// ✅ USE ENV VARIABLES ONLY (IMPORTANT FOR RENDER)
const SUPABASE_URL = 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = "sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TELEGRAM_TOKEN = "8480583530:AAGQgDDbiukiOIBgkP3tjJRU-hdhWCgvGhI";
const MY_CHAT_ID = "6571047127";

// --- KEEP ALIVE ---
const PING_URL = "https://bidblaze.onrender.com";
setInterval(() => {
  https.get(PING_URL).on('error', () => {});
}, 300000);

// --- TELEGRAM ---
function sendTelegramAlert(message) {
  if (!TELEGRAM_TOKEN || !MY_CHAT_ID) return;

  const text = encodeURIComponent(message);
  const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;

  https.get(url).on('error', () => {});
}

// --- SOCKET.IO ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('register', async (email) => {
    if (!email) return;
    socket.join(email);

    const { data } = await supabase
      .from('users')
      .select('balance')
      .eq('email', email)
      .single();

    if (data) socket.emit('balanceUpdate', data.balance);
  });

  socket.on('requestWithdrawal', async ({ email, amount, address }) => {
    try {
      if (amount < 10) {
        socket.emit('withdrawError', 'Min withdrawal is $10');
        return;
      }

      const { data: user } = await supabase
        .from('users')
        .select('balance')
        .eq('email', email)
        .single();

      if (!user || user.balance < amount) {
        socket.emit('withdrawError', 'Insufficient funds');
        return;
      }

      const newBalance = user.balance - amount;

      await supabase
        .from('users')
        .update({ balance: newBalance })
        .eq('email', email);

      await supabase.from('withdrawals').insert([
        { user_email: email, amount, address, status: 'pending' }
      ]);

      const alertMsg =
`💰 *NEW WITHDRAWAL REQUEST*
👤 User: ${email}
💵 Amount: $${amount}
🏦 Address: ${address}`;

      sendTelegramAlert(alertMsg);

      socket.emit('balanceUpdate', newBalance);
      socket.emit('withdrawSuccess', 'Request Sent!');

      const { data: history } = await supabase
        .from('withdrawals')
        .select('*')
        .eq('user_email', email)
        .order('created_at', { ascending: false });

      socket.emit('withdrawalHistory', history);

    } catch (err) {
      console.error(err);
      socket.emit('withdrawError', 'Server error');
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// --- SERVE FRONTEND ---
app.use(express.static(path.join(__dirname, 'dist')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'));
});

// --- START ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

