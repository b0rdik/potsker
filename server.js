const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const usersDb = require('./users');
const poker = require('./lib/poker');

const app = express();
app.set('trust proxy', 1); // за nginx: корректный IP и express-rate-limit
const server = http.createServer(app);
function parseCorsOrigin(val) {
  if (!val) return false;
  const v = String(val).trim();
  if (v.toLowerCase() === 'false' || v.toLowerCase() === 'none') return false;
  if (v === '*') return '*';
  return v;
}

const io = new Server(server, {
  cors: {
    origin: parseCorsOrigin(process.env.SOCKET_IO_CORS_ORIGIN),
    methods: ['GET', 'POST'],
  },
});

app.disable('x-powered-by');
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);
app.use(express.json({ limit: '32kb' }));
app.use(express.urlencoded({ extended: false, limit: '32kb' }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  limit: parseInt(process.env.RATE_LIMIT_PER_MINUTE || '120', 10) || 120,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use(limiter);

app.use(express.static(path.join(__dirname, 'public')));

// ============ GAME STATE ============

const rooms = {};

function generateRoomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 4; i++) code += chars[crypto.randomInt(chars.length)];
  return rooms[code] ? generateRoomCode() : code;
}

function createRoom(options = {}) {
  const code = generateRoomCode();
  const sb = parseInt(options.smallBlind) || 10;
  const bb = parseInt(options.bigBlind) || 20;
  const buyIn = parseInt(options.buyIn) || 1000;
  rooms[code] = {
    code,
    players: [],
    state: 'waiting',
    deck: [],
    community: [],
    pot: 0,
    currentBet: 0,
    dealerIndex: -1,
    currentPlayerIndex: -1,
    phase: 'preflop',
    smallBlind: sb,
    bigBlind: bb,
    buyIn: buyIn,
    minRaise: bb,
    lastRaiserIndex: -1,
    handNumber: 0,
    history: [],
  };
  return code;
}

function addPlayer(room, socketId, name, userId) {
  if (room.players.length >= 8) return false;
  // Prevent duplicate by userId
  if (userId && room.players.find(p => p.userId === userId)) return false;
  if (room.players.find(p => p.id === socketId)) return false;
  room.players.push({
    id: socketId,
    userId: userId || socketId,
    name: name || `Игрок ${room.players.length + 1}`,
    chips: room.buyIn || 1000,
    hand: [],
    bet: 0,
    totalBet: 0,
    folded: false,
    allIn: false,
    isConnected: true,
    sittingOut: false,
    hasActed: false,
    ready: false,
    peeked: [false, false], // which cards the player has flipped face-up (for themselves)
    mucked: false, // chose not to show at showdown
    avatar: usersDb.getUser(userId)?.avatar || null,
    stats: { handsPlayed: 0, handsWon: 0, biggestWin: 0, totalWinnings: 0 },
  });
  return true;
}

function removePlayer(room, socketId) {
  room.players = room.players.filter(p => p.id !== socketId);
}

