const crypto = require('crypto');

const SUITS = ['hearts', 'diamonds', 'clubs', 'spades'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
const RANK_VALUES = {
  '2': 2,
  '3': 3,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 7,
  '8': 8,
  '9': 9,
  '10': 10,
  J: 11,
  Q: 12,
  K: 13,
  A: 14,
};

const HAND_NAMES = {
  'royal-flush': 'Роял-флеш',
  'straight-flush': 'Стрит-флеш',
  'four-of-a-kind': 'Каре',
  'full-house': 'Фулл-хаус',
  flush: 'Флеш',
  straight: 'Стрит',
  'three-of-a-kind': 'Тройка',
  'two-pair': 'Две пары',
  'one-pair': 'Пара',
  'high-card': 'Старшая карта',
};

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push({ suit, rank, value: RANK_VALUES[rank] });
    }
  }
  return shuffle(deck);
}

function getCombinations(arr, k) {
  const results = [];
  function combine(start, combo) {
    if (combo.length === k) {
      results.push([...combo]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      combo.push(arr[i]);
      combine(i + 1, combo);
      combo.pop();
    }
  }
  combine(0, []);
  return results;
}

function checkStraight(values) {
  for (let i = 0; i < values.length - 1; i++) {
    if (values[i] - values[i + 1] !== 1) return false;
  }
  return true;
}

function checkLowStraight(values) {
  const low = [...values].sort((a, b) => a - b);
  return low[0] === 2 && low[1] === 3 && low[2] === 4 && low[3] === 5 && low[4] === 14;
}

function evaluate5(cards) {
  const sorted = [...cards].sort((a, b) => b.value - a.value);
  const values = sorted.map((c) => c.value);
  const suits = sorted.map((c) => c.suit);

  const isFlush = suits.every((s) => s === suits[0]);
  const isStraight = checkStraight(values);
  const isLowStraight = !isStraight && checkLowStraight(values);

  const counts = {};
  for (const v of values) counts[v] = (counts[v] || 0) + 1;
  const groups = Object.entries(counts).sort((a, b) => b[1] - a[1] || b[0] - a[0]);

  if (isFlush && isStraight && values[0] === 14) {
    return { name: 'royal-flush', score: 9000000 + values[0], nameRu: HAND_NAMES['royal-flush'] };
  }
  if (isFlush && (isStraight || isLowStraight)) {
    const high = isLowStraight ? 5 : values[0];
    return { name: 'straight-flush', score: 8000000 + high, nameRu: HAND_NAMES['straight-flush'] };
  }
  if (groups[0][1] === 4) {
    return {
      name: 'four-of-a-kind',
      score: 7000000 + parseInt(groups[0][0]) * 15 + parseInt(groups[1][0]),
      nameRu: HAND_NAMES['four-of-a-kind'],
    };
  }
  if (groups[0][1] === 3 && groups[1][1] === 2) {
    return {
      name: 'full-house',
      score: 6000000 + parseInt(groups[0][0]) * 15 + parseInt(groups[1][0]),
      nameRu: HAND_NAMES['full-house'],
    };
  }
  if (isFlush) {
    return {
      name: 'flush',
      score:
        5000000 +
        values[0] * 15 * 15 * 15 * 15 +
        values[1] * 15 * 15 * 15 +
        values[2] * 15 * 15 +
        values[3] * 15 +
        values[4],
      nameRu: HAND_NAMES.flush,
    };
  }
  if (isStraight || isLowStraight) {
    const high = isLowStraight ? 5 : values[0];
    return { name: 'straight', score: 4000000 + high, nameRu: HAND_NAMES.straight };
  }
  if (groups[0][1] === 3) {
    const kickers = groups
      .slice(1)
      .map((g) => parseInt(g[0]))
      .sort((a, b) => b - a);
    return {
      name: 'three-of-a-kind',
      score: 3000000 + parseInt(groups[0][0]) * 225 + kickers[0] * 15 + kickers[1],
      nameRu: HAND_NAMES['three-of-a-kind'],
    };
  }
  if (groups[0][1] === 2 && groups[1][1] === 2) {
    const pairs = [parseInt(groups[0][0]), parseInt(groups[1][0])].sort((a, b) => b - a);
    return {
      name: 'two-pair',
      score: 2000000 + pairs[0] * 225 + pairs[1] * 15 + parseInt(groups[2][0]),
      nameRu: HAND_NAMES['two-pair'],
    };
  }
  if (groups[0][1] === 2) {
    const kickers = groups
      .slice(1)
      .map((g) => parseInt(g[0]))
      .sort((a, b) => b - a);
    return {
      name: 'one-pair',
      score: 1000000 + parseInt(groups[0][0]) * 3375 + kickers[0] * 225 + kickers[1] * 15 + kickers[2],
      nameRu: HAND_NAMES['one-pair'],
    };
  }
  return {
    name: 'high-card',
    score: values[0] * 15 * 15 * 15 * 15 + values[1] * 15 * 15 * 15 + values[2] * 15 * 15 + values[3] * 15 + values[4],
    nameRu: HAND_NAMES['high-card'],
  };
}

function evaluateHand(cards) {
  if (!cards || cards.length < 5) return null;
  const combos = getCombinations(cards, 5);
  let best = null;
  for (const combo of combos) {
    const result = evaluate5(combo);
    if (!best || result.score > best.score) {
      best = result;
      best.cards = combo;
    }
  }
  return best;
}

function buildSidePots(room) {
  const allBettors = room.players.filter((p) => !p.sittingOut && p.totalBet > 0);
  if (allBettors.length === 0) return [];

  const allInLevels = allBettors
    .filter((p) => p.allIn)
    .map((p) => p.totalBet)
    .filter((v, i, a) => a.indexOf(v) === i)
    .sort((a, b) => a - b);

  if (allInLevels.length === 0) return [{ amount: room.pot, eligible: allBettors.filter((p) => !p.folded) }];

  const pots = [];
  let prevLevel = 0;

  const levels = [...allInLevels];
  const maxBet = Math.max(...allBettors.map((p) => p.totalBet));
  if (!levels.includes(maxBet)) levels.push(maxBet);

  for (const level of levels) {
    if (level <= prevLevel) continue;
    const diff = level - prevLevel;

    let potAmount = 0;
    for (const p of allBettors) {
      potAmount += Math.min(diff, Math.max(0, p.totalBet - prevLevel));
    }

    const eligible = allBettors.filter((p) => !p.folded && p.totalBet >= level);

    if (potAmount > 0 && eligible.length > 0) {
      pots.push({ amount: potAmount, eligible });
    }

    prevLevel = level;
  }

  return pots;
}

module.exports = {
  createDeck,
  evaluateHand,
  buildSidePots,
};

