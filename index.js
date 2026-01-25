// 1. Load Environment Variables
require('dotenv').config();

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
const { ethers } = require('ethers');
const bcrypt = require('bcryptjs'); 
const { Resend } = require('resend'); 

// --- CONFIGURATION ---
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://zshodgjnjqirmcqbzujm.supabase.co';
const SUPABASE_KEY = process.env.SUPABASE_KEY || 'MISSING_KEY';
const ADMIN_WALLET = process.env.ADMIN_WALLET || '0x6edadf13a704cd2518cd2ca9afb5ad9dee3ce34c';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const RESEND_API_KEY = process.env.RESEND_API_KEY;

// --- TELEGRAM CONFIG (RESTORED FROM OLD CODE) ---
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

// --- CORS (RESTORED FROM OLD CODE) ---
const allowedOrigins = [
  "https://bidblaze.xyz",
  "https://www.bidblaze.xyz",
  "http://localhost:5173", 
  "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      return callback(new Error('The CORS policy for this site does not allow access from the specified Origin.'), false);
    }
    return callback(null, true);
  }
}));

// --- HEALTH CHECK ---
app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

// --- SUPABASE & RESEND SETUP ---
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = new Resend(RESEND_API_KEY);

// --- HELPER: TELEGRAM ALERT (RESTORED) ---
const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' })
        .catch(err => console.error("Telegram Error:", err.message));
};

// --- HELPER: OTP GENERATOR & STORE ---
const otpStore = new Map(); 

const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateReferralCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

// --- EMAIL OTP LOGIC (RESTORED FROM OLD CODE) ---
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
        const { data, error } = await resend.emails.send({
            from: 'BidBlaze <noreply@bidblaze.xyz>', 
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
        BSC: ['https://bsc-dataseed.binance.org/', 'https://bsc-dataseed1.defibit.io/', 'https://bsc-dataseed1.ninicoin.io/'],
        ETH: ['https://cloudflare-eth.com', 'https://rpc.ankr.com/eth'],
        BASE: ['https://mainnet.base.org', 'https://1rpc.io/base']
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
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000
});

// --------------------------------------
// 🎮 MULTI-ROOM GAME STATE LOGIC
// --------------------------------------

const ROOM_CONFIG = {
    'low': { id: 1, name: 'Novice', cost: 0.10, dbId: 1 },
    'high': { id: 2, name: 'High Roller', cost: 1.00, dbId: 2 }
};

let roomStates = {
    low: createInitialState(0.10),
    high: createInitialState(1.00)
};

function createInitialState(cost) {
    return {
        status: 'ACTIVE',
        endTime: Date.now() + 300000,
        jackpot: 0.00,
        bidCost: cost,
        lastBidder: null,
        history: [],
        recentWinners: [],
        restartTimer: null,
        bidders: [],
        userInvestments: {}
    };
}

let lastBidTimes = {}; 
let chatHistory = []; 
let autoBidders = {}; 
let connectedUserCount = 0;

const BOT_ALIASES = [
    "CryptoKing", "MoonBoi_99", "Satoshi_V", "Eth_Whale", "BidSniper",
    "LamboSoon", "DiamondHands", "Alpha_Wolf", "Trader_X", "NFT_God"
];

// --- LOAD STATE FROM DB FOR BOTH ROOMS ---
async function loadGameStates() {
    try {
        await loadSingleRoom('low', 1);
        await loadSingleRoom('high', 2);
    } catch (e) {
        console.error("Failed to load game states:", e);
    }
}

async function loadSingleRoom(roomKey, dbId) {
    const { data } = await supabase.from('game_state').select('*').eq('id', dbId).maybeSingle();
    if (data) {
        const state = roomStates[roomKey];
        if (parseInt(data.end_time) > Date.now()) {
            state.jackpot = parseFloat(data.jackpot);
            state.endTime = parseInt(data.end_time);
            state.status = data.status;
            state.lastBidder = data.last_bidder;
            state.history = data.history || [];
            state.recentWinners = data.recent_winners || [];
            state.userInvestments = data.user_investments || {};
            state.bidders = Object.keys(state.userInvestments);
            console.log(`✅ Room ${roomKey} Restored: Jackpot $${state.jackpot}`);
        } else {
            state.recentWinners = data.recent_winners || [];
            console.log(`ℹ️ Room ${roomKey} expired, starting fresh.`);
        }
    }
}
loadGameStates();