function startGame(room) {
  const eligible = room.players.filter(p => p.chips > 0 && p.isConnected);
  if (eligible.length < 2) return false;

  room.state = 'playing';
  room.handNumber++;

  // Reset all players
  for (const p of room.players) {
    p.hand = [];
    p.bet = 0;
    p.totalBet = 0;
    p.folded = false;
    p.allIn = false;
    p.hasActed = false;
    p.peeked = [false, false];
    p.mucked = false;
    p.showdownDecided = false;
    if (p.chips <= 0 || !p.isConnected) {
      p.sittingOut = true;
      p.folded = true;
    } else {
      p.sittingOut = false;
    }
  }

  const activePlayers = room.players.filter(p => !p.sittingOut);
  if (activePlayers.length < 2) {
    room.state = 'waiting';
    return false;
  }

  room.deck = poker.createDeck();
  room.community = [];
  room.pot = 0;
  room.showdownWinnerIds = [];
  room.currentBet = 0;
  room.phase = 'preflop';
  room.minRaise = room.bigBlind;
  room.lastRaiserIndex = -1;

  // Move dealer
  if (room.dealerIndex === -1) {
    // First hand — find first active player
    room.dealerIndex = room.players.findIndex(p => !p.sittingOut);
  } else {
    room.dealerIndex = findNextActive(room, room.dealerIndex);
  }

  // Deal cards
  for (const p of room.players) {
    if (!p.sittingOut) {
      p.hand = [room.deck.pop(), room.deck.pop()];
    }
  }

  // Post blinds
  const isHeadsUp = activePlayers.length === 2;

  let sbIndex, bbIndex;
  if (isHeadsUp) {
    sbIndex = room.dealerIndex;
    bbIndex = findNextActive(room, room.dealerIndex);
  } else {
    sbIndex = findNextActive(room, room.dealerIndex);
    bbIndex = findNextActive(room, sbIndex);
  }
  room.sbIndex = sbIndex;
  room.bbIndex = bbIndex;

  const sbPlayer = room.players[sbIndex];
  const bbPlayer = room.players[bbIndex];

  const sbAmount = Math.min(room.smallBlind, sbPlayer.chips);
  sbPlayer.chips -= sbAmount;
  sbPlayer.bet = sbAmount;
  sbPlayer.totalBet = sbAmount;
  if (sbPlayer.chips === 0) sbPlayer.allIn = true;

  const bbAmount = Math.min(room.bigBlind, bbPlayer.chips);
  bbPlayer.chips -= bbAmount;
  bbPlayer.bet = bbAmount;
  bbPlayer.totalBet = bbAmount;
  if (bbPlayer.chips === 0) bbPlayer.allIn = true;

  room.currentBet = bbAmount;
  room.pot = sbAmount + bbAmount;

  // First to act preflop: after BB (or dealer in heads-up)
  if (isHeadsUp) {
    room.currentPlayerIndex = sbIndex; // dealer/SB acts first preflop in heads-up
  } else {
    room.currentPlayerIndex = findNextActive(room, bbIndex);
  }

  // If current player is all-in, advance
  if (room.players[room.currentPlayerIndex].allIn) {
    advanceToNextActor(room);
  }

  return true;
}

function findNextActive(room, fromIndex) {
  let idx = (fromIndex + 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    if (!room.players[idx].folded && !room.players[idx].sittingOut) {
      return idx;
    }
    idx = (idx + 1) % room.players.length;
  }
  return fromIndex;
}

function findNextCanAct(room, fromIndex) {
  let idx = (fromIndex + 1) % room.players.length;
  for (let i = 0; i < room.players.length; i++) {
    const p = room.players[idx];
    if (!p.folded && !p.allIn && !p.sittingOut) {
      return idx;
    }
    idx = (idx + 1) % room.players.length;
  }
  return -1; // nobody can act
}

function advanceToNextActor(room) {
  const next = findNextCanAct(room, room.currentPlayerIndex);
  if (next === -1) {
    room.currentPlayerIndex = -1;
  } else {
    room.currentPlayerIndex = next;
  }
}

function getActivePlayers(room) {
  return room.players.filter(p => !p.folded && !p.sittingOut);
}

function getPlayersWhoCanAct(room) {
  return room.players.filter(p => !p.folded && !p.allIn && !p.sittingOut);
}

function isBettingRoundOver(room) {
  const canAct = getPlayersWhoCanAct(room);
  if (canAct.length === 0) return true;
  // Everyone who can act must have acted and matched the current bet
  return canAct.every(p => p.hasActed && p.bet === room.currentBet);
}

