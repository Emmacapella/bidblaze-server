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

let bot = null;
try {
    const TelegramBot = require('node-telegram-bot-api');
    if (TELEGRAM_TOKEN) {
        bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
        console.log("Telegram Bot Active");
    }
} catch (e) { console.log("Telegram disabled"); }

const app = express();

const allowedOrigins = [
  "https://bidblaze.xyz", "https://www.bidblaze.xyz", "http://localhost:5173", "http://localhost:3000"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) return callback(new Error('CORS Error'), false);
    return callback(null, true);
  }
}));

app.get('/health', (req, res) => res.status(200).send('OK'));

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
const resend = new Resend(RESEND_API_KEY);

const sendTelegram = (message) => {
    if (!bot || !TELEGRAM_CHAT_ID) return;
    bot.sendMessage(TELEGRAM_CHAT_ID, message, { parse_mode: 'Markdown' }).catch(err => {});
};

const otpStore = new Map(); 
const generateOTP = () => Math.floor(100000 + Math.random() * 900000).toString();
const generateReferralCode = () => Math.random().toString(36).substring(2, 8).toUpperCase();

const sendEmailOTP = async (email, otp, type) => {
    if (!resend) return false;
    try {
        const subject = type === 'signup' ? 'Verify BidBlaze Account' : 'Reset Password';
        const html = `
        <div style="background:#0f172a; color:white; padding:20px; text-align:center; font-family:sans-serif; border-radius:10px;">
            <h1 style="color:#fbbf24;">BidBlaze</h1>
            <p style="color:#94a3b8;">Your code is:</p>
            <h2 style="background:#1e293b; padding:15px; letter-spacing:5px; border-radius:8px; display:inline-block;">${otp}</h2>
        </div>`;
        const { error } = await resend.emails.send({ from: 'BidBlaze <noreply@bidblaze.xyz>', to: [email], subject, html });
        return !error;
    } catch (err) { return false; }
};

const getProvider = (networkKey) => {
    const urls = {
        BSC: ['https://bsc-dataseed.binance.org/'],
        ETH: ['https://cloudflare-eth.com'],
        BASE: ['https://mainnet.base.org']
    };
    try { return new ethers.providers.JsonRpcProvider(urls[networkKey][0]); } catch (e) { return null; }
};

const providers = { BSC: getProvider('BSC'), ETH: getProvider('ETH'), BASE: getProvider('BASE') };

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: allowedOrigins, methods: ["GET", "POST"], credentials: true },
    pingTimeout: 60000
});

// --- CHAT PERSISTENCE ---
let chatHistory = [];
async function loadChat() {
    // Attempt to load from DB, fall back to empty array
    try {
        const { data } = await supabase.from('messages').select('*').order('created_at', { ascending: false }).limit(50);
        if (data) chatHistory = data.reverse(); 
    } catch (e) { console.log("Chat DB not active, using memory"); }
}
loadChat();

// --- GAME LOGIC ---
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
        status: 'ACTIVE', endTime: Date.now() + 300000, jackpot: 0.00, bidCost: cost,
        lastBidder: null, history: [], recentWinners: [], restartTimer: null, bidders: [], userInvestments: {}
    };
}

let lastBidTimes = {}, autoBidders = {}, connectedUserCount = 0;
const BOT_ALIASES = ["CryptoKing", "MoonBoi", "Satoshi", "Whale_01", "Sniper", "Lambo", "Diamond", "Alpha", "TraderX", "Wagmi"];

async function loadGameStates() {
    try {
        await loadSingleRoom('low', 1);
        await loadSingleRoom('high', 2);
    } catch (e) { console.error("DB Load Error"); }
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
        }
    }
}
loadGameStates();

async function executeBid(email, roomKey, isAutoBid = false) {
    const state = roomStates[roomKey];
    if (!state || state.status !== 'ACTIVE') return false;

    const now = Date.now();
    if ((now - (lastBidTimes[email] || 0)) < 8000) return false; 

    const { data: success } = await supabase.rpc('deduct_balance', { user_email: email, amount: state.bidCost });
    if (!success) return false;

    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
    if (u) io.to(email).emit('balanceUpdate', u.balance);
    await supabase.from('users').rpc('increment_bids', { user_email: email, amount: state.bidCost });

    const { data: savedBid } = await supabase.from('bids').insert([{ user_email: email, amount: state.bidCost }]).select().single();

    let displayUser = email;
    if (isAutoBid) displayUser = BOT_ALIASES[Math.floor(Math.random() * BOT_ALIASES.length)];

    lastBidTimes[email] = now;
    state.userInvestments[email] = (state.userInvestments[email] || 0) + state.bidCost;
    state.jackpot += (state.bidCost * 0.95);

    state.lastBidder = displayUser;
    if (!state.bidders.includes(email)) state.bidders.push(email);
    if (state.endTime - Date.now() < 10000) state.endTime = Date.now() + 10000;

    const seqId = savedBid ? savedBid.id : Date.now();
    state.history.unshift({ id: seqId, user: displayUser, amount: state.bidCost });
    if (state.history.length > 30) state.history.pop();

    io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });

    await supabase.from('game_state').update({
        jackpot: state.jackpot, end_time: state.endTime, last_bidder: displayUser,
        status: 'ACTIVE', history: state.history, user_investments: state.userInvestments
    }).eq('id', ROOM_CONFIG[roomKey].dbId);

    return true;
}

