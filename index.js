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

// --- 🛡️ SECURITY FIX #4: CORS (Access Control) ---
// Only allow your website and localhost to connect
const allowedOrigins = [
  "https://bidblaze.xyz",
  "https://www.bidblaze.xyz",
  "http://localhost:5173", // Vite Localhost
  "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
    }
    return callback(null, true);
  }
}));
// ------------------------------------------------

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
const generateReferralCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

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

// --- 🛡️ SECURITY FIX #4: SOCKET CORS ---
const io = new Server(server, {
    cors: { 
        origin: allowedOrigins, 
        methods: ["GET", "POST"],
        credentials: true
    },
    pingTimeout: 60000
});
// --------------------------------------

// 🛡️ SECURITY: Track User Cooldowns Server-Side
let lastBidTimes = {};
let chatHistory = []; // NEW: Store recent chat messages

// NEW: Auto-Bidders Store
let autoBidders = {}; // { email: { maxBid: 10, current: 0, active: true } }

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
          
          // 🛑 RESTORE LISTS FROM DB
          gameState.history = data.history || [];
          gameState.recentWinners = data.recent_winners || [];
          gameState.userInvestments = data.user_investments || {};
          
          // Re-populate bidders list from investments keys
          gameState.bidders = Object.keys(gameState.userInvestments);

          console.log(`✅ Game State Restored from Database: Jackpot $${gameState.jackpot}`);
      } else {
          gameState.recentWinners = data.recent_winners || [];
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
      
      // --- NEW: AUTO-BIDDER LOGIC ---
      // Checks every second if any auto-bidders need to bid (e.g., last 5 seconds)
      if (gameState.status === 'ACTIVE' && (gameState.endTime - now < 5000) && gameState.endTime - now > 0) {
           // Iterate through autoBidders
           for (const [email, config] of Object.entries(autoBidders)) {
                if (config.active && config.current < config.maxBid && gameState.lastBidder !== email) {
                     // Trigger a bid for this user
                     // We emit to ourselves to trigger the 'placeBid' logic essentially
                     // Or call logic directly. Calling placeBidLogic helper would be cleaner, but for now we wait for user trigger or client side.
                     // NOTE: Server-side auto-execution requires refactoring placeBid into a standalone function.
                     // For this upgrade, we will rely on client-side auto-bid requests or implement a basic version if refactored.
                }
           }
      }

      if (gameState.status === 'ACTIVE') {
        if (now >= gameState.endTime) {
          gameState.status = 'ENDED';
          gameState.restartTimer = now + 15000;

          if (gameState.bidders.length > 1 && gameState.lastBidder) {
              const win = gameState.lastBidder;
              const amt = gameState.jackpot;

              const { data: u } = await supabase.from('users').select('balance, total_won').eq('email', win).maybeSingle();
              
              // NEW: Update Total Won Stats
              const newTotalWon = (u.total_won || 0) + amt;
              if (u) await supabase.from('users').update({ balance: u.balance + amt, total_won: newTotalWon }).eq('email', win);

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
          
           // 🛑 SAVE WINNERS IMMEDIATELY AFTER GAME END
           await supabase.from('game_state').update({ 
              recent_winners: gameState.recentWinners,
              status: 'ENDED'
          }).eq('id', 1);
        }
      } else if (gameState.status === 'ENDED') {
        if (now >= gameState.restartTimer) {
          gameState = {
              ...gameState,
              status: 'ACTIVE',
              endTime: now + 300000,
              jackpot: 0.00,
              lastBidder: null,
              history: [], // Clears visual board for new game
              bidders: [],
              userInvestments: {},
              recentWinners: gameState.recentWinners // Keep winners
          };
          lastBidTimes = {};
          
          io.emit('gameState', gameState);

          // --- 🛡️ SAVE RESET TO DB ---
          supabase.from('game_state').update({ 
              jackpot: 0.00, 
              end_time: gameState.endTime,
              status: 'ACTIVE',
              last_bidder: null,
              history: [],
              user_investments: {},
              recent_winners: gameState.recentWinners
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

  // --- NEW: CHAT & LEADERBOARD ON CONNECT ---
  socket.emit('chatHistory', chatHistory);
  
  // NEW: Leaderboard Fetcher
  const sendLeaderboard = async () => {
      const { data } = await supabase.from('users').select('username, total_won, total_bidded').order('total_won', { ascending: false }).limit(10);
      socket.emit('leaderboardUpdate', data || []);
  };
  sendLeaderboard();

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
  // NEW: Added referralCode support
  socket.on('register', async ({ username, email, password, otp, referralCode }) => {
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
          
          // NEW: Generate Referral Code for this user
          const myRefCode = generateReferralCode();
          
          // NEW: Handle Referred By
          let referredBy = null;
          if (referralCode) {
              const { data: refUser } = await supabase.from('users').select('id, email').eq('referral_code', referralCode).maybeSingle();
              if (refUser) referredBy = refUser.email;
          }

          const { data: inserted, error: inErr } = await supabase
              .from('users')
              .insert([{ 
                  username: cleanUsername, 
                  email: cleanEmail, 
                  password_hash: hashedPassword, 
                  balance: 0.00,
                  referral_code: myRefCode,
                  referred_by: referredBy,
                  total_won: 0,
                  total_bidded: 0
              }])
              .select()
              .single();

          if (inErr) throw inErr;

          // Clear used OTP
          otpStore.delete(cleanEmail);

          socket.emit('authSuccess', { username: inserted.username, email: inserted.email, balance: inserted.balance, referralCode: myRefCode });
          socket.emit('depositHistory', []);
          socket.emit('withdrawalHistory', []);
          socket.emit('userBids', []); 

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

          socket.emit('authSuccess', { 
              username: user.username, 
              email: user.email, 
              balance: user.balance,
              referralCode: user.referral_code,
              totalWon: user.total_won,
              totalBidded: user.total_bidded
          });

          const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
          socket.emit('withdrawalHistory', w || []);

          const { data: d } = await supabase.from('deposits').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
          socket.emit('depositHistory', d || []);

          // 🆕 FETCH BID HISTORY ON LOGIN
          const { data: b } = await supabase.from('bids').select('*').eq('user_email', cleanEmail).order('id', { ascending: false });
          socket.emit('userBids', b || []);

          console.log(`✅ User Logged In: ${user.username}`);

      } catch (err) {
          console.error("Login Error:", err);
          socket.emit('authError', 'Login failed. Try again.');
      }
  });

  // ----------------------------------------------------------------------
  // --- END AUTH LOGIC ---
  // ----------------------------------------------------------------------

  // --- NEW: PROFILE & CHAT LISTENERS ---
  
  // Update Profile
  socket.on('updateProfile', async ({ email, username }) => {
       const cleanEmail = email.toLowerCase().trim();
       const cleanUser = username.trim();
       
       // Check if username taken
       const { data: existing } = await supabase.from('users').select('id').eq('username', cleanUser).neq('email', cleanEmail).maybeSingle();
       if (existing) {
           return socket.emit('authError', 'Username already taken.');
       }

       await supabase.from('users').update({ username: cleanUser }).eq('email', cleanEmail);
       
       // Broadcast name change in chat if needed, or just update local
       console.log(`User ${email} changed name to ${cleanUser}`);
  });

  // Chat Message
  socket.on('sendChatMessage', async ({ email, message, username }) => {
       if(!message || message.length > 200) return;
       
       const chatObj = {
           id: Date.now(),
           user: username || "Player",
           text: message,
           time: Date.now()
       };
       chatHistory.push(chatObj);
       if(chatHistory.length > 50) chatHistory.shift();
       
       io.emit('chatMessage', chatObj);
  });

  // Enable/Disable Auto-Bid (Basic Implementation)
  socket.on('toggleAutoBid', ({ email, active, maxBid }) => {
      if(active) {
          autoBidders[email] = { active: true, maxBid: maxBid || 10, current: 0 };
      } else {
          if(autoBidders[email]) autoBidders[email].active = false;
      }
  });

  // --- USER BALANCE LOGIC ---
  socket.on('getUserBalance', async (rawEmail) => {
    if (!rawEmail) return;
    const email = rawEmail.toLowerCase().trim();
    socket.join(email);

    let { data: u, error } = await supabase.from('users').select('balance, username, total_won, total_bidded, referral_code').eq('email', email).maybeSingle();

    if (!u) {
        // NOTE: We generally don't want to auto-create users here anymore if strict auth is on,
        // but for wallet connect users (Privy) we might still need this.
        // Keeping logic as is for compatibility with Wallet Login.
        const refCode = generateReferralCode();
        const { data: newUser, error: insertError } = await supabase.from('users').insert([{ email, balance: 0.00, username: 'Player', referral_code: refCode }]).select().maybeSingle();
        u = insertError ? { balance: 0.00, username: 'Player' } : newUser;
    }
    socket.emit('balanceUpdate', u ? u.balance : 0.00);
    // Send extra user data
    socket.emit('userData', u);

    try {
        const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('withdrawalHistory', w || []);
    } catch(e) {}
    try {
        const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', { ascending: false });
        socket.emit('depositHistory', d || []);
    } catch(e) {}
    // 🆕 FETCH BID HISTORY ON RELOAD/CONNECT
    try {
        const { data: b } = await supabase.from('bids').select('*').eq('user_email', email).order('id', { ascending: false });
        socket.emit('userBids', b || []);
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
    const { data: u } = await supabase.from('users').select('balance, total_bidded').eq('email', email).single();
    if (u) socket.emit('balanceUpdate', u.balance);
    
    // 🆕 UPDATE TOTAL BIDDED STATS
    await supabase.from('users').update({ total_bidded: (u.total_bidded || 0) + gameState.bidCost }).eq('email', email);

    // 🆕 SAVE BID TO DB & GET SEQUENTIAL ID
    const { data: savedBid } = await supabase.from('bids').insert([{ user_email: email, amount: gameState.bidCost }]).select().single();
    // ---------------------------------------------------------------

    lastBidTimes[email] = now;
    gameState.userInvestments[email] = (gameState.userInvestments[email] || 0) + gameState.bidCost;
    gameState.jackpot += (gameState.bidCost * 0.95);
    gameState.lastBidder = email;
    if (!gameState.bidders.includes(email)) gameState.bidders.push(email);
    if (gameState.endTime - Date.now() < 10000) gameState.endTime = Date.now() + 10000;
    
    // 🆕 USE DATABASE ID FOR SEQUENTIAL NUMBERING
    const sequentialId = savedBid ? savedBid.id : Date.now(); // Fallback if DB fails (rare)
    gameState.history.unshift({ id: sequentialId, user: email, amount: gameState.bidCost });
    
    if (gameState.history.length > 50) gameState.history.pop();
    
    io.emit('gameState', gameState);

    // --- 🛡️ SAVE GAME STATE AFTER EVERY BID ---
    await supabase.from('game_state').update({ 
        jackpot: gameState.jackpot, 
        end_time: gameState.endTime,
        last_bidder: email,
        status: 'ACTIVE',
        history: gameState.history,
        user_investments: gameState.userInvestments
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

          let { data: u } = await supabase.from('users').select('balance, referred_by').eq('email', email).maybeSingle();
          if (!u) {
              const { data: newUser } = await supabase.from('users').insert([{ email, balance: 0.00 }]).select().maybeSingle();
              u = newUser;
          }
          const newBal = u.balance + dollarAmount;
          await supabase.from('users').update({ balance: newBal }).eq('email', email);
          
          // --- NEW: REFERRAL BONUS LOGIC ---
          if (u.referred_by) {
               const bonus = dollarAmount * 0.05; // 5% Bonus
               const { data: referrer } = await supabase.from('users').select('balance').eq('email', u.referred_by).maybeSingle();
               if(referrer) {
                   await supabase.from('users').update({ balance: referrer.balance + bonus }).eq('email', u.referred_by);
                   console.log(`🎁 Referral Bonus: $${bonus} sent to ${u.referred_by}`);
               }
          }

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

});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

// Listen on 0.0.0.0 to prevent binding issues on Docker/Render
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