function handleAction(room, playerId, action, amount) {
  const playerIndex = room.players.findIndex(p => p.id === playerId);
  if (playerIndex === -1) return { error: 'Игрок не найден' };
  if (playerIndex !== room.currentPlayerIndex) return { error: 'Не ваш ход' };

  const player = room.players[playerIndex];
  if (player.folded || player.allIn) return { error: 'Вы не можете действовать' };

  const toCall = room.currentBet - player.bet;

  switch (action) {
    case 'fold':
      player.folded = true;
      player.hasActed = true;
      break;

    case 'check':
      if (toCall > 0) return { error: 'Нельзя чекнуть, нужно коллировать ' + toCall };
      player.hasActed = true;
      break;

    case 'call': {
      const callAmount = Math.min(toCall, player.chips);
      player.chips -= callAmount;
      player.bet += callAmount;
      player.totalBet += callAmount;
      room.pot += callAmount;
      if (player.chips === 0) player.allIn = true;
      player.hasActed = true;
      break;
    }

    case 'raise': {
      const raiseTotal = parseInt(amount);
      const maxBet = player.chips + player.bet;
      // Allow all-in even if below minRaise
      if (raiseTotal < room.currentBet + room.minRaise && raiseTotal < maxBet) {
        return { error: `Минимальный рейз: ${room.currentBet + room.minRaise}` };
      }
      const actualBet = Math.min(raiseTotal, maxBet);
      const raiseAmount = actualBet - player.bet;
      player.chips -= raiseAmount;
      player.bet = actualBet;
      player.totalBet += raiseAmount;
      room.pot += raiseAmount;
      const raiseSize = actualBet - room.currentBet;
      room.minRaise = Math.max(room.bigBlind, raiseSize);
      room.currentBet = actualBet;
      if (player.chips === 0) player.allIn = true;
      player.hasActed = true;
      // Reset hasActed for everyone else (they need to respond to the raise)
      for (const p of room.players) {
        if (p !== player && !p.folded && !p.allIn && !p.sittingOut) {
          p.hasActed = false;
        }
      }
      room.lastRaiserIndex = playerIndex;
      break;
    }

    case 'allin': {
      const allInAmount = player.chips;
      const newBet = player.bet + allInAmount;
      player.totalBet += allInAmount;
      room.pot += allInAmount;
      player.chips = 0;
      player.allIn = true;
      player.hasActed = true;
      if (newBet > room.currentBet) {
        const raiseSize = newBet - room.currentBet;
        room.minRaise = Math.max(room.bigBlind, raiseSize);
        room.currentBet = newBet;
        // Reset hasActed for everyone else
        for (const p of room.players) {
          if (p !== player && !p.folded && !p.allIn && !p.sittingOut) {
            p.hasActed = false;
          }
        }
        room.lastRaiserIndex = playerIndex;
      }
      player.bet = newBet;
      break;
    }

    default:
      return { error: 'Неизвестное действие' };
  }

  // Check if only one non-folded player remains
  const activePlayers = getActivePlayers(room);
  if (activePlayers.length === 1) {
    const winAmount = room.pot;
    activePlayers[0].chips += winAmount;
    activePlayers[0].stats.handsWon++;
    activePlayers[0].stats.totalWinnings += winAmount;
    activePlayers[0].stats.biggestWin = Math.max(activePlayers[0].stats.biggestWin, winAmount);
    // Persist to DB
    usersDb.addStats(activePlayers[0].userId, 'handsWon', 1);
    usersDb.addStats(activePlayers[0].userId, 'totalWinnings', winAmount);
    usersDb.addStats(activePlayers[0].userId, 'biggestWin', winAmount);
    // Count hands played for all non-sitting-out players
    for (const p of room.players) {
      if (!p.sittingOut) {
        p.stats.handsPlayed++;
        usersDb.addStats(p.userId, 'handsPlayed', 1);
      }
    }
    room.pot = 0;
    room.phase = 'showdown';
    room.currentPlayerIndex = -1;
    return {
      finished: true,
      winners: [{ player: activePlayers[0], amount: winAmount }],
    };
  }

  // Check if betting round is over
  if (isBettingRoundOver(room)) {
    return advancePhase(room);
  }

  // Next player
  advanceToNextActor(room);
  if (room.currentPlayerIndex === -1) {
    return advancePhase(room);
  }

  return { continue: true };
}

function advancePhase(room) {
  // Reset bets for new round
  for (const p of room.players) {
    p.bet = 0;
    p.hasActed = false;
  }
  room.currentBet = 0;
  room.minRaise = room.bigBlind;
  room.lastRaiserIndex = -1;

  switch (room.phase) {
    case 'preflop':
      room.phase = 'flop';
      room.deck.pop(); // burn
      room.community.push(room.deck.pop(), room.deck.pop(), room.deck.pop());
      break;
    case 'flop':
      room.phase = 'turn';
      room.deck.pop();
      room.community.push(room.deck.pop());
      break;
    case 'turn':
      room.phase = 'river';
      room.deck.pop();
      room.community.push(room.deck.pop());
      break;
    case 'river':
      room.phase = 'showdown';
      return resolveShowdown(room);
  }

  // Check if we can continue betting
  const canAct = getPlayersWhoCanAct(room);
  if (canAct.length <= 1) {
    // Everyone is all-in or folded, deal remaining cards
    while (room.community.length < 5) {
      room.deck.pop();
      room.community.push(room.deck.pop());
    }
    room.phase = 'showdown';
    return resolveShowdown(room);
  }

  // Set first to act post-flop: first active player after dealer
  room.currentPlayerIndex = findNextCanAct(room, room.dealerIndex);
  if (room.currentPlayerIndex === -1) {
    return resolveShowdown(room);
  }

  return { continue: true, newPhase: room.phase };
}

