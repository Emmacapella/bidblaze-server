// 1. Load Environment Variables
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');
const bcrypt = require('bcryptjs'); // REQUIRED: npm install bcryptjs
const { Resend } = require('resend'); // REQUIRED: npm install resend

// --- CONFIGURATION ---
// ⚠️ If .env is missing, these default strings prevent immediate crashes
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'MISSING_KEY';
const ADMIN_WALLET = process.env.ADMIN_WALLET || '0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY; // Ensure this is in your .env

// --- TELEGRAM CONFIG ---
let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN) {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("Telegram Bot Active");
    } else {
        console.log("Telegram Token missing - Alerts disabled");
    }
} catch (e) {
    console.log("Telegram disabled (Tool missing)");
}

const app = express();
app.use(cors());

// --- CRITICAL: HEALTH CHECK FOR RENDER ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- SUPABASE & RESEND SETUP ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = new Resend(RESEND_API_KEY);

// --- HELPER: TELEGRAM ALERT ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
       .catch(err => console.error("Telegram Error:", err.message));
};

// --- HELPER: OTP GENERATOR & STORE ---
const otpStore = new Map(); // Stores { email: { code, expires } }

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();

const sendEmailOTP = async (email, otp, type) => {
    if (!resend) {
        console.error("❌ Cannot send OTP. RESEND_API_KEY is missing.");
        return false;
    }
    try {
        const subject = type === 'signup' ? 'Welcome to BidBlaze! Verify your Account' : 'BidBlaze Password Reset';
        const html = `
        <div style="font-family: sans-serif; padding: 20px; background: #0f172a; color: white; text-align: center; border-radius: 10px;">
            <h1 style="color: #fbbf24;">BidBlaze</h1>
            <p style="color: #94a3b8;">Your verification code is:</p>
            <h2 style="background: #334155; padding: 10px; letter-spacing: 5px; border-radius: 5px; display: inline-block;">${otp}</h2>
            <p style="color: #64748b; font-size: 12px; margin-top: 20px;">This code expires in 5 minutes.</p>
        </div>
        `;
        
        // 📧 Updated to use your verified domain
        const { data, error } = await resend.emails.send({
            from: 'BidBlaze <Noreply@bidblaze.com>', 
            to: [email],
            subject: subject,
            html: html
        });

        if (error) {
            console.error("❌ Resend API Error:", error);
            return false;
        }

        console.log("✅ Email sent successfully ID:", data.id);
        return true;

    } catch (err) {
        console.error("❌ Unexpected Email Error:", err);
        return false;
    }
};

// --- ROBUST PROVIDER SETUP ---
const getProvider = (networkKey) => {
    const urls = {
        BSC: [
          'https://bsc-dataseed.binance.org/',
          'https://bsc-dataseed1.defibit.io/',
          'https://bsc-dataseed1.ninicoin.io/'
        ],
        ETH: [
          'https://cloudflare-eth.com',
          'https://rpc.ankr.com/eth'
        ],
        BASE: [
          'https://mainnet.base.org',
          'https://1rpc.io/base'
        ]
    };

    const urlList = urls[networkKey];

    try {
        if (ethers.providers && ethers.providers.FallbackProvider) {
            const providers = urlList.map(u => new ethers.providers.JsonRpcProvider(u));
            return new ethers.providers.FallbackProvider(providers, 1);
        }
        if (ethers.JsonRpcProvider) return new ethers.JsonRpcProvider(urlList[0]);
        return new ethers.providers.JsonRpcProvider(urlList[0]);
    } catch (e) {
        console.error(`Provider Error (${networkKey}):`, e.message);
        return null;
    }
};

const providers = {
    BSC: getProvider('BSC'),
    ETH: getProvider('ETH'),
    BASE: getProvider('BASE')
};

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] },
    pingTimeout: 60000
});

// 🛡️ SECURITY: Track User Cooldowns Server-Side
let lastBidTimes = {};

let gameState = {
    status: 'ACTIVE',
    endTime: Date.now() + 300000,
    jackpot: 0.00,
    bidCost: 1.00,
    lastBidder: null,
    history: [],
    recentWinners: [],
    connectedUsers: 0,
    restartTimer: null,
    bidders: [],
    userInvestments: {}
};