// --- EXECUTE BID (ROOM AWARE) ---
async function executeBid(email, roomKey, isAutoBid = false) {
    const state = roomStates[roomKey];
    if (!state || state.status !== 'ACTIVE') return false;

    const now = Date.now();
    const lastBid = lastBidTimes[email] || 0;
    if (now - lastBid < 8000) return false; 

    // 1. Deduct Balance
    const { data: success, error } = await supabase.rpc('deduct_balance', {
        user_email: email,
        amount: state.bidCost
    });

    if (error || !success) return false;

    // 2. Update Stats
    const { data: u } = await supabase.from('users').select('balance, total_bidded').eq('email', email).single();
    if (u) {
        io.to(email).emit('balanceUpdate', u.balance);
        await supabase.from('users').update({ total_bidded: (u.total_bidded || 0) + state.bidCost }).eq('email', email);
    }

    // 3. Record Bid
    const { data: savedBid } = await supabase.from('bids').insert([{ 
        user_email: email, 
        amount: state.bidCost,
        // room_id: roomKey // Only if you added room_id column
    }]).select().single();

    // 4. Alias Logic
    let displayUser = email;
    if (isAutoBid) {
        const randomAlias = BOT_ALIASES[Math.floor(Math.random() * BOT_ALIASES.length)];
        displayUser = randomAlias;
    }

    lastBidTimes[email] = now;
    state.userInvestments[email] = (state.userInvestments[email] || 0) + state.bidCost;
    state.jackpot += (state.bidCost * 0.95);
    state.lastBidder = displayUser;
    if (!state.bidders.includes(email)) state.bidders.push(email);

    if (state.endTime - Date.now() < 10000) state.endTime = Date.now() + 10000;

    const sequentialId = savedBid ? savedBid.id : Date.now();
    state.history.unshift({ id: sequentialId, user: displayUser, amount: state.bidCost });
    if (state.history.length > 30) state.history.pop();

    io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });

    // 5. Save to DB
    await supabase.from('game_state').update({
        jackpot: state.jackpot,
        end_time: state.endTime,
        last_bidder: displayUser,
        status: 'ACTIVE',
        history: state.history,
        user_investments: state.userInvestments
    }).eq('id', ROOM_CONFIG[roomKey].dbId);

    return true;
}