function resolveShowdown(room) {
  // Count hands played for everyone active this hand
  for (const p of room.players) {
    if (!p.sittingOut) {
      p.stats.handsPlayed++;
      usersDb.addStats(p.userId, 'handsPlayed', 1);
    }
  }

  const activePlayers = getActivePlayers(room);
  const results = [];

  for (const p of activePlayers) {
    const allCards = [...p.hand, ...room.community];
    const best = poker.evaluateHand(allCards);
    results.push({ player: p, hand: best });
  }

  results.sort((a, b) => (b.hand?.score || 0) - (a.hand?.score || 0));

  const winners = calculateWinners(room, results);
  room.phase = 'showdown';
  room.currentPlayerIndex = -1;
  // Winners must show cards at showdown (poker rules)
  room.showdownWinnerIds = winners.map(w => w.player.id);
  // Auto-decide for winners (must show) and folded players
  for (const p of room.players) {
    if (p.sittingOut || p.folded) {
      p.showdownDecided = true;
    } else if (room.showdownWinnerIds.includes(p.id)) {
      p.showdownDecided = true;
      p.peeked = [true, true]; // force reveal
    }
  }
  return { finished: true, winners, results };
}

function buildSidePots(room) {
  return poker.buildSidePots(room);
}

function calculateWinners(room, results) {
  if (results.length === 0) return [];

  const sidePots = buildSidePots(room);
  const allWinners = [];
  const winnerSet = new Set();

  if (sidePots.length <= 1) {
    // Simple case — one pot
    const bestScore = results[0].hand?.score || 0;
    const winners = results.filter(r => (r.hand?.score || 0) === bestScore);
    const share = Math.floor(room.pot / winners.length);
    const remainder = room.pot % winners.length;

    for (let i = 0; i < winners.length; i++) {
      const w = winners[i];
      const amount = share + (i === 0 ? remainder : 0);
      w.player.chips += amount;
      if (!winnerSet.has(w.player.id)) {
        w.player.stats.handsWon++;
        usersDb.addStats(w.player.userId, 'handsWon', 1);
        winnerSet.add(w.player.id);
      }
      w.player.stats.totalWinnings += amount;
      w.player.stats.biggestWin = Math.max(w.player.stats.biggestWin, amount);
      usersDb.addStats(w.player.userId, 'totalWinnings', amount);
      usersDb.addStats(w.player.userId, 'biggestWin', amount);
      allWinners.push({ player: w.player, amount, hand: w.hand, potName: 'Основной банк' });
    }
  } else {
    // Side pots
    for (let pi = 0; pi < sidePots.length; pi++) {
      const pot = sidePots[pi];
      const potName = pi === 0 ? 'Основной банк' : `Сайд-пот ${pi}`;

      const eligibleResults = results.filter(r => pot.eligible.includes(r.player));
      if (eligibleResults.length === 0) continue;

      const bestScore = eligibleResults[0].hand?.score || 0;
      const potWinners = eligibleResults.filter(r => (r.hand?.score || 0) === bestScore);
      const share = Math.floor(pot.amount / potWinners.length);
      const remainder = pot.amount % potWinners.length;

      for (let i = 0; i < potWinners.length; i++) {
        const w = potWinners[i];
        const amount = share + (i === 0 ? remainder : 0);
        w.player.chips += amount;
        if (!winnerSet.has(w.player.id)) {
          w.player.stats.handsWon++;
          usersDb.addStats(w.player.userId, 'handsWon', 1);
          winnerSet.add(w.player.id);
        }
        w.player.stats.totalWinnings += amount;
        w.player.stats.biggestWin = Math.max(w.player.stats.biggestWin, amount);
        usersDb.addStats(w.player.userId, 'totalWinnings', amount);
        usersDb.addStats(w.player.userId, 'biggestWin', amount);
        allWinners.push({ player: w.player, amount, hand: w.hand, potName });
      }
    }
  }

  room.pot = 0;
  return allWinners;
}