// --- 🛡️ CRITICAL: RESTORE GAME STATE FROM DB ON STARTUP ---
async function loadGameState() {
  try {
    const { data } = await supabase.from('game_state').select('*').eq('id', 1).maybeSingle();
    
    if (data) {
      if (parseInt(data.end_time) > Date.now()) {
          gameState.jackpot = parseFloat(data.jackpot);
          gameState.endTime = parseInt(data.end_time);
          gameState.status = data.status;
          gameState.lastBidder = data.last_bidder;
          console.log(`✅ Game State Restored from Database: Jackpot $${gameState.jackpot}`);
      } else {
          console.log("ℹ️ Saved game expired, starting fresh.");
      }
    }
  } catch (e) {
    console.error("Failed to load game state:", e);
  }
}
loadGameState(); 
// -----------------------------------------------------------

// --- GAME LOOP (CRASH PROTECTED) ---
setInterval(async () => {
  try {
      const now = Date.now();
      if (gameState.status === 'ACTIVE') {
        if (now >= gameState.endTime) {
          gameState.status = 'ENDED';
          gameState.restartTimer = now + 15000;

          if (gameState.bidders.length > 1 && gameState.lastBidder) {
              const win = gameState.lastBidder;
              const amt = gameState.jackpot;

              const { data: u } = await supabase.from('users').select('balance').eq('email', win).maybeSingle();
              if (u) await supabase.from('users').update({ balance: u.balance + amt }).eq('email', win);

              gameState.recentWinners.unshift({ user: win, amount: amt, time: Date.now() });
              if (gameState.recentWinners.length > 5) gameState.recentWinners.pop();

              sendTelegram(`🎉 *JACKPOT WON!*\nUser: \`${win}\`\nAmount: $${amt.toFixed(2)}`);

          } else if (gameState.bidders.length === 1 && gameState.lastBidder) {
              const solePlayer = gameState.lastBidder;
              const refundAmount = gameState.userInvestments[solePlayer] || 0;

              if (refundAmount > 0) {
                  const { data: u } = await supabase.from('users').select('balance').eq('email', solePlayer).maybeSingle();
                  if (u) {
                      await supabase.from('users').update({ balance: u.balance + refundAmount }).eq('email', solePlayer);
                      sendTelegram(`♻️ *REFUND*\nUser: \`${solePlayer}\`\nAmt: $${refundAmount.toFixed(2)}`);
                  }
              }
          }
        }
      } else if (gameState.status === 'ENDED') {
        if (now >= gameState.restartTimer) {
          gameState = {
              ...gameState,
              status: 'ACTIVE',
              endTime: now + 300000,
              jackpot: 0.00,
              lastBidder: null,
              history: [],
              bidders: [],
              userInvestments: {}
          };
          lastBidTimes = {};
          
          io.emit('gameState', gameState);

          // --- 🛡️ SAVE RESET TO DB ---
          supabase.from('game_state').update({ 
              jackpot: 0.00, 
              end_time: gameState.endTime,
              status: 'ACTIVE',
              last_bidder: null
          }).eq('id', 1).then();
          // ---------------------------
        }
      }
      io.emit('gameState', gameState);
  } catch (loopError) {
      console.error("Game Loop Hiccup (Prevented Crash):", loopError.message);
  }
}, 1000);

