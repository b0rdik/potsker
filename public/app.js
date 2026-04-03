const socket = io();

let gameState = null;
let prevHandNumber = 0;
let prevPhase = '';
let prevCommunityCount = 0;
let wasMyTurn = false;

const SUIT_SYMBOLS = {
  hearts: '\u2665',
  diamonds: '\u2666',
  clubs: '\u2663',
  spades: '\u2660',
};

const PHASE_NAMES = {
  preflop: 'Префлоп',
  flop: 'Флоп',
  turn: 'Тёрн',
  river: 'Ривер',
  showdown: 'Вскрытие',
};

// ======== AUTH ========

let currentUser = null;

function switchAuthTab(tab) {
  document.getElementById('loginForm').style.display = tab === 'login' ? 'block' : 'none';
  document.getElementById('registerForm').style.display = tab === 'register' ? 'block' : 'none';
  document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.auth-tab:${tab === 'login' ? 'first-child' : 'last-child'}`).classList.add('active');
  document.getElementById('authError').textContent = '';
}

function doLogin() {
  const name = document.getElementById('loginName').value.trim();
  const password = document.getElementById('loginPassword').value;
  if (!name || !password) {
    document.getElementById('authError').textContent = 'Заполните все поля';
    return;
  }
  socket.emit('login', { name, password }, (res) => {
    if (res.error) {
      document.getElementById('authError').textContent = res.error;
    } else {
      localStorage.setItem('pokerToken', res.token);
      currentUser = res.user;
      showLobby();
    }
  });
}

function doRegister() {
  const name = document.getElementById('regName').value.trim();
  const password = document.getElementById('regPassword').value;
  const confirm = document.getElementById('regPasswordConfirm').value;
  if (!name || !password || !confirm) {
    document.getElementById('authError').textContent = 'Заполните все поля';
    return;
  }
  if (password !== confirm) {
    document.getElementById('authError').textContent = 'Пароли не совпадают';
    return;
  }
  if (password.length < 8) {
    document.getElementById('authError').textContent = 'Пароль минимум 8 символов';
    return;
  }
  socket.emit('register', { name, password }, (res) => {
    if (res.error) {
      document.getElementById('authError').textContent = res.error;
    } else {
      localStorage.setItem('pokerToken', res.token);
      currentUser = res.user;
      showLobby();
    }
  });
}

function tryAutoAuth() {
  const token = localStorage.getItem('pokerToken');
  if (!token) return;
  socket.emit('auth', { token }, (res) => {
    if (res.error) {
      localStorage.removeItem('pokerToken');
      // Ensure auth screen is visible
      document.getElementById('auth').classList.add('active');
    } else {
      currentUser = res.user;
      if (res.reconnect && res.roomCode) {
        // Reconnect to existing game
        showGame(res.roomCode);
      } else {
        showLobby();
      }
    }
  });
}

// Auto-login on connect
socket.on('connect', () => {
  tryAutoAuth();
});

function showLobby() {
  document.getElementById('auth').classList.remove('active');
  document.getElementById('lobby').classList.add('active');
  const info = document.getElementById('lobbyUserInfo');
  const s = currentUser.stats || {};
  const winRate = s.handsPlayed > 0 ? Math.round(s.handsWon / s.handsPlayed * 100) : 0;
  info.innerHTML = `
    <div class="user-card">
      <div class="avatar-wrapper" onclick="document.getElementById('avatarFileInput').click()" title="Нажмите чтобы сменить фото">
        ${renderAvatar(currentUser.avatar, currentUser.name, 'avatar-lg')}
      </div>
      <div class="user-card-info">
        <div class="user-name">${esc(currentUser.name)}</div>
        <div class="user-stats-mini">
          Игр: ${s.gamesPlayed || 0} | Побед: ${s.handsWon || 0} | Винрейт: ${winRate}%
        </div>
      </div>
      <button class="btn-small" onclick="doLogout()">Выйти</button>
    </div>
  `;
}

function doLogout() {
  localStorage.removeItem('pokerToken');
  currentUser = null;
  document.getElementById('lobby').classList.remove('active');
  document.getElementById('auth').classList.add('active');
}

// ======== LOBBY ========

document.getElementById('btnCreate').onclick = () => {
  if (!currentUser) return;
  const buyIn = parseInt(document.getElementById('buyInInput').value) || 1000;
  const sb = parseInt(document.getElementById('sbInput').value) || 10;
  const bb = parseInt(document.getElementById('bbInput').value) || 20;
  if (buyIn < bb * 5) {
    document.getElementById('lobbyError').textContent = 'Фишки должны быть минимум 5x большого блайнда';
    return;
  }
  if (sb >= bb) {
    document.getElementById('lobbyError').textContent = 'Малый блайнд должен быть меньше большого';
    return;
  }
  socket.emit('create-room', { buyIn, smallBlind: sb, bigBlind: bb }, (res) => {
    if (res.error) {
      document.getElementById('lobbyError').textContent = res.error;
    } else {
      showGame(res.code);
    }
  });
};

document.getElementById('btnJoin').onclick = () => {
  if (!currentUser) return;
  const code = document.getElementById('roomCode').value.trim().toUpperCase();
  if (!code) {
    document.getElementById('lobbyError').textContent = 'Введите код комнаты';
    return;
  }
  socket.emit('join-room', { code }, (res) => {
    if (res.error) {
      document.getElementById('lobbyError').textContent = res.error;
    } else {
      showGame(res.code);
    }
  });
};

document.getElementById('roomCode').addEventListener('keyup', (e) => {
  if (e.key === 'Enter') document.getElementById('btnJoin').click();
});

function leaveTable() {
  if (!confirm('Выйти со стола? Ваши оставшиеся фишки будут возвращены.')) return;
  socket.emit('leave-table', (res) => {
    // Go back to lobby
    document.getElementById('game').classList.remove('active');
    document.getElementById('lobby').classList.add('active');
    gameState = null;
    showLobby();
  });
}

document.getElementById('btnCopyCode').onclick = () => {
  const code = document.getElementById('displayRoomCode').textContent;
  navigator.clipboard?.writeText(code);
  const btn = document.getElementById('btnCopyCode');
  btn.textContent = '\u2713';
  setTimeout(() => { btn.textContent = '\uD83D\uDCCB'; }, 1500);
};

function showGame(code) {
  resetClientShowdownState();
  prevHandNumber = 0;
  prevPhase = '';
  prevCommunityCount = 0;
  wasMyTurn = false;
  document.getElementById('auth').classList.remove('active');
  document.getElementById('lobby').classList.remove('active');
  document.getElementById('game').classList.add('active');
  document.getElementById('displayRoomCode').textContent = code;
  document.getElementById('waitingCode').textContent = code;
}

// ======== GAME STATE ========

socket.on('game-state', (state) => {
  gameState = state;
  renderGame();
});

// Handle peek without full re-render
socket.on('peek-update', (data) => {
  if (!gameState) return;
  const p = gameState.players[data.playerIndex];
  if (!p) return;
  p.peeked = data.peeked;

  // Update only the cards for this player's seat
  const seat = document.querySelector(`.seat[data-player-idx="${data.playerIndex}"]`);
  if (!seat) return;
  const cardsDiv = seat.querySelector('.player-cards');
  if (!cardsDiv) return;

  if (p.isMe && p.hand && p.hand[0]?.rank) {
    // My cards — update flip state with animation
    const cardEls = cardsDiv.querySelectorAll('.card');
    cardEls.forEach((el, idx) => {
      const flipped = data.peeked[idx];
      if (flipped && el.classList.contains('card-back')) {
        // Flip to front
        const c = p.hand[idx];
        const isRed = c.suit === 'hearts' || c.suit === 'diamonds';
        el.classList.remove('card-back');
        el.classList.add('card-front', 'card-flip-anim');
        if (isRed) el.classList.add('red');
        el.innerHTML = `<div class="card-rank">${c.rank}</div><div class="card-suit">${{'hearts':'\u2665','diamonds':'\u2666','clubs':'\u2663','spades':'\u2660'}[c.suit]}</div>`;
      } else if (!flipped && !el.classList.contains('card-back')) {
        // Flip to back
        el.className = 'card card-back card-mini card-flippable card-flip-anim';
        el.innerHTML = '';
        el.setAttribute('onclick', `peekCard(${idx})`);
      }
    });
  } else {
    // Other player — update peeked visual
    const cardEls = cardsDiv.querySelectorAll('.card');
    cardEls.forEach((el, idx) => {
      if (data.peeked[idx]) el.classList.add('card-peeked');
      else el.classList.remove('card-peeked');
    });
  }
});

socket.on('showdown', (data) => {
  showShowdown(data);
});

// Action notifications floating near players
socket.on('player-action', (data) => {
  showActionNotification(data.playerIndex, data.action);
});

// Player left table notification
socket.on('player-left', (data) => {
  addChatMessage('Система', `${data.name} покинул стол (${data.chips} фишек)`, true);
});

socket.on('player-rebuy', (data) => {
  const name = data.name || '?';
  const amount = data.amount ?? 0;
  showRebuyToast(name, amount);
  addChatMessage('Система', `${name} докупил ${amount} фишек`, true);
});

socket.on('game-over', (data) => {
  lastShowdownData = { winners: [{ name: data.winner, amount: 0, hand: 'Победитель турнира!' }] };
});

function renderGame() {
  if (!gameState) return;

  const { state, phase, community, pot, currentBet, dealerIndex,
    currentPlayerIndex, players, myIndex, smallBlind, bigBlind, handNumber } = gameState;

  // Detect new hand or phase change for animations
  const isNewHand = handNumber !== prevHandNumber;
  const isNewPhase = phase !== prevPhase;
  const newCommunityCards = community.length - prevCommunityCount;

  prevHandNumber = handNumber;
  prevPhase = phase;
  prevCommunityCount = community.length;

  // Header
  document.getElementById('blindsInfo').textContent = `Блайнды: ${smallBlind}/${bigBlind}`;
  const totalChips = players.reduce((sum, p) => sum + p.chips, 0) + pot;
  document.getElementById('totalChipsInfo').textContent = `На столе: ${totalChips}`;

  // Clear showdown data on new hand
  if (state === 'playing' && phase === 'preflop') {
    if (showdownCountdownTimer) {
      clearInterval(showdownCountdownTimer);
      showdownCountdownTimer = null;
    }
    showdownCountdownRemaining = 0;
    showdownWinnersVisible = false;
    showdownWinSoundPlayed = false;
    showdownRevealPending = false;
    lastShowdownData = null;
    clearShowdownTableUI();
  }

  // Ушли в ожидание до конца отсчёта — сразу показываем победителя (звук один раз)
  if (state === 'waiting' && showdownCountdownTimer) {
    clearInterval(showdownCountdownTimer);
    showdownCountdownTimer = null;
    showdownCountdownRemaining = 0;
    showdownRevealPending = false;
    if (!showdownWinnersVisible && lastShowdownData?.winners?.length) {
      showdownWinnersVisible = true;
      if (!showdownWinSoundPlayed) {
        playWin();
        showdownWinSoundPlayed = true;
      }
    }
  }

  // Waiting overlay
  const waitingOverlay = document.getElementById('waitingOverlay');
  if (state === 'waiting') {
    waitingOverlay.style.display = 'flex';
    const isFirstHand = handNumber === 0;
    document.querySelector('#waitingOverlay h2').textContent = isFirstHand ? 'Ожидание игроков...' : 'Ожидание следующей раздачи';
    document.getElementById('playerCount').textContent = `Игроков: ${players.length} / 8`;

    // Show last hand results if available
    const resultsDiv = document.getElementById('showdownResults') || (() => {
      const d = document.createElement('div');
      d.id = 'showdownResults';
      document.getElementById('readyList').before(d);
      return d;
    })();
    if (lastShowdownData?.winners) {
      resultsDiv.innerHTML = lastShowdownData.winners.map(w => `
        <div class="winner-entry" style="margin-bottom:8px;">
          <div class="winner-name">${esc(w.name)}</div>
          ${w.hand ? `<div class="winner-hand">${esc(w.hand)}</div>` : ''}
          <div class="winner-amount">+${w.amount} фишек</div>
        </div>
      `).join('');
    } else {
      resultsDiv.innerHTML = '';
    }

    // Ready list with chips
    const readyList = document.getElementById('readyList');
    readyList.innerHTML = players.map(p =>
      `<div class="ready-player ${p.ready ? 'is-ready' : ''}">
        <span class="ready-dot"></span>
        <span class="ready-name">${esc(p.name)}</span>
        <span class="ready-chips">\uD83E\uDE99 ${p.chips}</span>
      </div>`
    ).join('');

    // Ready button
    const btnReady = document.getElementById('btnReady');
    const me = players[myIndex];
    if (me) {
      btnReady.textContent = me.ready ? 'Не готов' : 'Готов';
      btnReady.className = me.ready
        ? 'btn btn-secondary btn-large btn-ready-active'
        : 'btn btn-primary btn-large';

      // Rebuy section
      const rebuyDiv = document.getElementById('rebuySection');
      if (rebuyDiv) {
        rebuyDiv.style.display = 'block';
        document.getElementById('rebuyMax').textContent = gameState.buyIn || 1000;
      }

      // Total chips
      const wtotal = players.reduce((s, p) => s + p.chips, 0);
      document.getElementById('waitingTotal').textContent = `На столе: ${wtotal}`;
    }
  } else {
    waitingOverlay.style.display = 'none';
  }

  // Calculate dealer visual position for deal animations
  const positions = getSeatPositions(players.length, myIndex);
  const dealerPos = dealerIndex >= 0 ? positions[dealerIndex] : 0;
  const dealerOffset = getSeatOffset(dealerPos);

  // Deck display
  const deckEl = document.getElementById('deckDisplay');
  if (state === 'playing' && gameState.deckCount > 0) {
    deckEl.style.display = 'flex';
    document.getElementById('deckCount').textContent = gameState.deckCount;
  } else {
    deckEl.style.display = 'none';
  }

  // Community cards
  renderCommunityCards(community, isNewPhase, newCommunityCards, dealerOffset);

  // Pot
  const potEl = document.getElementById('potDisplay');
  if (pot > 0) {
    potEl.innerHTML = `<div class="pot-chips">${renderChipIcons(pot, true)}</div>Банк: ${pot}`;
    if (isNewPhase) potEl.classList.add('pot-update');
    setTimeout(() => potEl.classList.remove('pot-update'), 400);
  } else {
    potEl.innerHTML = '';
  }

  // Phase
  document.getElementById('phaseIndicator').textContent =
    state === 'playing' ? (PHASE_NAMES[phase] || '') : '';

  // Seats
  renderSeats(players, myIndex, dealerIndex, isNewHand, dealerOffset);

  // Action bar
  renderActionBar(players, myIndex, currentBet, state, phase);

  if (
    phase === 'showdown' &&
    state !== 'waiting' &&
    lastShowdownData?.winners?.length &&
    showdownWinnersVisible
  ) {
    const sum = document.getElementById('showdownSummary');
    if (sum && !sum.querySelector('.showdown-summary__title')) {
      fillShowdownSummaryElement();
    }
  }
  syncShowdownSummaryVisibility(state, phase);

  // Sound: my turn notification
  const isMyTurn = myIndex >= 0 && players[myIndex]?.isCurrent;
  if (isMyTurn && !wasMyTurn) {
    playTurn();
  }
  wasMyTurn = isMyTurn;

  // Sound: card deals
  if (isNewHand) {
    const totalActive = players.filter(p => !p.sittingOut).length;
    for (let i = 0; i < totalActive * 2; i++) {
      setTimeout(() => playDeal(), i * 150);
    }
  } else if (isNewPhase && newCommunityCards > 0) {
    for (let i = 0; i < newCommunityCards; i++) {
      setTimeout(() => playDeal(), i * 150);
    }
  }
}

// Смещение центра места от центра стола (px), под .table-stage max 1020×500 — совпадает с % в style.css
function getSeatOffset(pos) {
  const w = 1020;
  const h = 500;
  const cx = w / 2;
  const cy = h / 2;
  const pct = {
    0: [50, 97.5],
    1: [9, 88.5],
    2: [0.35, 50],
    3: [9, 11.5],
    4: [50, 4.5],
    5: [91, 11.5],
    6: [98.2, 50],
    7: [91, 88.5],
  };
  const [lp, tp] = pct[pos] || [50, 50];
  return { x: (w * lp) / 100 - cx, y: (h * tp) / 100 - cy };
}

function renderCommunityCards(community, isNewPhase, newCards, dealerOffset) {
  const el = document.getElementById('communityCards');
  el.innerHTML = '';

  for (let i = 0; i < community.length; i++) {
    const card = createCardElement(community[i], false);
    const isNew = i >= community.length - Math.max(newCards, 0);
    if (isNew && isNewPhase) {
      card.classList.add('card-deal-anim');
      card.style.setProperty('--deal-x', `${dealerOffset.x}px`);
      card.style.setProperty('--deal-y', `${dealerOffset.y}px`);
      card.style.animationDelay = `${(i - (community.length - newCards)) * 0.15}s`;
    }
    el.appendChild(card);
  }
}

function renderSeats(players, myIndex, dealerIndex, isNewHand, dealerOffset) {
  const seatsEl = document.getElementById('seats');
  seatsEl.innerHTML = '';

  const positions = getSeatPositions(players.length, myIndex);
  const sbIndex = gameState.sbIndex ?? -1;
  const bbIndex = gameState.bbIndex ?? -1;

  // Calculate deal order from dealer for animation delays
  const dealOrder = getDealOrder(players, dealerIndex);

  for (let i = 0; i < players.length; i++) {
    const p = players[i];
    const pos = positions[i];
    const seat = document.createElement('div');
    seat.className = 'seat';
    seat.dataset.pos = pos;
    seat.dataset.playerIdx = i;

    if (p.isMe) seat.classList.add('is-me');
    if (p.isCurrent) seat.classList.add('is-current');
    if (p.folded) seat.classList.add('is-folded');
    if (i === dealerIndex) seat.classList.add('is-dealer');
    if (i === sbIndex) seat.classList.add('is-sb');
    if (i === bbIndex) seat.classList.add('is-bb');
    if (gameState.phase === 'showdown' && isShowdownWinnerName(p.name)) {
      seat.classList.add('is-winner');
    }

    let statusHtml = '';
    if (gameState.phase === 'showdown' && !p.folded && !p.sittingOut && p.showdownDecided) {
      if (p.mucked) statusHtml = '<div class="player-status" style="color: var(--text-dim)">🚫 Скрыл</div>';
      else if (p.mustShow) statusHtml = '<div class="player-status" style="color: var(--gold)">👁 Показал</div>';
      else statusHtml = '<div class="player-status" style="color: var(--green)">👁 Показал</div>';
    } else if (gameState.phase === 'showdown' && !p.folded && !p.sittingOut && !p.showdownDecided) {
      statusHtml = '<div class="player-status" style="color: var(--text-dim)">⏳ Решает...</div>';
    } else if (p.folded && !p.sittingOut) {
      statusHtml = '<div class="player-status">ФОЛД</div>';
    } else if (p.allIn) {
      statusHtml = '<div class="player-status" style="color: var(--red)">ОЛЛ-ИН</div>';
    } else if (p.sittingOut) {
      statusHtml = '<div class="player-status" style="color: var(--text-dim)">---</div>';
    }

    // Badges
    let badgesHtml = '';
    if (gameState.state === 'playing') {
      if (i === dealerIndex) badgesHtml += '<span class="badge badge-dealer">D</span>';
      if (i === sbIndex) badgesHtml += '<span class="badge badge-sb">SB</span>';
      if (i === bbIndex) badgesHtml += '<span class="badge badge-bb">BB</span>';
    }

    const playerOffset = getSeatOffset(pos);
    const dealFromX = dealerOffset.x - playerOffset.x;
    const dealFromY = dealerOffset.y - playerOffset.y;
    const cardsHtml = renderPlayerCards(p, isNewHand, dealOrder[i] ?? 0, dealFromX, dealFromY);

    const betHtml = p.bet > 0
      ? `<div class="bet-area"><span class="bet-chips">${renderChipIcons(p.bet)}</span><span class="bet-amount">${p.bet}</span></div>`
      : '';

    // Центр снизу/сверху: фишки слева от карточки игрока (рядом с картами)
    const isColumnSeat = pos === 0 || pos === 4;
    const betColWrap = isColumnSeat && betHtml ? `<div class="seat-bet-col">${betHtml}</div>` : '';
    const betOutsideRow = !isColumnSeat && betHtml ? betHtml : '';

    const emojiHtml = p.isMe ? `
      <div class="emoji-control" onclick="event.stopPropagation()">
        <button type="button" class="emoji-toggle" onclick="event.stopPropagation(); toggleEmojiBar(this)">😀</button>
        <div class="emoji-popup" style="display: none;" onclick="event.stopPropagation()">
          <button type="button" class="emoji-btn" onclick="sendEmoji('👍', event)">👍</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('😂', event)">😂</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('😎', event)">😎</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('🔥', event)">🔥</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('😡', event)">😡</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('💀', event)">💀</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('🎉', event)">🎉</button>
          <button type="button" class="emoji-btn" onclick="sendEmoji('💰', event)">💰</button>
        </div>
      </div>` : '';

    const seatInfoBlock = `
        <div class="seat-info" onclick="seatInfoClick(event, ${i})">
          ${renderAvatar(p.avatar, p.name, 'avatar-sm')}
          <div class="badges">${badgesHtml}</div>
          <div class="player-name">${esc(p.name)}</div>
          <div class="player-chips">\uD83E\uDE99 ${p.chips}</div>
          ${statusHtml}
          ${emojiHtml}
        </div>`;

    if (isColumnSeat) {
      seat.innerHTML = `
      <div class="seat-inner seat-inner--mid-col">
        ${betColWrap}
        <div class="seat-main-col">
          ${seatInfoBlock}
          <div class="player-cards">${cardsHtml}</div>
        </div>
      </div>`;
    } else {
      seat.innerHTML = `
      <div class="seat-inner">
        ${seatInfoBlock}
        <div class="player-cards">${cardsHtml}</div>
      </div>
      ${betOutsideRow}`;
    }

    seatsEl.appendChild(seat);
  }
}

// Returns a map: playerIndex -> deal order (0 = first to receive, etc.)
function getDealOrder(players, dealerIndex) {
  const order = {};
  if (dealerIndex < 0) return order;
  let count = 0;
  let idx = (dealerIndex + 1) % players.length;
  for (let i = 0; i < players.length; i++) {
    if (!players[idx].sittingOut) {
      order[idx] = count++;
    }
    idx = (idx + 1) % players.length;
  }
  return order;
}

function getSeatPositions(count, myIndex) {
  // Symmetric seat layouts: me is always pos 0 (bottom center)
  const layouts = {
    2: [0, 4],
    3: [0, 3, 5],
    4: [0, 2, 4, 6],
    5: [0, 2, 3, 5, 6],
    6: [0, 1, 3, 4, 5, 7],
    7: [0, 1, 2, 4, 5, 6, 7],
    8: [0, 1, 2, 3, 4, 5, 6, 7],
  };
  const layout = layouts[count] || layouts[8];
  const positions = [];
  for (let i = 0; i < count; i++) {
    const offset = (i - myIndex + count) % count;
    positions.push(layout[offset]);
  }
  return positions;
}

function renderPlayerCards(player, isNewHand, dealOrderIdx, dealFromX, dealFromY) {
  if (player.sittingOut) return '';

  const baseDelay = dealOrderIdx * 0.15;
  const dealStyle = `--deal-x: ${dealFromX}px; --deal-y: ${dealFromY}px;`;
  const totalPlayers = gameState ? gameState.players.filter(p => !p.sittingOut).length : 1;
  const peeked = player.peeked || [false, false];

  // My cards — show face-down by default, flip on click
  if (player.isMe && player.hand && player.hand.length > 0 && player.hand[0]?.rank) {
    return player.hand.map((c, idx) => {
      const flipped = peeked[idx];
      const dealAnim = isNewHand ? 'card-deal-anim' : '';
      const delay = isNewHand ? (idx === 0 ? baseDelay : baseDelay + totalPlayers * 0.15) : 0;
      const style = isNewHand ? `${dealStyle} animation-delay: ${delay}s;` : '';

      if (flipped) {
        const el = createCardElement(c, true);
        el.classList.add('card-flippable');
        if (dealAnim) el.classList.add(dealAnim);
        el.setAttribute('style', style);
        el.setAttribute('onclick', `peekCard(${idx})`);
        return el.outerHTML;
      } else {
        return `<div class="card card-back card-mini card-flippable ${dealAnim}" style="${style}" onclick="peekCard(${idx})"></div>`;
      }
    }).join('');
  }

  // Other player cards — at showdown, show if server sent them (winner or voluntarily shown)
  if (!player.isMe && player.hand && player.hand.length > 0 && player.hand[0]?.rank) {
    return player.hand.map((c, idx) => {
      const el = createCardElement(c, true);
      return el.outerHTML;
    }).join('');
  }

  // Other players — face-down cards during play or showdown (mucked / not shown yet)
  if (!player.isMe && !player.folded && gameState && (gameState.state === 'playing' || gameState.phase === 'showdown')) {
    const isShowdown = gameState.phase === 'showdown';
    const pendingClass = isShowdown && !player.showdownDecided ? 'card-showdown-pending' : '';
    const muckedClass = isShowdown && player.mucked ? 'card-mucked' : '';

    if (isNewHand) {
      return [0, 1].map(idx => {
        const peekClass = peeked[idx] ? 'card-peeked' : '';
        const delay = idx === 0 ? baseDelay : baseDelay + totalPlayers * 0.15;
        return `<div class="card card-back card-mini card-other card-deal-anim ${peekClass} ${pendingClass} ${muckedClass}" style="${dealStyle} animation-delay: ${delay}s"></div>`;
      }).join('');
    }
    return [0, 1].map(idx => {
      const peekClass = peeked[idx] ? 'card-peeked' : '';
      return `<div class="card card-back card-mini card-other ${peekClass} ${pendingClass} ${muckedClass}"></div>`;
    }).join('');
  }

  return '';
}

function peekCard(idx) {
  socket.emit('peek-card', { cardIndex: idx });
}

function muckHand() {
  socket.emit('muck-hand');
}

function createCardElement(card, mini) {
  const el = document.createElement('div');
  const isRed = card.suit === 'hearts' || card.suit === 'diamonds';
  el.className = `card card-front ${mini ? 'card-mini' : ''} ${isRed ? 'red' : ''}`;
  el.innerHTML = `
    <div class="card-rank">${card.rank}</div>
    <div class="card-suit">${SUIT_SYMBOLS[card.suit]}</div>
  `;
  return el;
}

// После вскрытия innerHTML actionBar заменялся на «показать/мак» — без восстановления пропадали Fold/Check/Call и кнопки «залипали».
const PLAY_ACTION_BAR_HTML = `
      <div class="raise-row" id="raiseRow" style="display: none;">
        <div class="raise-presets" id="raisePresets"></div>
        <div class="raise-slider-row">
          <input type="range" id="raiseSlider" min="0" max="1000" step="1">
          <input type="number" id="raiseInput" class="raise-input" min="0" max="1000">
        </div>
      </div>
      <div class="action-buttons">
        <button id="btnFold" class="btn btn-fold" onclick="doAction('fold')">Фолд</button>
        <button id="btnCheck" class="btn btn-check" onclick="doAction('check')">Чек</button>
        <button id="btnCall" class="btn btn-call" onclick="doAction('call')">
          Колл <span id="callAmount"></span>
        </button>
        <button id="btnRaise" class="btn btn-raise" onclick="doAction('raise')">
          Рейз <span id="raiseAmount"></span>
        </button>
      </div>`;

function ensurePlayActionBarMarkup() {
  const actionBar = document.getElementById('actionBar');
  if (!actionBar || document.getElementById('btnCheck')) return;
  actionBar.innerHTML = PLAY_ACTION_BAR_HTML;
  attachRaiseControlHandlers();
}

function attachRaiseControlHandlers() {
  const slider = document.getElementById('raiseSlider');
  const input = document.getElementById('raiseInput');
  if (!slider || !input) return;
  slider.oninput = function () {
    updateRaiseValue(parseInt(this.value, 10));
  };
  input.oninput = function () {
    const val = parseInt(this.value, 10);
    if (!isNaN(val)) updateRaiseValue(val);
  };
}

function renderActionBar(players, myIndex, currentBet, state, phase) {
  const actionBar = document.getElementById('actionBar');
  if (!actionBar) return;

  const me = myIndex >= 0 ? players[myIndex] : null;
  const needsShowdownChoice =
    phase === 'showdown' &&
    myIndex >= 0 &&
    me &&
    !me.folded &&
    !me.showdownDecided &&
    !me.mustShow;

  if (needsShowdownChoice) {
    actionBar.style.display = 'block';
    actionBar.innerHTML = `
        <div class="action-buttons">
          <button class="btn btn-primary" onclick="socket.emit('show-hand')" style="flex:1;">👁 Показать карты</button>
          <button class="btn btn-fold" onclick="socket.emit('muck-hand')" style="flex:1;">🚫 Скрыть (мак)</button>
        </div>`;
    return;
  }

  ensurePlayActionBarMarkup();

  if (phase === 'showdown') {
    actionBar.style.display = 'none';
    return;
  }

  if (state !== 'playing' || myIndex === -1 || myIndex === undefined) {
    actionBar.style.display = 'none';
    return;
  }

  const mePlay = players[myIndex];
  if (!mePlay || mePlay.folded || mePlay.allIn || !mePlay.isCurrent) {
    actionBar.style.display = 'none';
    return;
  }

  actionBar.style.display = 'block';

  const toCall = currentBet - mePlay.bet;
  const canCheck = toCall === 0;

  document.getElementById('btnCheck').style.display = canCheck ? 'flex' : 'none';
  document.getElementById('btnCall').style.display = !canCheck ? 'flex' : 'none';
  document.getElementById('callAmount').textContent = toCall > 0 ? toCall : '';

  // Raise controls
  const canRaise = mePlay.chips > toCall;
  const raiseRow = document.getElementById('raiseRow');
  const btnRaise = document.getElementById('btnRaise');

  if (canRaise) {
    raiseRow.style.display = 'block';
    btnRaise.style.display = 'flex';

    const slider = document.getElementById('raiseSlider');
    const raiseInput = document.getElementById('raiseInput');
    const bb = gameState.bigBlind || 20;
    const sb = gameState.smallBlind || 10;
    // Min raise = current bet + 1 big blind (standard rule)
    const minRaiseTotal = Math.min(currentBet + bb, mePlay.chips + mePlay.bet);
    const maxRaiseTotal = mePlay.chips + mePlay.bet;

    slider.min = minRaiseTotal;
    slider.max = maxRaiseTotal;
    raiseInput.min = minRaiseTotal;
    raiseInput.max = maxRaiseTotal;

    if (parseInt(slider.value) < minRaiseTotal || !slider.dataset.touched) {
      slider.value = minRaiseTotal;
      raiseInput.value = minRaiseTotal;
      slider.dataset.touched = '';
    }

    document.getElementById('raiseAmount').textContent = raiseInput.value;

    // Build dynamic presets based on current pot
    const pot = gameState.pot;
    const effectivePot = pot + toCall;
    buildPresets(currentBet, effectivePot, minRaiseTotal, maxRaiseTotal, bb);
  } else {
    raiseRow.style.display = 'none';
    btnRaise.style.display = 'none';
  }
}

function buildPresets(currentBet, effectivePot, minRaise, maxRaise, bb) {
  const container = document.getElementById('raisePresets');
  const presets = [
    { label: `Мин (${minRaise})`, val: minRaise },
    { label: `1/3 (${clampPreset(currentBet + Math.ceil(effectivePot * 0.33), minRaise, maxRaise)})`, val: clampPreset(currentBet + Math.ceil(effectivePot * 0.33), minRaise, maxRaise) },
    { label: `1/2 (${clampPreset(currentBet + Math.ceil(effectivePot * 0.5), minRaise, maxRaise)})`, val: clampPreset(currentBet + Math.ceil(effectivePot * 0.5), minRaise, maxRaise) },
    { label: `3/4 (${clampPreset(currentBet + Math.ceil(effectivePot * 0.75), minRaise, maxRaise)})`, val: clampPreset(currentBet + Math.ceil(effectivePot * 0.75), minRaise, maxRaise) },
    { label: `Банк (${clampPreset(currentBet + effectivePot, minRaise, maxRaise)})`, val: clampPreset(currentBet + effectivePot, minRaise, maxRaise) },
    { label: `Олл-ин (${maxRaise})`, val: maxRaise, cls: 'preset-allin' },
  ];

  container.innerHTML = presets.map(p =>
    `<button class="preset-btn ${p.cls || ''}" onclick="updateRaiseValue(${p.val})">${p.label}</button>`
  ).join('');
}

function clampPreset(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

attachRaiseControlHandlers();

function updateRaiseValue(val) {
  const slider = document.getElementById('raiseSlider');
  const input = document.getElementById('raiseInput');
  val = Math.max(parseInt(slider.min) || 0, Math.min(parseInt(slider.max) || val, val));
  slider.value = val;
  slider.dataset.touched = '1';
  input.value = val;
  document.getElementById('raiseAmount').textContent = val;
}

// ======== ACTIONS ========

function doAction(action) {
  if (!gameState) return;

  let amount;
  if (action === 'raise') {
    amount = parseInt(document.getElementById('raiseInput').value);
    if (isNaN(amount) || amount <= 0) return;
  }

  // Play sound for the action
  if (action === 'fold') playFold();
  else if (action === 'check') playCheck();
  else if (action === 'call' || action === 'raise') playChipBet();
  else if (action === 'allin') playAllIn();

  socket.emit('action', { action, amount }, (res) => {
    if (res?.error) {
      console.warn(res.error);
    }
  });
  // Reset touched state for next round
  document.getElementById('raiseSlider').dataset.touched = '';
}

function startGame() {
  socket.emit('start-game');
}

function toggleReady() {
  socket.emit('toggle-ready');
}

function doRebuy() {
  const input = document.getElementById('rebuyAmount');
  const amount = parseInt(input?.value);
  if (!amount || amount < 1) return;
  socket.emit('rebuy', { amount }, (res) => {
    if (res?.error) {
      alert(res.error);
    } else {
      input.value = '';
    }
  });
}

// ======== REBUY TOAST (все видят докуп) ========

function showRebuyToast(name, amount) {
  const host = document.getElementById('rebuyToastHost');
  if (!host) return;
  const el = document.createElement('div');
  el.className = 'rebuy-toast';
  el.setAttribute('role', 'status');
  el.innerHTML = `
    <span class="rebuy-toast-label">Докуп</span>
    <div class="rebuy-toast-main"><strong>${esc(name)}</strong> добавил <span class="rebuy-toast-amt">+${amount}</span> фишек</div>
  `;
  host.appendChild(el);
  setTimeout(() => {
    el.classList.add('rebuy-toast--out');
    setTimeout(() => el.remove(), 480);
  }, 5200);
}

// ======== ACTION NOTIFICATIONS ========

function showActionNotification(playerIndex, text) {
  if (!gameState) return;

  // Find the seat element for this player
  const seat = document.querySelector(`.seat[data-player-idx="${playerIndex}"]`);
  if (!seat) return;

  // Get seat position relative to table-area
  const area = document.querySelector('.table-area');
  if (!area) return;
  const areaR = area.getBoundingClientRect();
  const seatR = seat.getBoundingClientRect();

  // Create notification in the overlay container
  let container = document.getElementById('actionNotifs');
  if (!container) {
    container = document.createElement('div');
    container.id = 'actionNotifs';
    container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:30;';
    area.appendChild(container);
  }

  const notif = document.createElement('div');
  notif.className = 'action-notif';
  notif.textContent = text;
  const midx = seatR.left + seatR.width / 2;
  const midy = seatR.top + seatR.height / 2;
  let nx = midx - areaR.left;
  let ny = midy - areaR.top;
  const stage = document.querySelector('.table-stage');
  if (stage) {
    const sr = stage.getBoundingClientRect();
    const scx = sr.left + sr.width / 2;
    const scy = sr.top + sr.height / 2;
    const dx = midx - scx;
    const dy = midy - scy;
    const len = Math.hypot(dx, dy) || 1;
    const off = 40;
    nx += (dx / len) * off;
    ny += (dy / len) * off;
  }
  notif.style.left = `${nx}px`;
  notif.style.top = `${ny}px`;
  container.appendChild(notif);

  setTimeout(() => notif.remove(), 3200);
}

// ======== SHOWDOWN ========

let lastShowdownData = null;
/** Победитель на столе (подсветка + блок итога) только после обратного отсчёта */
let showdownWinnersVisible = false;
let showdownCountdownTimer = null;
let showdownCountdownRemaining = 0;
let showdownWinSoundPlayed = false;
/** Между «1» и блоком «Итог раздачи» — держим подложку видимой */
let showdownRevealPending = false;

function isShowdownWinnerName(name) {
  if (!showdownWinnersVisible || !lastShowdownData?.winners?.length) return false;
  return lastShowdownData.winners.some((w) => w.name === name);
}

function clearShowdownTableUI() {
  const el = document.getElementById('showdownSummary');
  if (el) {
    el.hidden = true;
    el.innerHTML = '';
    el.classList.remove('showdown-summary--in');
  }
}

/** Сброс локального UI вскрытия при смене комнаты (иначе тянется прошлая раздача). */
function resetClientShowdownState() {
  if (showdownCountdownTimer) {
    clearInterval(showdownCountdownTimer);
    showdownCountdownTimer = null;
  }
  lastShowdownData = null;
  showdownWinnersVisible = false;
  showdownCountdownRemaining = 0;
  showdownWinSoundPlayed = false;
  showdownRevealPending = false;
  clearShowdownTableUI();
  const resultsDiv = document.getElementById('showdownResults');
  if (resultsDiv) resultsDiv.innerHTML = '';
}

function syncShowdownSummaryVisibility(state, phase) {
  const el = document.getElementById('showdownSummary');
  if (!el) return;
  // Не дублируем блок на столе, когда открыт полноэкранный оверлей ожидания
  if (state === 'waiting') {
    el.hidden = true;
    return;
  }
  const hasData = lastShowdownData?.winners?.length > 0;
  // Отсёт не привязываем строго к phase (сокет «showdown» может прийти на миллисекунды раньше game-state)
  const inCountdown =
    hasData &&
    !showdownWinnersVisible &&
    (showdownCountdownRemaining > 0 || showdownRevealPending);
  const showResult = phase === 'showdown' && hasData && showdownWinnersVisible;
  el.hidden = !(inCountdown || showResult);
}

function fillShowdownSummaryElement() {
  const el = document.getElementById('showdownSummary');
  if (!el || !lastShowdownData?.winners?.length) return;
  el.innerHTML = `
    <div class="showdown-summary__title">Итог раздачи</div>
    <div class="showdown-summary__rows">
      ${lastShowdownData.winners.map((w) => `
        <div class="showdown-summary__row">
          <span class="showdown-summary__name">${esc(w.name)}</span>
          <span class="showdown-summary__hand">${w.hand ? esc(w.hand) : ''}</span>
          <span class="showdown-summary__pot">${w.potName ? esc(w.potName) : ''}</span>
          <span class="showdown-summary__amt">+${w.amount}</span>
        </div>
      `).join('')}
    </div>
  `;
  el.classList.remove('showdown-summary--in');
  void el.offsetWidth;
  el.classList.add('showdown-summary--in');
  setTimeout(() => el.classList.remove('showdown-summary--in'), 600);
}

function updateShowdownCountdownUI() {
  const el = document.getElementById('showdownSummary');
  if (!el || !lastShowdownData?.winners?.length || showdownWinnersVisible) return;
  if (showdownCountdownRemaining <= 0) return;
  el.hidden = false;
  el.classList.remove('showdown-summary--in');
  el.innerHTML = `<div class="showdown-countdown-wrap"><div class="showdown-countdown">${showdownCountdownRemaining}</div><div class="showdown-countdown-hint">Вскрытие…</div></div>`;
}

function finishShowdownReveal() {
  showdownCountdownRemaining = 0;
  if (showdownCountdownTimer) {
    clearInterval(showdownCountdownTimer);
    showdownCountdownTimer = null;
  }
  if (!lastShowdownData?.winners?.length) return;

  showdownRevealPending = true;
  if (gameState) syncShowdownSummaryVisibility(gameState.state, gameState.phase);

  // Короткая пауза после «1», затем итог (без мгновенного перехода «как новое вскрытие»)
  setTimeout(() => {
    showdownRevealPending = false;
    if (!lastShowdownData?.winners?.length) return;
    showdownWinnersVisible = true;
    if (!showdownWinSoundPlayed) {
      playWin();
      showdownWinSoundPlayed = true;
    }
    fillShowdownSummaryElement();
    if (gameState) {
      syncShowdownSummaryVisibility(gameState.state, gameState.phase);
      renderGame();
    }
  }, 320);
}

function showShowdown(data) {
  lastShowdownData = data;
  showdownWinnersVisible = false;
  showdownWinSoundPlayed = false;
  showdownRevealPending = false;
  if (showdownCountdownTimer) {
    clearInterval(showdownCountdownTimer);
    showdownCountdownTimer = null;
  }
  showdownCountdownRemaining = 3;
  updateShowdownCountdownUI();
  if (gameState) syncShowdownSummaryVisibility(gameState.state, gameState.phase);

  showdownCountdownTimer = setInterval(() => {
    showdownCountdownRemaining -= 1;
    if (showdownCountdownRemaining <= 0) {
      finishShowdownReveal();
    } else {
      updateShowdownCountdownUI();
    }
  }, 1000);
}

// ======== CHAT ========

function toggleChat() {
  const body = document.getElementById('chatBody');
  const btn = document.querySelector('.chat-toggle-btn');
  if (body.style.display === 'none') {
    body.style.display = 'flex';
    btn.style.display = 'none';
    document.getElementById('chatInput').focus();
  } else {
    body.style.display = 'none';
    btn.style.display = 'flex';
  }
}

function sendChat() {
  const input = document.getElementById('chatInput');
  const msg = input.value.trim();
  if (!msg) return;
  socket.emit('chat', msg);
  input.value = '';
  input.focus();
}

function addChatMessage(name, text, isSystem) {
  const messages = document.getElementById('chatMessages');
  // Remove empty placeholder
  const empty = messages.querySelector('.chat-empty');
  if (empty) empty.remove();

  const now = new Date();
  const time = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');

  const div = document.createElement('div');
  div.className = 'chat-msg' + (isSystem ? ' system-msg' : '');
  div.innerHTML = `
    <div class="chat-msg-header">
      <span class="chat-name">${esc(name)}</span>
      <span class="chat-time">${time}</span>
    </div>
    <div class="chat-text">${esc(text)}</div>
  `;
  messages.appendChild(div);
  messages.scrollTop = messages.scrollHeight;
}

document.getElementById('chatInput').addEventListener('keyup', (e) => {
  if (e.key === 'Enter') sendChat();
});

socket.on('chat', (data) => {
  addChatMessage(data.name, data.message);
});

// ======== COMBOS ========

function toggleCombos() {
  const overlay = document.getElementById('combosOverlay');
  overlay.style.display = overlay.style.display === 'none' ? 'flex' : 'none';
}

function toggleHistory() {
  const overlay = document.getElementById('historyOverlay');
  if (overlay.style.display === 'none') {
    socket.emit('get-history', (data) => {
      const list = document.getElementById('historyList');
      const history = data?.history || [];
      if (history.length === 0) {
        list.innerHTML = '<p style="color:var(--text-dim);text-align:center;">Пока нет истории</p>';
      } else {
        list.innerHTML = history.slice().reverse().map(h => {
          const winnerText = h.winners.map(w =>
            `${esc(w.name)}: +${w.amount}${w.hand ? ' (' + esc(w.hand) + ')' : ''}${w.potName ? ' — ' + esc(w.potName) : ''}`
          ).join(', ');
          const communityHtml = h.community.map(c => createCardElement(c, true).outerHTML).join('');
          const playersHtml = h.players.map(p =>
            `<span class="history-player ${p.folded ? 'folded' : ''}">${esc(p.name)} ${p.folded ? '(фолд)' : ''}</span>`
          ).join('');
          return `
            <div class="history-entry">
              <div class="history-entry-header">
                <span>Рука #${h.handNumber}</span>
                <span>Банк: ${h.pot}</span>
              </div>
              <div style="display:flex;gap:4px;margin:6px 0;">${communityHtml || '<span style="color:var(--text-dim);font-size:12px;">Нет карт</span>'}</div>
              <div class="history-winner">${winnerText}</div>
              <div class="history-players">${playersHtml}</div>
            </div>
          `;
        }).join('');
      }
    });
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

// ======== PROFILE ========

function seatInfoClick(ev, playerIndex) {
  if (!ev || ev.target.closest('.emoji-control')) return;
  showProfile(playerIndex);
}

function showProfile(playerIndex) {
  if (!gameState || playerIndex < 0 || playerIndex >= gameState.players.length) return;
  const p = gameState.players[playerIndex];
  const s = p.stats || {};
  const winRate = s.handsPlayed > 0 ? Math.round(s.handsWon / s.handsPlayed * 100) : 0;

  document.getElementById('profileHeader').innerHTML = `
    ${renderAvatar(p.avatar, p.name, 'avatar-xl')}
    <h3>${esc(p.name)}</h3>
    <div class="profile-chips">\uD83E\uDE99 ${p.chips} фишек</div>
  `;

  document.getElementById('profileStats').innerHTML = `
    <div class="stat-card"><div class="stat-value">${s.handsPlayed || 0}</div><div class="stat-label">Рук сыграно</div></div>
    <div class="stat-card"><div class="stat-value">${s.handsWon || 0}</div><div class="stat-label">Рук выиграно</div></div>
    <div class="stat-card"><div class="stat-value">${winRate}%</div><div class="stat-label">Винрейт</div></div>
    <div class="stat-card"><div class="stat-value">${s.biggestWin || 0}</div><div class="stat-label">Макс. выигрыш</div></div>
    <div class="stat-card"><div class="stat-value">${s.totalWinnings || 0}</div><div class="stat-label">Всего выиграно</div></div>
    <div class="stat-card"><div class="stat-value">${p.chips}</div><div class="stat-label">Текущий стек</div></div>
  `;

  document.getElementById('profileOverlay').style.display = 'flex';
}

function closeProfile() {
  document.getElementById('profileOverlay').style.display = 'none';
}

// ======== EMOJI ========

function toggleEmojiBar(btn) {
  const popup = btn?.parentElement?.querySelector('.emoji-popup');
  if (!popup) return;
  if (popup.style.display === 'none') {
    popup.style.display = 'grid';
    setTimeout(() => {
      document.addEventListener('click', function closeEmoji(e) {
        if (!e.target.closest('.emoji-control')) {
          popup.style.display = 'none';
          document.removeEventListener('click', closeEmoji);
        }
      });
    }, 10);
  } else {
    popup.style.display = 'none';
  }
}

function sendEmoji(emoji, evt) {
  if (evt?.stopPropagation) evt.stopPropagation();
  socket.emit('emoji', emoji);
  const popup = document.querySelector('.emoji-popup[style*="grid"]');
  if (popup) popup.style.display = 'none';
}

socket.on('emoji', (data) => {
  const seat = document.querySelector(`.seat[data-player-idx="${data.playerIndex}"]`);
  if (!seat) return;
  const area = document.querySelector('.table-area');
  if (!area) return;
  const areaR = area.getBoundingClientRect();
  const seatR = seat.getBoundingClientRect();

  let container = document.getElementById('actionNotifs');
  if (!container) {
    container = document.createElement('div');
    container.id = 'actionNotifs';
    container.style.cssText = 'position:absolute;inset:0;pointer-events:none;z-index:30;';
    area.appendChild(container);
  }

  const el = document.createElement('div');
  el.className = 'emoji-float';
  el.textContent = data.emoji;
  el.style.left = (seatR.left + seatR.width / 2 - areaR.left) + 'px';
  el.style.top = (seatR.top - areaR.top) + 'px';
  container.appendChild(el);
  setTimeout(() => el.remove(), 2000);
});

// ======== SPECTATE ========

function spectateRoom() {
  const code = document.getElementById('roomCode').value.trim().toUpperCase();
  if (!code) {
    document.getElementById('lobbyError').textContent = 'Введите код комнаты';
    return;
  }
  socket.emit('spectate', { code }, (res) => {
    if (res?.error) {
      document.getElementById('lobbyError').textContent = res.error;
    } else {
      showGame(res.code);
    }
  });
}

// ======== LEADERBOARD ========

function toggleLeaderboard() {
  const overlay = document.getElementById('leaderboardOverlay');
  if (overlay.style.display === 'none') {
    socket.emit('get-leaderboard', (data) => {
      const list = document.getElementById('leaderboardList');
      const lb = data?.leaderboard || [];
      if (lb.length === 0) {
        list.innerHTML = '<p style="color:var(--text-dim);text-align:center;">Пока нет данных</p>';
      } else {
        list.innerHTML = lb.map((p, i) => `
          <div class="lb-row">
            <div class="lb-rank">${i + 1}</div>
            ${renderAvatar(p.avatar, p.name, 'avatar-sm')}
            <div class="lb-name">${esc(p.name)}</div>
            <div class="lb-stats">
              <div class="lb-winnings">+${p.totalWinnings}</div>
              <div>${p.handsWon}/${p.handsPlayed} (${p.winRate}%)</div>
            </div>
          </div>
        `).join('');
      }
    });
    overlay.style.display = 'flex';
  } else {
    overlay.style.display = 'none';
  }
}

// ======== AVATARS ========

function renderAvatar(avatarUrl, name, sizeClass) {
  if (avatarUrl) {
    return `<div class="avatar ${sizeClass}" style="background-image: url(${avatarUrl})"></div>`;
  }
  // Default: colored circle with initial
  const initial = (name || '?')[0].toUpperCase();
  const colors = ['#e74c3c','#3498db','#2ecc71','#f39c12','#9b59b6','#1abc9c','#e67e22','#e91e63'];
  const color = colors[initial.charCodeAt(0) % colors.length];
  return `<div class="avatar ${sizeClass}" style="background: ${color}"><span class="avatar-initial">${initial}</span></div>`;
}

function handleAvatarUpload(input) {
  const file = input.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) return;

  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      // Resize to 128x128
      const canvas = document.createElement('canvas');
      canvas.width = 128;
      canvas.height = 128;
      const ctx = canvas.getContext('2d');
      // Crop to square from center
      const size = Math.min(img.width, img.height);
      const sx = (img.width - size) / 2;
      const sy = (img.height - size) / 2;
      ctx.drawImage(img, sx, sy, size, size, 0, 0, 128, 128);
      const base64 = canvas.toDataURL('image/jpeg', 0.7);

      socket.emit('set-avatar', { avatar: base64 }, (res) => {
        if (res?.ok) {
          currentUser.avatar = base64;
          showLobby(); // Re-render lobby with new avatar
        }
      });
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
  input.value = ''; // Reset for re-upload
}

// ======== CHIP RENDERING ========

function renderChipIcons(amount, large) {
  const denoms = [
    { val: 5000, cls: 'chip-orange' },
    { val: 1000, cls: 'chip-black' },
    { val: 500,  cls: 'chip-purple' },
    { val: 100,  cls: 'chip-gold' },
    { val: 25,   cls: 'chip-green' },
    { val: 5,    cls: 'chip-red' },
    { val: 1,    cls: 'chip-white' },
  ];

  let remaining = amount;
  const stacks = [];

  for (const d of denoms) {
    const count = Math.floor(remaining / d.val);
    if (count > 0) {
      stacks.push({ ...d, count });
      remaining -= count * d.val;
    }
  }

  if (stacks.length === 0 && amount > 0) {
    stacks.push({ cls: 'chip-white', count: 1 });
  }

  const maxStacks = large ? 4 : 2;
  const sz = large ? 'chip-lg' : 'chip-sm';

  return stacks.slice(0, maxStacks).map(s => {
    const vis = Math.min(s.count, large ? 5 : 3);
    let html = '';
    for (let i = 0; i < vis; i++) {
      html += `<span class="chip ${sz} ${s.cls}" style="margin-top:${i === 0 ? 0 : (large ? -5 : -4) + 'px'}; z-index:${vis - i};"></span>`;
    }
    return `<span class="chip-stack-col">${html}</span>`;
  }).join('');
}

// ======== UTILS ========

function esc(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}
