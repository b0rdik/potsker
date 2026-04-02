const { chromium } = require('playwright');

function uniq(s) {
  return `${s}_${Math.random().toString(16).slice(2, 10)}`;
}

async function expectVisible(page, selector, timeout = 10000) {
  await page.waitForSelector(selector, { state: 'visible', timeout });
}

async function click(page, selector) {
  await expectVisible(page, selector);
  await page.click(selector);
}

async function fill(page, selector, value) {
  await expectVisible(page, selector);
  await page.fill(selector, value);
}

async function register(page, name, password) {
  await page.goto('http://localhost:3100', { waitUntil: 'domcontentloaded' });
  await click(page, "button.auth-tab:has-text('Регистрация')");
  await fill(page, '#regName', name);
  await fill(page, '#regPassword', password);
  await fill(page, '#regPasswordConfirm', password);
  await click(page, "button:has-text('Создать аккаунт')");
  await expectVisible(page, '#lobby.active');
}

async function createRoom(page) {
  await click(page, '#btnCreate');
  await expectVisible(page, '#game.active');
  const code = (await page.textContent('#displayRoomCode')).trim();
  if (!code) throw new Error('Room code is empty');
  return code;
}

async function joinRoom(page, code) {
  await fill(page, '#roomCode', code);
  await click(page, '#btnJoin');
  await expectVisible(page, '#game.active');
}

async function waitPlayersCount(page, n) {
  await page.waitForFunction(
    (count) => document.querySelectorAll('.seat[data-player-idx]').length === count,
    n,
    { timeout: 15000 }
  );
}

async function getSeatIndexByName(page, namePrefix) {
  return await page.evaluate((prefix) => {
    const seats = Array.from(document.querySelectorAll('.seat[data-player-idx]'));
    for (const seat of seats) {
      const n = seat.querySelector('.player-name')?.textContent?.trim() || '';
      if (n.startsWith(prefix)) return parseInt(seat.getAttribute('data-player-idx'), 10);
    }
    return -1;
  }, namePrefix);
}

async function toggleReady(page) {
  // waiting overlay appears before hand; button exists there.
  await page.waitForSelector('#waitingOverlay', { state: 'visible', timeout: 15000 });
  await click(page, '#btnReady');
}

async function waitHandStarted(page) {
  // When playing starts, waiting overlay hidden and cards exist.
  await page.waitForSelector('#waitingOverlay', { state: 'hidden', timeout: 20000 });
  await page.waitForSelector('.seat.is-me .player-cards .card', { state: 'attached', timeout: 20000 });
}

async function myCardsAreFaceDownFlippable(page) {
  const cards = await page.$$('.seat.is-me .player-cards .card');
  if (cards.length < 2) throw new Error('Expected 2 hole cards for me');
  for (let i = 0; i < 2; i++) {
    const cls = await cards[i].getAttribute('class');
    if (!cls.includes('card-back')) throw new Error(`Expected my card ${i} to be face-down (card-back)`);
    if (!cls.includes('card-flippable')) throw new Error(`Expected my card ${i} to be flippable`);
  }
}

async function flipMyCard(page, idx) {
  await click(page, `.seat.is-me .player-cards .card:nth-child(${idx + 1})`);
  await page.waitForFunction(
    (i) => {
      const el = document.querySelector(`.seat.is-me .player-cards .card:nth-child(${i + 1})`);
      return el && el.classList.contains('card-front') && !el.classList.contains('card-back');
    },
    idx,
    { timeout: 8000 }
  );
}

async function otherPlayersHaveGreyEye(page) {
  // Other players: .card-back.card-other has 👁 via ::before (cannot be read directly),
  // but we can assert class presence.
  const others = await page.$$('.seat:not(.is-me) .player-cards .card.card-back.card-other');
  if (others.length < 2) throw new Error('Expected other players cards to be shown as card-back card-other');
}

async function waitOtherPeekedIndicatorGone(page, otherPlayerIdx) {
  // When other player flips, our UI receives peek-update and adds .card-peeked to their card backs.
  await page.waitForFunction(
    (idx) => {
      const seat = document.querySelector(`.seat[data-player-idx="${idx}"]`);
      if (!seat) return false;
      const cards = seat.querySelectorAll('.player-cards .card');
      return cards.length >= 2 && Array.from(cards).some((c) => c.classList.contains('card-peeked'));
    },
    otherPlayerIdx,
    { timeout: 8000 }
  );
}

async function forceEndHandByFolds(pages) {
  // Try to fold on each player's turn; if not their turn, ignore.
  // Repeat for a short window until showdown appears.
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const page of pages) {
      const foldVisible = await page.isVisible('#btnFold').catch(() => false);
      if (foldVisible) {
        await page.click('#btnFold').catch(() => {});
      }
    }

    const anyShowdown = await pages[0]
      .evaluate(() => (document.getElementById('phaseIndicator')?.textContent || '').includes('Вскрытие'))
      .catch(() => false);
    if (anyShowdown) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Timed out trying to reach showdown by folds');
}