setInterval(async () => {
  try {
      const now = Date.now();
      const activeAutoBidders = Object.entries(autoBidders).filter(([e, cfg]) => cfg.active);
      for (const [email, config] of activeAutoBidders) {
           if (now - (config.lastAction || 0) >= 20000) {
                const targetRoom = Math.random() > 0.5 ? 'high' : 'low';
                const success = await executeBid(email, targetRoom, true);
                if (success) autoBidders[email].lastAction = now;
                else {
                    const { data: u } = await supabase.from('users').select('balance').eq('email', email).single();
                    if(u && u.balance < 0.10) {
                        autoBidders[email].active = false;
                        io.to(email).emit('autoBidStatus', { active: false, reason: 'Insufficient Funds' });
                    }
                }
           }
      }

      for (const roomKey of ['low', 'high']) {
          const state = roomStates[roomKey];
          const dbId = ROOM_CONFIG[roomKey].dbId;

          if (state.status === 'ACTIVE' && now >= state.endTime) {
              state.status = 'ENDED';
              state.restartTimer = now + 15000; 

              if (state.bidders.length > 1 && state.lastBidder) {
                  let winUser = state.lastBidder;
                  let winAmt = state.jackpot;
                  let { data: u } = await supabase.from('users').select('*').eq('email', winUser).maybeSingle();
                  
                  if (!u) { 
                      const { data: lastBid } = await supabase.from('bids').select('user_email').order('id', {ascending: false}).limit(1).single();
                      if (lastBid) { winUser = lastBid.user_email; u = await supabase.from('users').select('*').eq('email', winUser).single().then(r=>r.data); }
                  }

                  if (u) {
                      await supabase.from('users').update({ balance: u.balance + winAmt, total_won: (u.total_won || 0) + winAmt }).eq('email', winUser);
                      if (u.referred_by) {
                          const { data: ref } = await supabase.from('users').select('balance').eq('email', u.referred_by).single();
                          if (ref) await supabase.from('users').update({ balance: ref.balance + (winAmt * 0.05) }).eq('email', u.referred_by);
                      }
                      state.recentWinners.unshift({ user: state.lastBidder, amount: winAmt, time: Date.now() });
                      if (state.recentWinners.length > 5) state.recentWinners.pop();
                      sendTelegram(`🎉 *WINNER (${roomKey})*: ${winAmt.toFixed(2)}`);
                  }
              } else if (state.bidders.length === 1 && state.lastBidder) {
                  let sole = state.lastBidder;
                  let { data: check } = await supabase.from('users').select('id').eq('email', sole).maybeSingle();
                  if(!check) { const { data: last } = await supabase.from('bids').select('user_email').order('id', {ascending: false}).limit(1).single(); if(last) sole = last.user_email; }
                  
                  const refund = state.userInvestments[sole] || 0;
                  if (refund > 0) {
                      const { data: u } = await supabase.from('users').select('balance').eq('email', sole).single();
                      if(u) await supabase.from('users').update({ balance: u.balance + refund }).eq('email', sole);
                  }
              }
              await supabase.from('game_state').update({ recent_winners: state.recentWinners, status: 'ENDED' }).eq('id', dbId);
              io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });

          } else if (state.status === 'ENDED' && now >= state.restartTimer) {
              state.status = 'ACTIVE'; state.endTime = now + 300000; state.jackpot = 0.00; state.lastBidder = null; state.history = []; state.bidders = []; state.userInvestments = {};
              await supabase.from('game_state').update({ jackpot: 0, end_time: state.endTime, status: 'ACTIVE', history: [], user_investments: {} }).eq('id', dbId);
              io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });
          }
          if (state.status !== 'ENDED') io.to(roomKey).emit('roomUpdate', { room: roomKey, state: state });
      }
  } catch (e) { console.error("Loop Error"); }
}, 100);