function getGameState(room, forPlayerId) {
  return {
    code: room.code,
    state: room.state,
    phase: room.phase,
    community: room.community,
    pot: room.pot,
    currentBet: room.currentBet,
    dealerIndex: room.dealerIndex,
    currentPlayerIndex: room.currentPlayerIndex,
    smallBlind: room.smallBlind,
    bigBlind: room.bigBlind,
    minRaise: room.minRaise,
    handNumber: room.handNumber,
    buyIn: room.buyIn || 1000,
    deckCount: room.deck ? room.deck.length : 0,
    sbIndex: room.sbIndex ?? -1,
    bbIndex: room.bbIndex ?? -1,
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      chips: p.chips,
      bet: p.bet,
      folded: p.folded,
      allIn: p.allIn,
      sittingOut: p.sittingOut,
      isConnected: p.isConnected,
      hand: (() => {
        // Always show own cards
        if (p.id === forPlayerId) return p.hand;
        // At showdown
        if (room.phase === 'showdown' && !p.folded) {
          // Winners must show
          const isWinner = (room.showdownWinnerIds || []).includes(p.id);
          if (isWinner) return p.hand;
          // Others: show only if they explicitly chose show-hand (showdownDecided + not mucked)
          if (p.showdownDecided && !p.mucked) return p.hand;
        }
        return null;
      })(),
      isMe: p.id === forPlayerId,
      isCurrent: i === room.currentPlayerIndex && room.state === 'playing' && room.phase !== 'showdown',
      peeked: p.peeked,
      mucked: p.mucked,
      showdownDecided: p.showdownDecided,
      mustShow: room.phase === 'showdown' && (room.showdownWinnerIds || []).includes(p.id),
      ready: p.ready,
      avatar: p.avatar || null,
      stats: usersDb.getUser(p.userId)?.stats || p.stats,
    })),
    myIndex: room.players.findIndex(p => p.id === forPlayerId),
  };
}

// ============ SHOWDOWN COMPLETION ============

function checkShowdownComplete(room, roomCode) {
  const undecided = room.players.filter(p => !p.sittingOut && !p.folded && !p.showdownDecided);
  if (undecided.length > 0) return;

  broadcastState(room);

  // После вскрытия клиент ждёт ~3 с отсчёт + показ победителя на сукне — иначе сразу уходит в waiting
  const SHOWDOWN_TABLE_MS = 5200;
  setTimeout(() => {
    if (rooms[roomCode] && rooms[roomCode].phase === 'showdown') {
      rooms[roomCode].state = 'waiting';
      rooms[roomCode].phase = 'preflop';
      for (const p of rooms[roomCode].players) p.ready = false;
      broadcastState(rooms[roomCode]);
    }
  }, SHOWDOWN_TABLE_MS);
}

// ============ HAND HISTORY ============

function saveHandHistory(room, result) {
  const entry = {
    handNumber: room.handNumber,
    community: [...room.community],
    pot: room.players.reduce((s, p) => s + p.totalBet, 0),
    players: room.players.filter(p => !p.sittingOut).map(p => ({
      name: p.name,
      hand: p.hand ? [...p.hand] : [],
      chips: p.chips,
      folded: p.folded,
      totalBet: p.totalBet,
    })),
    winners: (result.winners || []).map(w => ({
      name: w.player.name,
      amount: w.amount,
      hand: w.hand?.nameRu || '',
      potName: w.potName || '',
    })),
  };
  room.history.push(entry);
  if (room.history.length > 20) room.history.shift();
}