io.on('connection', (socket) => {
  // --- 🛡️ ANTI-SPAM RATE LIMITER ---
  let messageCount = 0;
  const rateLimitInterval = setInterval(() => { messageCount = 0; }, 1000);

  socket.use((packet, next) => {
      messageCount++;
      if (messageCount > 20) {
          socket.disconnect(true);
          console.log(`Kicked spammer: ${socket.id}`);
          clearInterval(rateLimitInterval);
          return;
      }
      next();
  });

  socket.on('disconnect', () => {
      clearInterval(rateLimitInterval);
      gameState.connectedUsers--;
  });

  gameState.connectedUsers++;

  socket.on('getGameConfig', () => {
      socket.emit('gameConfig', { adminWallet: ADMIN_WALLET });
  });

  // ----------------------------------------------------------------------
  // --- 🔐 AUTHENTICATION & OTP LOGIC (EDITED) ---
  // ----------------------------------------------------------------------

  // 1. REQUEST SIGNUP OTP
  socket.on('requestSignupOtp', async ({ email }) => {
      if (!email) return socket.emit('authError', 'Email is required.');
      const cleanEmail = email.toLowerCase().trim();

      // Check if user already exists
      const { data: existingUser } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
      if (existingUser) {
          return socket.emit('authError', 'Email is already registered. Please login.');
      }

      const otp = generateOTP();
      otpStore.set(cleanEmail, { code: otp, expires: Date.now() + 300000 }); // 5 mins

      const sent = await sendEmailOTP(cleanEmail, otp, 'signup');
      if (sent) {
          socket.emit('signupOtpSent');
          console.log(`OTP sent to ${cleanEmail}`);
      } else {
          socket.emit('authError', 'Failed to send OTP. Check server logs.');
      }
  });

  // 2. COMPLETE REGISTRATION (Verify OTP)
  socket.on('register', async ({ username, email, password, otp }) => {
      if (!username || !email || !password || !otp) {
          socket.emit('authError', 'All fields and OTP are required.');
          return;
      }
      const cleanEmail = email.toLowerCase().trim();
      const cleanUsername = username.trim();

      // Verify OTP
      const storedOtp = otpStore.get(cleanEmail);
      if (!storedOtp || storedOtp.code !== otp) {
          return socket.emit('authError', 'Invalid or expired OTP.');
      }
      if (Date.now() > storedOtp.expires) {
          otpStore.delete(cleanEmail);
          return socket.emit('authError', 'OTP has expired.');
      }

      // Existing Validation Logic
      const usernameRegex = /^[a-zA-Z0-9]+$/;
      if (!usernameRegex.test(cleanUsername)) {
          socket.emit('authError', 'Username must contain only letters and numbers.');
          return;
      }
      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/;
      if (!passwordRegex.test(password)) {
          socket.emit('authError', 'Password must be 8+ characters, with at least 1 uppercase, 1 lowercase, and 1 special character.');
          return;
      }

      try {
          // Double check existence (race condition check)
          const { data: existingEmailUser } = await supabase.from('users').select('*').eq('email', cleanEmail).maybeSingle();
          if (existingEmailUser) {
              socket.emit('authError', 'Email already registered.');
              return;
          }
          const { data: existingUsernameUser } = await supabase.from('users').select('id').eq('username', cleanUsername).maybeSingle();
          if (existingUsernameUser) {
               socket.emit('authError', 'Username is already taken.');
               return;
          }

          const hashedPassword = await bcrypt.hash(password, 10);

          const { data: inserted, error: inErr } = await supabase
              .from('users')
              .insert([{ username: cleanUsername, email: cleanEmail, password_hash: hashedPassword, balance: 0.00 }])
              .select()
              .single();

          if (inErr) throw inErr;

          // Clear used OTP
          otpStore.delete(cleanEmail);

          socket.emit('authSuccess', { username: inserted.username, email: inserted.email, balance: inserted.balance });
          socket.emit('depositHistory', []);
          socket.emit('withdrawalHistory', []);

          console.log(`🆕 User Verified & Registered: ${inserted.username}`);

      } catch (err) {
          console.error("Registration Error:", err);
          socket.emit('authError', 'Registration failed. Database error.');
      }
  });

  // 3. REQUEST PASSWORD RESET OTP
  socket.on('requestResetOtp', async ({ email }) => {
      if (!email) return socket.emit('authError', 'Email is required.');
      const cleanEmail = email.toLowerCase().trim();

      // Check if user exists
      const { data: user } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
      if (!user) {
          return socket.emit('authError', 'No account found with this email.');
      }

      const otp = generateOTP();
      otpStore.set(cleanEmail, { code: otp, expires: Date.now() + 300000 });

      const sent = await sendEmailOTP(cleanEmail, otp, 'reset');
      if (sent) {
          socket.emit('resetOtpSent');
      } else {
          socket.emit('authError', 'Failed to send reset email.');
      }
  });

  // 4. COMPLETE PASSWORD RESET
  socket.on('resetPassword', async ({ email, otp, newPassword }) => {
      if (!email || !otp || !newPassword) return socket.emit('authError', 'Missing fields.');
      const cleanEmail = email.toLowerCase().trim();

      const storedOtp = otpStore.get(cleanEmail);
      if (!storedOtp || storedOtp.code !== otp) {
          return socket.emit('authError', 'Invalid or expired OTP.');
      }

      const passwordRegex = /^(?=.*[a-z])(?=.*[A-Z])(?=.*[\W_]).{8,}$/;
      if (!passwordRegex.test(newPassword)) {
          socket.emit('authError', 'Password weak: 8+ chars, 1 Upper, 1 Lower, 1 Special.');
          return;
      }

      try {
          const hashedPassword = await bcrypt.hash(newPassword, 10);

          const { error } = await supabase
              .from('users')
              .update({ password_hash: hashedPassword })
              .eq('email', cleanEmail);

          if (error) throw error;

          otpStore.delete(cleanEmail);
          socket.emit('resetSuccess');
          console.log(`🔐 Password reset for: ${cleanEmail}`);

      } catch (err) {
          console.error("Reset Error:", err);
          socket.emit('authError', 'Database error during reset.');
      }
  });

  // --- LOGIN (Standard) ---
  socket.on('login', async ({ email, password }) => {
      if (!email || !password) { socket.emit('authError', 'Email and password required.'); return; }
      const cleanEmail = email.toLowerCase().trim();

      try {
          const { data: user, error } = await supabase.from('users').select('*').eq('email', cleanEmail).maybeSingle();

          if (error) { socket.emit('authError', 'System error.'); return; }
          if (!user) { socket.emit('authError', 'User does not exist.'); return; }

          const isPasswordValid = user.password_hash && (await bcrypt.compare(password, user.password_hash));
          if (!isPasswordValid) { socket.emit('authError', 'Incorrect password.'); return; }

          socket.emit('authSuccess', { username: user.username, email: user.email, balance: user.balance });

          const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', w || []);

          const { data: d } = await supabase.from('deposits').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
          socket.emit('depositHistory', d || []);

          console.log(`✅ User Logged In: ${user.username}`);

      } catch (err) {
          console.error("Login Error:", err);
          socket.emit('authError', 'Login failed. Try again.');
      }
  });

  // ----------------------------------------------------------------------
  // --- END AUTH LOGIC ---
  // ----------------------------------------------------------------------

  // --- USER BALANCE LOGIC ---
  socket.on('getUserBalance', async (rawEmail) => {
    if (!rawEmail) return;
    const email = rawEmail.toLowerCase().trim();
    socket.join(email);

    let { data: u, error } = await supabase.from('users').select('balance, username').eq('email', email).maybeSingle();

    if (!u) {
        // NOTE: We generally don't want to auto-create users here anymore if strict auth is on,
        // but for wallet connect users (Privy) we might still need this.
        // Keeping logic as is for compatibility with Wallet Login.
        const { data: newUser, error: insertError } = await supabase.from('users').insert([{ email, balance: 0.00, username: 'Player' }]).select().maybeSingle();
        u = insertError ? { balance: 0.00, username: 'Player' } : newUser;
    }
    socket.emit('balanceUpdate', u ? u.balance : 0.00);

    try {
        const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('withdrawalHistory', w || []);
    } catch(e) {}
    try {
        const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('depositHistory', d || []);
    } catch(e) {}
  });

  // --- BID LOGIC ---
  socket.on('placeBid', async (rawEmail) => {
    if (gameState.status !== 'ACTIVE') return;
    const email = rawEmail.toLowerCase().trim();
    const now = Date.now();
    if (now - (lastBidTimes[email]||0) < 500) return;

    // --- 🛡️ SECURE ATOMIC TRANSACTION (Prevents Race Conditions) ---
    const { data: success, error } = await supabase.rpc('deduct_balance', { 
        user_email: email, 
        amount: gameState.bidCost 
    });

    if (error || !success) { 
        socket.emit('bidError', 'Insufficient Funds'); 
        return; 
    }
    
    // Fetch updated balance to show user immediately
    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (u) socket.emit('balanceUpdate', u.balance);
    // ---------------------------------------------------------------

    lastBidTimes[email] = now;
    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;
    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    gameState.history.unshift({ id: Date.now(), user: email, amount: gameState.bidCost });
    if (gameState.history.length > 50) gameState.history.pop();
    
    io.emit('gameState', gameState);

    // --- 🛡️ SAVE GAME STATE AFTER EVERY BID ---
    await supabase.from('game_state').update({ 
        jackpot: gameState.jackpot, 
        end_time: gameState.endTime,
        last_bidder: email,
        status: 'ACTIVE'
    }).eq('id', 1);
    // ------------------------------------------
  });

  // --- DEPOSIT LOGIC ---
  socket.on('verifyDeposit', async ({ email: rawEmail, txHash, network }) => {
      const email = rawEmail.toLowerCase().trim();
      try {
          const provider = providers[network];
          if (!provider) { socket.emit('depositError', 'Invalid Network Provider'); return; }
          const tx = await provider.waitForTransaction(txHash, 1, 60000);
          if (!tx) { socket.emit('depositError', 'Verification Timed Out'); return; }
          const txDetails = await provider.getTransaction(txHash);
          if (!txDetails || txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) { socket.emit('depositError', 'Funds sent to wrong address'); return; }

          const formatEther = ethers.formatEther || ethers.utils.formatEther;
          const rawAmt = parseFloat(formatEther(txDetails.value));
          if (rawAmt <= 0) { socket.emit('depositError', 'Zero amount detected'); return; }

          let rate = network === 'BSC' ? 600 : 3000;
          const dollarAmount = rawAmt * rate;

          const { error: insertError } = await supabase.from('deposits').insert([{
              user_email: email, amount: dollarAmount, network, tx_hash: txHash, status: 'COMPLETED'
          }]);

          if (insertError) {
              if (insertError.code === '23505') socket.emit('depositError', 'Transaction already claimed!');
              else socket.emit('depositError', 'Database Error');
              return;
          }

          let { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
          if (!u) {
              const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().maybeSingle();
              u = newUser;
          }
          const newBal = u.balance + dollarAmount;
          await supabase.from('users').update({ balance: newBal }).eq('email', email);
          socket.emit('depositSuccess', newBal);
          socket.emit('balanceUpdate', newBal);
          sendTelegram(`💰 *DEPOSIT SUCCESS*\nUser: \`${email}\`\nAmt: $${dollarAmount.toFixed(2)}`);
      } catch (e) { socket.emit('depositError', 'Server Error'); }
  });

  // --- WITHDRAWAL LOGIC ---
  socket.on('requestWithdrawal', async ({ email: rawEmail, amount, address, network }) => {
      try {
          const email = rawEmail.toLowerCase().trim();
          const { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
          if (!u || u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Balance'); return; }

          const { error: updateError } = await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
          if (updateError) throw updateError;

          const { error: insertError } = await supabase.from('withdrawals').insert([{
              user_email: email, amount, wallet_address: address, network, status: 'PENDING'
          }]);

          if (insertError) {
              await supabase.from('users').update({ balance: u.balance }).eq('email', email);
              throw insertError;
          }
          socket.emit('withdrawalSuccess', u.balance - amount);
          socket.emit('balanceUpdate', u.balance - amount);
          sendTelegram(`💸 *WITHDRAWAL*\nUser: \`${email}\`\nAmt: $${amount}\nAddr: \`${address}\``);
      } catch (e) { socket.emit('withdrawalError', 'Withdrawal System Error'); }
  });

  socket.on('adminAction', ({ password, action, value }) => {
     if (action === 'RESET') {
         gameState = { ...gameState, status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 50.00, history: [], bidders: [], userInvestments: {} };
         io.emit('gameState', gameState);
     }
  });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// Listen on 0.0.0.0 to prevent binding issues on Docker/Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
