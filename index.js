const express = require('express');
const http = require('http');
const https = require('https'); // Used for Telegram & Keep-Alive
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');

// --- ⚙️ CONFIGURATION ---
const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*", 
    methods: ["GET", "POST"]
  }
});

// ⚠️ REPLACE THESE WITH YOUR REAL KEYS (Or use Render Environment Variables)
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'sb_secret_dxJx8Bv-KWIgeVvjJvxZEA_Fzxhsjjz';
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ⚠️ TELEGRAM KEYS (From Render Env Vars)
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN; 
const MY_CHAT_ID = process.env.MY_CHAT_ID;

// --- 🤖 KEEP-ALIVE BOT (Prevents Sleep) ---
const PING_URL = "https://bidblaze.onrender.com"; 
setInterval(() => {
    console.log(`[BOT] ⏰ Pinging server...`);
    https.get(PING_URL, (res) => {
        // Ping success
    }).on('error', (e) => console.error(`Ping Error: ${e.message}`));
}, 300000); // 5 Minutes

// --- 📨 TELEGRAM HELPER FUNCTION ---
function sendTelegramAlert(message) {
    if (!TELEGRAM_TOKEN || !MY_CHAT_ID) {
        console.log("⚠️ Telegram keys missing. Alert skipped.");
        return;
    }
    const text = encodeURIComponent(message);
    const url = `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage?chat_id=${MY_CHAT_ID}&text=${text}&parse_mode=Markdown`;
    
    https.get(url, (res) => {
        // Message sent
    }).on('error', (e) => {
        console.error(`Telegram Error: ${e.message}`);
    });
}

// --- 🔌 SOCKET CONNECTION ---
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // 1. 🟢 Register User
  socket.on('register', async (email) => {
      if(!email) return;
      socket.join(email); 
      // Send current balance
      const { data } = await supabase.from('users').select('balance').eq('email', email).single();
      if(data) socket.emit('balanceUpdate', data.balance);
  });

  // 2. 💰 Confirm Deposit (Manual or Auto)
  socket.on('confirmDeposit', async (data) => {
      const { email, amount, txHash } = data;
      // In a real app, you would verify the hash on-chain here.
      // For now, we trust the client or manual verification.
      
      // Update Balance
      // (You might want to implement better security here later)
      // socket.emit('depositSuccess', 'Deposit received!');
  });

  // 3. 📤 Request Withdrawal
  socket.on('requestWithdrawal', async (data) => {
      const { email, amount, address } = data;
      console.log(`[WITHDRAW] Request from ${email} for $${amount}`);

      try {
          // A. Validate Input
          if (amount < 10) { 
              socket.emit('withdrawError', 'Min withdrawal is $10'); 
              return; 
          }
          
          // B. Check Balance
          const { data: user } = await supabase.from('users').select('balance').eq('email', email).single();
          if (!user || user.balance < amount) { 
              socket.emit('withdrawError', 'Insufficient funds'); 
              return; 
          }
          
          // C. Deduct Balance
          const newBalance = user.balance - amount;
          await supabase.from('users').update({ balance: newBalance }).eq('email', email);
          
          // D. Save to History
          const { error } = await supabase.from('withdrawals').insert([
            { user_email: email, amount: amount, address: address, status: 'pending' }
          ]);
          
          if (error) throw error;

          // E. Send Telegram Alert 🔔
          const alertMsg = `💰 *NEW WITHDRAWAL REQUEST*\n\n👤 User: ${email}\n💵 Amount: $${amount}\n🏦 Address: \`${address}\`\n\n_Check Supabase to approve._`;
          sendTelegramAlert(alertMsg);

          // F. Success Response
          socket.emit('balanceUpdate', newBalance);
          socket.emit('withdrawSuccess', 'Request Sent!');
          
          // G. Refresh History
          const { data: history } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', history);

      } catch (e) { 
          console.error("Withdrawal Error:", e.message); 
          socket.emit('withdrawError', 'Server Error processing withdrawal');
      }
  });

  // 4. 📜 Get History
  socket.on('getWithdrawals', async (email) => {
      const { data } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
      socket.emit('withdrawalHistory', data);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
  });
});

// --- 🚀 START SERVER ---
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