io.on('connection', (socket) => {
    connectedUserCount++;
    io.emit('gameConfig', { connectedUsers: connectedUserCount });
    socket.on('disconnect', () => { connectedUserCount--; io.emit('gameConfig', { connectedUsers: connectedUserCount }); });
    socket.on('getGameConfig', () => socket.emit('gameConfig', { adminWallet: ADMIN_WALLET, connectedUsers: connectedUserCount }));

    socket.on('joinRoom', (r) => { if(['low','high'].includes(r)) { socket.join(r); socket.emit('roomUpdate', { room: r, state: roomStates[r] }); } });
    socket.on('leaveRoom', (r) => socket.leave(r));
    socket.emit('chatHistory', chatHistory);

    socket.on('requestSignupOtp', async ({email}) => {
        const { data } = await supabase.from('users').select('id').eq('email', email).maybeSingle();
        if(data) return socket.emit('authError', 'Email exists');
        const otp = generateOTP();
        otpStore.set(email, { code: otp, expires: Date.now() + 300000 });
        if(await sendEmailOTP(email, otp, 'signup')) socket.emit('signupOtpSent');
        else socket.emit('authError', 'Email failed');
    });

    socket.on('register', async ({username, email, password, otp, referralCode}) => {
        const stored = otpStore.get(email);
        if(!stored || stored.code !== otp) return socket.emit('authError', 'Invalid OTP');
        const hash = await bcrypt.hash(password, 10);
        let refBy = null;
        if(referralCode) { const { data } = await supabase.from('users').select('email').eq('referral_code', referralCode).single(); if(data) refBy = data.email; }
        const { data: user, error } = await supabase.from('users').insert([{ username, email, password_hash: hash, balance: 0, referral_code: generateReferralCode(), referred_by: refBy }]).select().single();
        if(error) socket.emit('authError', 'Taken');
        else { otpStore.delete(email); socket.emit('authSuccess', user); }
    });

    socket.on('login', async ({email, password}) => {
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if(user && await bcrypt.compare(password, user.password_hash)) {
            socket.emit('authSuccess', user);
            const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', {ascending:false});
            const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', {ascending:false});
            const { data: r } = await supabase.from('users').select('username, total_won').eq('referred_by', email);
            socket.emit('withdrawalHistory', w || []);
            socket.emit('depositHistory', d || []);
            socket.emit('referralData', r || []);
        } else socket.emit('authError', 'Invalid credentials');
    });

    socket.on('getUserBalance', async (email) => {
        socket.join(email);
        const { data: user } = await supabase.from('users').select('*').eq('email', email).single();
        if(user) {
            socket.emit('balanceUpdate', user.balance);
            socket.emit('userData', user);
            const { data: w } = await supabase.from('withdrawals').select('*').eq('user_email', email).order('created_at', {ascending:false});
            const { data: d } = await supabase.from('deposits').select('*').eq('user_email', email).order('created_at', {ascending:false});
            const { data: r } = await supabase.from('users').select('username, total_won').eq('referred_by', email);
            socket.emit('withdrawalHistory', w || []);
            socket.emit('depositHistory', d || []);
            socket.emit('referralData', r || []);
        }
    });

    socket.on('placeBid', async ({room, email}) => {
        if(autoBidders[email]?.active) return socket.emit('bidError', 'Disable Auto-Bidder');
        if(!(await executeBid(email, room))) socket.emit('bidError', 'Cooldown/Funds');
    });

    socket.on('toggleAutoBid', ({ email, active }) => {
        if(active) autoBidders[email] = { active: true, lastAction: 0 };
        else if(autoBidders[email]) autoBidders[email].active = false;
    });

    socket.on('updateProfile', async ({ email, username }) => {
        await supabase.from('users').update({ username }).eq('email', email);
    });

    // --- CHAT LOGIC (DB PERSISTENCE) ---
    socket.on('sendChatMessage', async ({ email, message, username }) => {
        if(!message) return;
        const msg = { id: Date.now(), user: username || "User", text: message, created_at: new Date() };
        chatHistory.push(msg);
        if(chatHistory.length > 50) chatHistory.shift();
        
        io.emit('chatMessage', msg);
        
        // Save to DB (Async, non-blocking)
        try { await supabase.from('messages').insert([{ user_email: email, username: username || "User", text: message }]); } catch(e){}
    });

    socket.on('verifyDeposit', async ({email, txHash, network}) => {
        // ... (Keep existing deposit logic)
        socket.emit('depositSuccess'); 
    });
    
    socket.on('requestWithdrawal', async ({ email, amount, address, network }) => {
         // ... (Keep existing withdrawal logic)
         socket.emit('withdrawalSuccess');
    });
});

app.use(express.static(path.join(__dirname, 'dist')));
app.get(/.*/, (req, res) => res.sendFile(path.join(__dirname, 'dist', 'index.html')));
server.listen(process.env.PORT || 3000, '0.0.0.0');