function processActionResult(room, roomCode, playerIndex, playerName, action, amount, result) {
  let actionText = '';
  if (action === 'fold') actionText = 'Фолд';
  else if (action === 'check') actionText = 'Чек';
  else if (action === 'call') actionText = 'Колл';
  else if (action === 'raise') actionText = `Рейз ${amount}`;
  else if (action === 'allin') actionText = 'Олл-ин!';
  if (actionText) {
    io.to(roomCode).emit('player-action', { playerIndex, name: playerName, action: actionText });
  }

  if (result.finished) {
    broadcastState(room);
    io.to(roomCode).emit('showdown', {
      winners: result.winners?.map(w => ({
        name: w.player.name,
        amount: w.amount,
        hand: w.hand?.nameRu || '',
        potName: w.potName || '',
      })),
      results: result.results?.map(r => ({
        name: r.player.name,
        hand: r.hand?.nameRu || 'Неизвестно',
        cards: r.player.hand,
      })),
    });

    saveHandHistory(room, result);

    if (!result.results) {
      const FOLD_WIN_TO_WAIT_MS = 4500;
      setTimeout(() => {
        if (rooms[roomCode] && rooms[roomCode].phase === 'showdown') {
          const r = rooms[roomCode];
          r.state = 'waiting';
          r.phase = 'preflop';
          for (const p of r.players) p.ready = false;
          broadcastState(r);
        }
      }, FOLD_WIN_TO_WAIT_MS);
    } else {
      checkShowdownComplete(room, roomCode);
    }
  } else {
    broadcastState(room);
  }
}

// ============ SOCKET.IO ============

// Map socket.id -> authenticated user info
const socketUsers = {};
// Map userId -> roomCode for reconnect
const userRooms = {};
// Map userId -> disconnect timeout
const disconnectTimers = {};

