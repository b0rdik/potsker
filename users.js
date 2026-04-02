const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

const DATA_DIR = process.env.POKER_DATA_DIR
  ? path.resolve(process.env.POKER_DATA_DIR)
  : path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');

const AUTH_TOKEN_TTL_HOURS = parseInt(process.env.AUTH_TOKEN_TTL_HOURS || '24', 10) || 24;

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// Load users from file
let users = {};
if (fs.existsSync(USERS_FILE)) {
  try {
    users = JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (e) {
    console.error('Failed to load users.json:', e.message);
    users = {};
  }
}

function save() {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2));
  } catch (e) {
    console.error('Failed to save users.json:', e.message);
  }
}

function defaultStats() {
  return {
    handsPlayed: 0,
    handsWon: 0,
    biggestWin: 0,
    totalWinnings: 0,
    gamesPlayed: 0,
  };
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function issueToken(user) {
  const rawToken = crypto.randomBytes(32).toString('base64url');
  user.tokenHash = hashToken(rawToken);
  delete user.token;
  user.tokenIssuedAt = new Date().toISOString();
  return rawToken;
}

function isTokenExpired(user) {
  if (AUTH_TOKEN_TTL_HOURS <= 0) return false;
  const issuedAtStr = user.tokenIssuedAt || user.createdAt;
  if (!issuedAtStr) return true;
  const issuedAtMs = Date.parse(issuedAtStr);
  if (!Number.isFinite(issuedAtMs)) return true;
  const ttlMs = AUTH_TOKEN_TTL_HOURS * 60 * 60 * 1000;
  return Date.now() - issuedAtMs > ttlMs;
}

function register(name, password) {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length < 2 || trimmed.length > 15) {
    return { error: 'Имя от 2 до 15 символов' };
  }
  if (!password || password.length < 8) {
    return { error: 'Пароль минимум 8 символов' };
  }

  // Check if name taken (case-insensitive)
  const nameLower = trimmed.toLowerCase();
  const existing = Object.values(users).find(u => u.name.toLowerCase() === nameLower);
  if (existing) {
    return { error: 'Это имя уже занято' };
  }

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 10);

  users[id] = {
    id,
    name: trimmed,
    passwordHash: hash,
    avatar: null,
    createdAt: new Date().toISOString(),
    stats: defaultStats(),
  };
  const token = issueToken(users[id]);

  save();
  return { user: safeUser(users[id]), token };
}

function login(name, password) {
  const nameLower = name.trim().toLowerCase();
  const user = Object.values(users).find(u => u.name.toLowerCase() === nameLower);

  if (!user) {
    return { error: 'Пользователь не найден' };
  }

  if (!bcrypt.compareSync(password, user.passwordHash)) {
    return { error: 'Неверный пароль' };
  }

  // Generate new token on login
  const token = issueToken(user);
  save();

  return { user: safeUser(user), token };
}

function authByToken(token) {
  if (!token) return null;
  const tokenStr = String(token);
  const tokenHashed = hashToken(tokenStr);

  const user = Object.values(users).find((u) => {
    if (u.tokenHash) return u.tokenHash === tokenHashed;
    // Backward compat: older records may store raw token
    return u.token && u.token === tokenStr;
  });

  if (!user) return null;
  if (isTokenExpired(user)) return null;

  // Upgrade legacy token storage to hashed on successful auth
  if (!user.tokenHash && user.token === tokenStr) {
    user.tokenHash = tokenHashed;
    delete user.token;
    if (!user.tokenIssuedAt) user.tokenIssuedAt = new Date().toISOString();
    save();
  }

  return safeUser(user);
}

function getUser(id) {
  return users[id] ? safeUser(users[id]) : null;
}

function updateStats(id, newStats) {
  if (!users[id]) return;
  const s = users[id].stats;
  s.handsPlayed += newStats.handsPlayed || 0;
  s.handsWon += newStats.handsWon || 0;
  s.totalWinnings += newStats.totalWinnings || 0;
  s.biggestWin = Math.max(s.biggestWin, newStats.biggestWin || 0);
  s.gamesPlayed += newStats.gamesPlayed || 0;
  save();
}

function addStats(id, field, amount) {
  if (!users[id]) return;
  if (field === 'biggestWin') {
    users[id].stats.biggestWin = Math.max(users[id].stats.biggestWin, amount);
  } else {
    users[id].stats[field] = (users[id].stats[field] || 0) + amount;
  }
  save();
}

function setAvatar(id, base64) {
  if (!users[id]) return false;
  // Limit to ~100KB base64
  if (base64 && base64.length > 150000) return false;
  users[id].avatar = base64 || null;
  save();
  return true;
}

function safeUser(u) {
  return {
    id: u.id,
    name: u.name,
    avatar: u.avatar || null,
    createdAt: u.createdAt,
    stats: { ...u.stats },
  };
}

function getLeaderboard() {
  return Object.values(users)
    .filter(u => u.stats.handsPlayed > 0)
    .map(u => ({
      name: u.name,
      avatar: u.avatar || null,
      handsPlayed: u.stats.handsPlayed,
      handsWon: u.stats.handsWon,
      winRate: u.stats.handsPlayed > 0 ? Math.round(u.stats.handsWon / u.stats.handsPlayed * 100) : 0,
      totalWinnings: u.stats.totalWinnings,
      biggestWin: u.stats.biggestWin,
    }))
    .sort((a, b) => b.totalWinnings - a.totalWinnings)
    .slice(0, 20);
}

module.exports = { register, login, authByToken, getUser, updateStats, addStats, setAvatar, getLeaderboard };