// --- MAIN GAME LOOP (Running at 100ms for precision) ---
setInterval(async () => {
  try {
      const now = Date.now();

      // 1. Process Auto-Bidders
      const activeAutoBidders = Object.entries(autoBidders).filter(([e, cfg]) => cfg.active);
      for (const [email, config] of activeAutoBidders) {
           const lastActionTime = config.lastAction || 0;
           if (now - lastActionTime >= 20000) {
                const targetRoom = Math.random() > 0.5 ? 'high' : 'low';
                const success = await executeBid(email, targetRoom, true);
                if (success) {
                    autoBidders[email].lastAction = now;
                } else {
                    const { data: u } = await supabase.from('users').select('balance').eq('email', email).maybeSingle();
                    if(u && u.balance < 0.10) {
                        autoBidders[email].active = false;
                        io.to(email).emit('autoBidStatus', { active: false, reason: 'Insufficient Funds' });
                    }
                }
           }
      }

      // 2. Process Logic for BOTH Rooms
      for (const roomKey of ['low', 'high']) {
          const state = roomStates[roomKey];
          const dbId = ROOM_CONFIG[roomKey].dbId;

          if (state.status === 'ACTIVE') {
              if (now >= state.endTime) {
                  state.status = 'ENDED';
                  state.restartTimer = now + 15000; 

                  if (state.bidders.length > 1 && state.lastBidder) {
                      let winUser = state.lastBidder;
                      let winAmt = state.jackpot;

                      let { data: u } = await supabase.from('users').select('balance, total_won, referred_by, email').eq('email', winUser).maybeSingle();
                      if (!u) {
                          const { data: lastBid } = await supabase.from('bids').select('user_email').order('id', {ascending: false}).limit(1).single();
                          if (lastBid) {
                              winUser = lastBid.user_email;
                              const { data: realUser } = await supabase.from('users').select('balance, total_won, referred_by, email').eq('email', winUser).maybeSingle();
                              u = realUser;
                          }
                      }

                      if (u) {
                          const newTotalWon = (u.total_won || 0) + winAmt;
                          await supabase.from('users').update({ balance: u.balance + winAmt, total_won: newTotalWon }).eq('email', winUser);

                          if (u.referred_by) {
                              const bonus = winAmt * 0.05;
                              const { data: referrer } = await supabase.from('users').select('balance').eq('email', u.referred_by).maybeSingle();
                              if (referrer) {
                                  await supabase.from('users').update({ balance: referrer.balance + bonus }).eq('email', u.referred_by);
                                  sendTelegram(`🎁 *REFERRAL BONUS*\nRef: \`${u.referred_by}\`\nEarned: $${bonus.toFixed(2)}`);
                              }
                          }

                          state.recentWinners.unshift({ user: state.lastBidder, amount: winAmt, time: Date.now() });
                          if (state.recentWinners.length > 5) state.recentWinners.pop();
                          
                          // --- TELEGRAM ALERT (RESTORED) ---
                          sendTelegram(`🎉 *${roomKey.toUpperCase()} POT WON!*\nUser: \`${winUser}\`\nAmt: $${winAmt.toFixed(2)}`);
                      }
                  } else if (state.bidders.length === 1 && state.lastBidder) {
                      let solePlayer = state.lastBidder;
                      let { data: check } = await supabase.from('users').select('id').eq('email', solePlayer).maybeSingle();
                      if (!check) {
                           const { data: lastBid } = await supabase.from('bids').select('user_email').order('id', {ascending: false}).limit(1).single();
                           if (lastBid) solePlayer = lastBid.user_email;
                      }
                      const refundAmt = state.userInvestments[solePlayer] || 0;
                      if (refundAmt > 0) {
                           const { data: u } = await supabase.from('users').select('balance').eq('email', solePlayer).maybeSingle();
                           if (u) {
                               await supabase.from('users').update({ balance: u.balance + refundAmt }).eq('email', solePlayer);
                               sendTelegram(`♻️ *REFUND*\nUser: \`${solePlayer}\`\nAmt: $${refundAmt.toFixed(2)}`);
                           }
                      }
                  }

                  await supabase.from('game_state').update({ recent_winners: state.recentWinners, status: 'ENDED' }).eq('id', dbId);
                  io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });
              }
          } else if (state.status === 'ENDED') {
              if (now >= state.restartTimer) {
                  state.status = 'ACTIVE';
                  state.endTime = now + 300000;
                  state.jackpot = 0.00;
                  state.lastBidder = null;
                  state.history = [];
                  state.bidders = [];
                  state.userInvestments = {};

                  await supabase.from('game_state').update({
                      jackpot: 0.00, end_time: state.endTime, status: 'ACTIVE',
                      last_bidder: null, history: [], user_investments: {}
                  }).eq('id', dbId);

                  io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });
              }
          }
          if (state.status !== 'ENDED') {
             io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });
          }
      }

  } catch (loopError) {
      console.error("Loop Error:", loopError.message);
  }
}, 100);

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    connectedUserCount++;
    io.emit('gameConfig', { connectedUsers: connectedUserCount });

    socket.on('disconnect', () => {
        connectedUserCount--;
        io.emit('gameConfig', { connectedUsers: connectedUserCount });
    });

    socket.on('getGameConfig', () => {
        socket.emit('gameConfig', { adminWallet: ADMIN_WALLET, connectedUsers: connectedUserCount });
    });

    // --- NEW ROOM LOGIC ---
    socket.on('joinRoom', (roomType) => {
        if (!['low', 'high'].includes(roomType)) return;
        socket.join(roomType);
        socket.emit('roomUpdate', { room: roomType, state: roomStates[roomType] });
    });

    socket.on('leaveRoom', (roomType) => {
        socket.leave(roomType);
    });

    // --- CHAT & LEADERBOARD ---
    socket.emit('chatHistory', chatHistory);
    const sendLeaderboard = async () => {
        const { data } = await supabase.from('users').select('username, total_won, total_bidded').order('total_won', { ascending: false }).limit(10);
        socket.emit('leaderboardUpdate', data || []);
    };
    sendLeaderboard();

    // -----------------------------------------------------------
    // --- 🔐 AUTHENTICATION (RESTORED FROM OLD CODE) ---
    // -----------------------------------------------------------

    // 1. REQUEST SIGNUP OTP
    socket.on('requestSignupOtp', async ({ email }) => {
        if (!email) return socket.emit('authError', 'Email is required.');
        const cleanEmail = email.toLowerCase().trim();
        const { data: existingUser } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
        if (existingUser) return socket.emit('authError', 'Email is already registered.');
        
        const otp = generateOTP();
        otpStore.set(cleanEmail, { code: otp, expires: Date.now() + 300000 });
        const sent = await sendEmailOTP(cleanEmail, otp, 'signup');
        
        if (sent) {
            socket.emit('signupOtpSent');
            console.log(`OTP sent to ${cleanEmail}`);
        } else {
            socket.emit('authError', 'Failed to send OTP.');
        }
    });

    // 2. REGISTER
    socket.on('register', async ({ username, email, password, otp, referralCode }) => {
         if (!username || !email || !password || !otp) return socket.emit('authError', 'All fields required');
         const cleanEmail = email.toLowerCase().trim();
         const cleanUser = username.trim();
         const storedOtp = otpStore.get(cleanEmail);
         
         if (!storedOtp || storedOtp.code !== otp) return socket.emit('authError', 'Invalid OTP');
         if (Date.now() > storedOtp.expires) return socket.emit('authError', 'OTP Expired');

         const hashedPassword = await bcrypt.hash(password, 10);
         const myRefCode = generateReferralCode();
         let referredBy = null;
         if (referralCode) {
             const { data: refUser } = await supabase.from('users').select('email').eq('referral_code', referralCode).maybeSingle();
             if(refUser) referredBy = refUser.email;
         }

         const { data: inserted, error } = await supabase.from('users').insert([{
             username: cleanUser, email: cleanEmail, password_hash: hashedPassword,
             balance: 0.00, referral_code: myRefCode, referred_by: referredBy,
             total_won: 0, total_bidded: 0
         }]).select().single();

         if(!error) {
             otpStore.delete(cleanEmail);
             socket.emit('authSuccess', { ...inserted, referralCode: myRefCode });
             console.log(`🆕 User Registered: ${inserted.username}`);
         } else {
             socket.emit('authError', 'Registration failed (Username/Email taken).');
         }
    });

    // 3. LOGIN
    socket.on('login', async ({ email, password }) => {
        const cleanEmail = email.toLowerCase().trim();
        const { data: user } = await supabase.from('users').select('*').eq('email', cleanEmail).maybeSingle();
        if (user && await bcrypt.compare(password, user.password_hash)) {
            socket.emit('authSuccess', { ...user, referralCode: user.referral_code });
            
            const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
            socket.emit('withdrawalHistory', w || []);
            
            const { data: d } = await supabase.from('deposits').select('*').eq('user_email', cleanEmail).order('created_at', { ascending: false });
            socket.emit('depositHistory', d || []);
            
            console.log(`✅ User Logged In: ${user.username}`);
        } else {
            socket.emit('authError', 'Invalid credentials');
        }
    });

    // 4. REQUEST RESET OTP
    socket.on('requestResetOtp', async ({ email }) => {
        const cleanEmail = email.toLowerCase().trim();
        const { data: user } = await supabase.from('users').select('id').eq('email', cleanEmail).maybeSingle();
        if (!user) return socket.emit('authError', 'Email not found.');
        
        const otp = generateOTP();
        otpStore.set(cleanEmail, { code: otp, expires: Date.now() + 300000 });
        const sent = await sendEmailOTP(cleanEmail, otp, 'reset');
        
        if (sent) socket.emit('resetOtpSent');
        else socket.emit('authError', 'Failed to send reset email.');
    });

    // 5. CONFIRM RESET
    socket.on('resetPassword', async ({ email, otp, newPassword }) => {
        const cleanEmail = email.toLowerCase().trim();
        const storedOtp = otpStore.get(cleanEmail);
        if (!storedOtp || storedOtp.code !== otp) return socket.emit('authError', 'Invalid OTP');
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await supabase.from('users').update({ password_hash: hashedPassword }).eq('email', cleanEmail);
        otpStore.delete(cleanEmail);
        socket.emit('resetSuccess');
    });

    // -----------------------------------------------------------

    // --- BIDDING ---
    socket.on('placeBid', async ({ room, email: rawEmail }) => {
        const email = rawEmail.toLowerCase().trim();
        if (autoBidders[email] && autoBidders[email].active) {
            socket.emit('bidError', 'Turn off Auto-Bidder to bid manually.');
            return;
        }
        const success = await executeBid(email, room);
        if (!success) socket.emit('bidError', 'Cooldown or Low Balance');
    });

    // --- AUTO BID TOGGLE ---
    socket.on('toggleAutoBid', ({ email, active }) => {
        if(active) autoBidders[email] = { active: true, lastAction: 0 };
        else if(autoBidders[email]) autoBidders[email].active = false;
    });

    // --- BALANCE & PROFILE ---
    socket.on('getUserBalance', async (rawEmail) => {
        const email = rawEmail.toLowerCase().trim();
        socket.join(email);
        let { data: u } = await supabase.from('users').select('*').eq('email', email).maybeSingle();
        if (!u) {
             // Wallet auto-create
             const { data: n } = await supabase.from('users').insert([{ email, balance: 0, username: 'Player', referral_code: generateReferralCode() }]).select().single();
             u = n;
        }
        socket.emit('balanceUpdate', u.balance);
        socket.emit('userData', u);
    });

    socket.on('updateProfile', async ({ email, username }) => {
        await supabase.from('users').update({ username }).eq('email', email);
    });

    socket.on('sendChatMessage', ({ email, message, username }) => {
        if(!message) return;
        const msg = { id: Date.now(), user: username, text: message };
        chatHistory.push(msg);
        if(chatHistory.length > 200) chatHistory.shift();
        io.emit('chatMessage', msg);
    });

    // --- TRANSACTIONS (RESTORED TELEGRAM ALERTS) ---
    socket.on('verifyDeposit', async ({ email: rawEmail, txHash, network }) => {
         const email = rawEmail.toLowerCase().trim();
         try {
             const provider = providers[network];
             if (!provider) { socket.emit('depositError', 'Invalid Network'); return; }
             const tx = await provider.waitForTransaction(txHash, 1, 60000);
             if (!tx) { socket.emit('depositError', 'Timeout'); return; }
             
             const txDetails = await provider.getTransaction(txHash);
             // Verify TO address matches ADMIN
             if(txDetails.to.toLowerCase() !== ADMIN_WALLET.toLowerCase()) {
                 socket.emit('depositError', 'Wrong Address'); return;
             }

             const rawAmt = parseFloat(ethers.utils.formatEther(txDetails.value));
             let rate = network === 'BSC' ? 600 : 3000;
             const dollarAmount = rawAmt * rate;

             const { error } = await supabase.from('deposits').insert([{ user_email: email, amount: dollarAmount, network, tx_hash: txHash, status: 'COMPLETED' }]);
             if (error) { socket.emit('depositError', 'Already Claimed'); return; }

             const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
             const newBal = u.balance + dollarAmount;
             await supabase.from('users').update({ balance: newBal }).eq('email', email);

             socket.emit('depositSuccess', newBal);
             socket.emit('balanceUpdate', newBal);
             sendTelegram(`💰 *DEPOSIT*\nUser: \`${email}\`\nAmt: $${dollarAmount.toFixed(2)}`);
         } catch(e) { socket.emit('depositError', 'Error'); }
    });

    socket.on('requestWithdrawal', async ({ email: rawEmail, amount, address, network }) => {
         const email = rawEmail.toLowerCase().trim();
         const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
         if (u.balance < amount) { socket.emit('withdrawalError', 'Insufficient Funds'); return; }

         await supabase.from('users').update({ balance: u.balance - amount }).eq('email', email);
         await supabase.from('withdrawals').insert([{ user_email: email, amount, wallet_address: address, network, status: 'PENDING' }]);
         
         socket.emit('withdrawalSuccess', u.balance - amount);
         socket.emit('balanceUpdate', u.balance - amount);
         sendTelegram(`💸 *WITHDRAWAL*\nUser: \`${email}\`\nAmt: $${amount}\nAddr: \`${address}\``);
    });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