io.on('connection', (socket) => {
  let currentRoom = null;

  // ---- AUTH ----
  socket.on('register', ({ name, password }, callback) => {
    const result = usersDb.register(name, password);
    if (result.error) return callback({ error: result.error });
    socketUsers[socket.id] = result.user;
    callback({ token: result.token, user: result.user });
  });

  socket.on('login', ({ name, password }, callback) => {
    const result = usersDb.login(name, password);
    if (result.error) return callback({ error: result.error });
    socketUsers[socket.id] = result.user;
    callback({ token: result.token, user: result.user });
  });

  socket.on('auth', ({ token }, callback) => {
    const user = usersDb.authByToken(token);
    if (!user) return callback({ error: 'Токен недействителен' });
    socketUsers[socket.id] = user;

    // Check for reconnect
    const roomCode = userRooms[user.id];
    if (roomCode && rooms[roomCode]) {
      const room = rooms[roomCode];
      const player = room.players.find(p => p.userId === user.id);
      if (player) {
        // Cancel disconnect timer
        if (disconnectTimers[user.id]) {
          clearTimeout(disconnectTimers[user.id]);
          delete disconnectTimers[user.id];
        }
        // Reconnect: update socket id
        player.id = socket.id;
        player.isConnected = true;
        currentRoom = roomCode;
        socket.join(roomCode);
        broadcastState(room);
        return callback({ user, reconnect: true, roomCode });
      }
    }

    callback({ user });
  });

  socket.on('set-avatar', ({ avatar }, callback) => {
    const user = socketUsers[socket.id];
    if (!user) return callback?.({ error: 'Необходимо войти' });
    if (usersDb.setAvatar(user.id, avatar)) {
      user.avatar = avatar;
      // Update avatar in current room if playing
      if (currentRoom && rooms[currentRoom]) {
        const player = rooms[currentRoom].players.find(p => p.userId === user.id);
        if (player) player.avatar = avatar;
        broadcastState(rooms[currentRoom]);
      }
      callback?.({ ok: true });
    } else {
      callback?.({ error: 'Ошибка загрузки' });
    }
  });

  // Helper: get authenticated user
  function getAuthUser() {
    return socketUsers[socket.id] || null;
  }

  // ---- ROOMS ----
  socket.on('create-room', ({ buyIn, smallBlind, bigBlind }, callback) => {
    const user = getAuthUser();
    if (!user) return callback({ error: 'Необходимо войти' });
    const code = createRoom({ buyIn, smallBlind, bigBlind });
    const room = rooms[code];
    addPlayer(room, socket.id, user.name, user.id);
    currentRoom = code;
    userRooms[user.id] = code;
    socket.join(code);
    callback({ code });
    broadcastState(room);
  });

  socket.on('join-room', ({ code }, callback) => {
    const user = getAuthUser();
    if (!user) return callback({ error: 'Необходимо войти' });
    const roomCode = code.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return callback({ error: 'Комната не найдена' });
    if (room.state === 'playing') return callback({ error: 'Игра уже началась' });
    if (room.players.length >= 8) return callback({ error: 'Комната полна' });

    if (!addPlayer(room, socket.id, user.name, user.id)) {
      return callback({ error: 'Не удалось присоединиться' });
    }

    currentRoom = roomCode;
    userRooms[user.id] = roomCode;
    socket.join(roomCode);
    callback({ code: roomCode });
    broadcastState(room);
  });

  socket.on('rebuy', ({ amount }, callback) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'waiting') return callback?.({ error: 'Ребай только между раздачами' });
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return callback?.({ error: 'Игрок не найден' });
    const rebuyAmount = parseInt(amount);
    if (!rebuyAmount || rebuyAmount < 1) return callback?.({ error: 'Некорректная сумма' });
    if (rebuyAmount > room.buyIn * 2) return callback?.({ error: `Максимум: ${room.buyIn * 2}` });
    player.chips += rebuyAmount;
    player.sittingOut = false;
    broadcastState(room);
    callback?.({ ok: true, chips: player.chips });
  });

  socket.on('toggle-ready', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'waiting') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastState(room);
    // Check if all eligible players are ready
    tryAutoStart(room);
  });

  // Keep start-game for backward compat
  socket.on('start-game', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.players[0]?.id !== socket.id) return;
    // Mark all as ready and start
    for (const p of room.players) p.ready = true;
    if (startGame(room)) {
      broadcastState(room);
    }
  });

  socket.on('action', ({ action, amount }, callback) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.state !== 'playing' || room.phase === 'showdown') return;

    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    const playerName = room.players[playerIndex]?.name || '';

    const result = handleAction(room, socket.id, action, amount);
    if (result.error) {
      return callback?.({ error: result.error });
    }

    processActionResult(room, currentRoom, playerIndex, playerName, action, amount, result);

    callback?.({ ok: true });
  });

  socket.on('get-hint', (callback) => {
    if (!currentRoom || !rooms[currentRoom]) return callback?.({ hint: '' });
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.hand || player.hand.length === 0) return callback?.({ hint: '' });

    const allCards = [...player.hand, ...room.community];

    if (allCards.length >= 5) {
    const best = poker.evaluateHand(allCards);
      if (best) {
        return callback?.({ hint: `Ваша комбинация: ${best.nameRu}` });
      }
    }

    // Only hole cards — starting hand advice
    const h = player.hand;
    if (h.length < 2) return callback?.({ hint: '' });
    const isPair = h[0].rank === h[1].rank;
    const isSuited = h[0].suit === h[1].suit;
    const highCard = Math.max(h[0].value, h[1].value);
    const lowCard = Math.min(h[0].value, h[1].value);

    let advice = '';
    if (isPair && highCard >= 10) advice = 'Сильная пара! Играйте агрессивно.';
    else if (isPair) advice = 'Карманная пара. Хорошая стартовая рука.';
    else if (highCard === 14 && lowCard >= 10) advice = 'Сильные карты! Можно рейзить.';
    else if (isSuited && highCard >= 10) advice = 'Одномастные старшие. Потенциал для флеша.';
    else if (isSuited && highCard - lowCard <= 4) advice = 'Одномастные коннекторы. Потенциал.';
    else if (highCard >= 10) advice = 'Старшие карты. Играйте осторожно.';
    else advice = 'Слабая рука. Рассмотрите фолд.';

    callback?.({ hint: advice });
  });

  socket.on('peek-card', ({ cardIndex }) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player || !player.hand || cardIndex < 0 || cardIndex > 1) return;
    player.peeked[cardIndex] = !player.peeked[cardIndex];
    // Notify all players about peek change without full re-render
    const playerIndex = room.players.indexOf(player);
    io.to(currentRoom).emit('peek-update', { playerIndex, peeked: [...player.peeked] });
  });

  socket.on('muck-hand', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'showdown') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.showdownDecided) return;
    player.mucked = true;
    player.showdownDecided = true;
    broadcastState(room);
    checkShowdownComplete(room, currentRoom);
  });

  socket.on('show-hand', () => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    if (room.phase !== 'showdown') return;
    const player = room.players.find(p => p.id === socket.id);
    if (!player || player.showdownDecided) return;
    player.peeked = [true, true];
    player.showdownDecided = true;
    broadcastState(room);
    checkShowdownComplete(room, currentRoom);
  });

  socket.on('get-history', (callback) => {
    if (!currentRoom || !rooms[currentRoom]) return callback?.({ history: [] });
    callback?.({ history: rooms[currentRoom].history });
  });

  socket.on('chat', (message) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    io.to(currentRoom).emit('chat', {
      name: rooms[currentRoom].players.find(p => p.id === socket.id)?.name || 'Аноним',
      message: String(message).substring(0, 200),
    });
  });

  socket.on('get-leaderboard', (callback) => {
    callback?.({ leaderboard: usersDb.getLeaderboard() });
  });

  socket.on('emoji', (emoji) => {
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex === -1) return;
    io.to(currentRoom).emit('emoji', { playerIndex, emoji: String(emoji).substring(0, 4) });
  });

  socket.on('spectate', ({ code }, callback) => {
    const roomCode = code.toUpperCase();
    const room = rooms[roomCode];
    if (!room) return callback?.({ error: 'Комната не найдена' });
    currentRoom = roomCode;
    socket.join(roomCode);
    // Send state but player is not in the game — spectator
    callback?.({ code: roomCode, spectating: true });
    socket.emit('game-state', getGameState(room, '__spectator__'));
  });

  socket.on('leave-table', (callback) => {
    if (!currentRoom || !rooms[currentRoom]) return callback?.({ ok: true });
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return callback?.({ ok: true });

    const chipsLeft = player.chips;

    if (room.state === 'playing') {
      // Fold if it's their turn
      const pIdx = room.players.indexOf(player);
      if (pIdx === room.currentPlayerIndex && !player.folded && !player.allIn) {
        handleAction(room, socket.id, 'fold');
      } else {
        player.folded = true;
      }
    }

    // Remove player from room + cleanup timers
    const user = getAuthUser();
    if (user) {
      delete userRooms[user.id];
      if (disconnectTimers[user.id]) {
        clearTimeout(disconnectTimers[user.id]);
        delete disconnectTimers[user.id];
      }
    }
    removePlayer(room, socket.id);
    socket.leave(currentRoom);

    // Notify remaining players
    io.to(currentRoom).emit('player-left', { name: player.name, chips: chipsLeft });
    broadcastState(room);

    // Clean up empty rooms
    if (room.players.length === 0) {
      delete rooms[currentRoom];
    }

    currentRoom = null;
    callback?.({ ok: true, chipsReturned: chipsLeft });
  });

  socket.on('disconnect', () => {
    delete socketUsers[socket.id];
    if (!currentRoom || !rooms[currentRoom]) return;
    const room = rooms[currentRoom];
    const player = room.players.find(p => p.id === socket.id);
    if (!player) return;

    player.isConnected = false;
    const roomCode = currentRoom;
    const userId = player.userId;

    // If playing and it's their turn, fold
    if (room.state === 'playing') {
      const pIdx = room.players.indexOf(player);
      if (pIdx === room.currentPlayerIndex && !player.folded && !player.allIn) {
        const result = handleAction(room, socket.id, 'fold');
        if (result.finished) {
          io.to(roomCode).emit('showdown', {
            winners: result.winners?.map(w => ({
              name: w.player.name,
              amount: w.amount,
              hand: w.hand?.nameRu || '',
              potName: w.potName || '',
            })),
          });
          saveHandHistory(room, result);
        }
      } else if (!player.folded) {
        player.folded = true;
      }
    }

    broadcastState(room);

    // Set 2-minute reconnect timer
    disconnectTimers[userId] = setTimeout(() => {
      if (rooms[roomCode]) {
        const r = rooms[roomCode];
        const p = r.players.find(pl => pl.userId === userId);
        if (p && !p.isConnected) {
          removePlayer(r, p.id);
          delete userRooms[userId];
          broadcastState(r);
          if (r.players.length === 0) delete rooms[roomCode];
        }
      }
      delete disconnectTimers[userId];
    }, 120000); // 2 minutes
  });
});

function tryAutoStart(room) {
  if (room.state !== 'waiting') return;
  const eligible = room.players.filter(p => p.chips > 0 && p.isConnected);
  if (eligible.length < 2) return;
  const allReady = eligible.every(p => p.ready);
  if (!allReady) return;
  if (startGame(room)) {
    broadcastState(room);
  }
}

function broadcastState(room) {
  for (const player of room.players) {
    if (player.isConnected) {
      io.to(player.id).emit('game-state', getGameState(room, player.id));
    }
  }
}

const PORT = process.env.PORT || 3000;

module.exports = { app, server, io };

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Poker server running on http://localhost:${PORT}`);
  });
}