async function checkShowMuckButtons(page) {
  // Action bar during showdown shows two buttons for players who are eligible.
  await page.waitForFunction(
    () => (document.getElementById('phaseIndicator')?.textContent || '').includes('Вскрытие'),
    null,
    { timeout: 30000 }
  );
  // Either action bar visible with show/muck, or hidden if mustShow / folded.
  const actionBarVisible = await page.isVisible('#actionBar').catch(() => false);
  if (actionBarVisible) {
    const hasShow = await page.isVisible("button:has-text('Показать карты')").catch(() => false);
    const hasMuck = await page.isVisible("button:has-text('Скрыть (мак)')").catch(() => false);
    if (!hasShow || !hasMuck) throw new Error('Expected show/muck buttons visible for this player');
    return 'buttons';
  }
  return 'no-buttons';
}

async function decideShowOrMuck(page, decision) {
  if (decision === 'show') {
    const btn = await page.$("button:has-text('Показать карты')");
    if (btn) await btn.click();
  } else {
    const btn = await page.$("button:has-text('Скрыть (мак)')");
    if (btn) await btn.click();
  }
}

async function waitWaitingScreen(page) {
  await page.waitForSelector('#waitingOverlay', { state: 'visible', timeout: 20000 });
}

async function run() {
  const channel = process.env.PLAYWRIGHT_CHANNEL || undefined;
  const browser = await chromium.launch({ headless: true, channel });
  const ctx1 = await browser.newContext();
  const ctx2 = await browser.newContext();
  const ctx3 = await browser.newContext();

  const p1 = await ctx1.newPage();
  const p2 = await ctx2.newPage();
  const p3 = await ctx3.newPage();

  const outDir = 'artifacts-e2e';

  const pw = 'password_12345';
  const n1 = uniq('p1');
  const n2 = uniq('p2');
  const n3 = uniq('p3');
  await register(p1, n1, pw);
  await register(p2, n2, pw);
  await register(p3, n3, pw);

  const code = await createRoom(p1);
  await joinRoom(p2, code);
  await joinRoom(p3, code);

  await waitPlayersCount(p1, 3);
  await waitPlayersCount(p2, 3);
  await waitPlayersCount(p3, 3);

  await p1.screenshot({ path: `${outDir}/01-3players-joined-p1.png`, fullPage: true });

  // Ready all
  await toggleReady(p1);
  await toggleReady(p2);
  await toggleReady(p3);

  await waitHandStarted(p1);
  await waitHandStarted(p2);
  await waitHandStarted(p3);

  await myCardsAreFaceDownFlippable(p1);
  await otherPlayersHaveGreyEye(p1);
  await p1.screenshot({ path: `${outDir}/02-my-cards-facedown-p1.png`, fullPage: true });

  // Flip my two cards on p1
  await flipMyCard(p1, 0);
  await flipMyCard(p1, 1);
  await p1.screenshot({ path: `${outDir}/03-p1-flipped-both.png`, fullPage: true });

  // Verify other players see p1 peeked indicator disappear via .card-peeked on p1 seat
  const p1IndexInP2 = await getSeatIndexByName(p2, 'p1_');
  const p1IndexInP3 = await getSeatIndexByName(p3, 'p1_');
  if (p1IndexInP2 < 0 || p1IndexInP3 < 0) throw new Error('Could not locate p1 seat index in other clients');

  await waitOtherPeekedIndicatorGone(p2, p1IndexInP2);
  await waitOtherPeekedIndicatorGone(p3, p1IndexInP3);
  await p2.screenshot({ path: `${outDir}/04-p2-sees-p1-peeked.png`, fullPage: true });

  // Now flip one card on p2 and verify p1 sees it
  await flipMyCard(p2, 0);
  const p2IndexInP1 = await getSeatIndexByName(p1, 'p2_');
  if (p2IndexInP1 < 0) throw new Error('Could not locate p2 seat index in p1');
  await waitOtherPeekedIndicatorGone(p1, p2IndexInP1);
  await p1.screenshot({ path: `${outDir}/05-p1-sees-p2-peeked.png`, fullPage: true });

  // End hand quickly via folds to reach showdown flow
  await forceEndHandByFolds([p1, p2, p3]);
  await p1.screenshot({ path: `${outDir}/06-showdown-phase-p1.png`, fullPage: true });

  // Check show/muck buttons visibility for each player and decide
  const s1 = await checkShowMuckButtons(p1);
  const s2 = await checkShowMuckButtons(p2);
  const s3 = await checkShowMuckButtons(p3);

  // For those who have buttons, choose decisions to complete showdown
  if (s1 === 'buttons') await decideShowOrMuck(p1, 'muck');
  if (s2 === 'buttons') await decideShowOrMuck(p2, 'show');
  if (s3 === 'buttons') await decideShowOrMuck(p3, 'muck');

  // Wait until waiting overlay appears again after everyone decided
  await waitWaitingScreen(p1);
  await p1.screenshot({ path: `${outDir}/07-waiting-next-hand-p1.png`, fullPage: true });

  await browser.close();
}

run()
  .then(() => {
    process.stdout.write('E2E3P_OK\n');
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`E2E3P_FAIL: ${e.stack || e.message}\n`);
    process.exit(1);
  });

