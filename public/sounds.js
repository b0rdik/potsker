// ======== POKER SOUND ENGINE (Web Audio API) ========
// Realistic, quiet poker table sounds

let audioCtx = null;
let soundMuted = false;
let MASTER_VOL = 0.35; // Global volume control

function setVolume(val) {
  MASTER_VOL = parseInt(val) / 100;
  const btn = document.getElementById('btnMute');
  if (MASTER_VOL === 0) {
    soundMuted = true;
    if (btn) btn.textContent = '\uD83D\uDD07';
  } else {
    soundMuted = false;
    if (btn) btn.textContent = '\uD83D\uDD0A';
  }
}

function getCtx() {
  if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  return audioCtx;
}

function resumeAudio() {
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
}

document.addEventListener('click', resumeAudio, { once: true });
document.addEventListener('touchstart', resumeAudio, { once: true });

function toggleMute() {
  soundMuted = !soundMuted;
  const btn = document.getElementById('btnMute');
  if (btn) btn.textContent = soundMuted ? '\uD83D\uDD07' : '\uD83D\uDD0A';
}

function toggleVolumeSlider() {
  const popup = document.getElementById('volumePopup');
  if (!popup) return;
  if (popup.style.display === 'none') {
    popup.style.display = 'block';
    // Close when clicking outside
    setTimeout(() => {
      document.addEventListener('click', function closeVol(e) {
        if (!e.target.closest('.volume-control')) {
          popup.style.display = 'none';
          document.removeEventListener('click', closeVol);
        }
      });
    }, 10);
  } else {
    popup.style.display = 'none';
  }
}

// ---- HELPERS ----

function noise(ctx, dur) {
  const n = ctx.sampleRate * dur;
  const buf = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  return src;
}

function masterGain(ctx) {
  const g = ctx.createGain();
  g.gain.value = MASTER_VOL;
  g.connect(ctx.destination);
  return g;
}

// ---- SOUNDS ----

// Card deal: soft paper slide + tiny snap at the end
function playDeal() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  // Paper slide — filtered noise, low volume
  const slide = noise(ctx, 0.06);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(2500 + Math.random() * 500, t);
  bp.Q.setValueAtTime(0.8, t);
  const g1 = ctx.createGain();
  g1.gain.setValueAtTime(0.12, t);
  g1.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
  slide.connect(bp); bp.connect(g1); g1.connect(out);
  slide.start(t); slide.stop(t + 0.06);

  // Snap — very short high-freq click
  const snap = noise(ctx, 0.015);
  const hp = ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.setValueAtTime(4000, t + 0.03);
  const g2 = ctx.createGain();
  g2.gain.setValueAtTime(0.08, t + 0.03);
  g2.gain.exponentialRampToValueAtTime(0.001, t + 0.045);
  snap.connect(hp); hp.connect(g2); g2.connect(out);
  snap.start(t + 0.03); snap.stop(t + 0.045);
}

// Chip bet: ceramic chips clinking on felt
function playChipBet() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  // 2-3 tiny ceramic clicks at slightly different pitches
  const count = 2 + Math.floor(Math.random() * 2);
  for (let i = 0; i < count; i++) {
    const dt = i * 0.035 + Math.random() * 0.01;
    const freq = 3500 + Math.random() * 1500;

    // Sine ping
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + dt);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.06, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.05);
    osc.connect(g); g.connect(out);
    osc.start(t + dt); osc.stop(t + dt + 0.05);

    // Noise texture for the "clink"
    const n = noise(ctx, 0.02);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(6000, t + dt);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.03, t + dt);
    gn.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.02);
    n.connect(hp); hp.connect(gn); gn.connect(out);
    n.start(t + dt); n.stop(t + dt + 0.02);
  }
}

// Check: two soft knocks on table
function playCheck() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  for (let i = 0; i < 2; i++) {
    const dt = i * 0.09;
    const n = noise(ctx, 0.025);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(800, t + dt);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.1, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.025);
    n.connect(lp); lp.connect(g); g.connect(out);
    n.start(t + dt); n.stop(t + dt + 0.025);
  }
}

// Fold: cards sliding on felt
function playFold() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  const n = noise(ctx, 0.15);
  const bp = ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.setValueAtTime(600, t);
  bp.frequency.exponentialRampToValueAtTime(300, t + 0.15);
  bp.Q.setValueAtTime(0.5, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.1, t);
  g.gain.linearRampToValueAtTime(0.04, t + 0.05);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.15);
  n.connect(bp); bp.connect(g); g.connect(out);
  n.start(t); n.stop(t + 0.15);
}

// Your turn: subtle soft ding
function playTurn() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(660, t);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.08, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  osc.connect(g); g.connect(out);
  osc.start(t); osc.stop(t + 0.3);
}

// Win: soft pleasant chord
function playWin() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  // Gentle major chord arpeggio
  [523, 659, 784].forEach((freq, i) => {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + i * 0.08);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.07, t + i * 0.08);
    g.gain.exponentialRampToValueAtTime(0.001, t + i * 0.08 + 0.5);
    osc.connect(g); g.connect(out);
    osc.start(t + i * 0.08); osc.stop(t + i * 0.08 + 0.5);
  });

  // Chip shower — many tiny chip sounds
  for (let i = 0; i < 6; i++) {
    const dt = 0.1 + i * 0.04 + Math.random() * 0.02;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(3000 + Math.random() * 2000, t + dt);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.03, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.04);
    osc.connect(g); g.connect(out);
    osc.start(t + dt); osc.stop(t + dt + 0.04);
  }
}

// All-in: dramatic chip push — big stack hitting felt
function playAllIn() {
  if (soundMuted) return;
  const ctx = getCtx();
  const t = ctx.currentTime;
  const out = masterGain(ctx);

  // Thud — low impact on felt
  const thud = noise(ctx, 0.1);
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.setValueAtTime(200, t);
  const gt = ctx.createGain();
  gt.gain.setValueAtTime(0.15, t);
  gt.gain.exponentialRampToValueAtTime(0.001, t + 0.1);
  thud.connect(lp); lp.connect(gt); gt.connect(out);
  thud.start(t); thud.stop(t + 0.1);

  // Chip cascade — many chips scattering
  for (let i = 0; i < 8; i++) {
    const dt = 0.02 + i * 0.03 + Math.random() * 0.015;
    const freq = 2500 + Math.random() * 2500;
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, t + dt);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.04, t + dt);
    g.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.06);
    osc.connect(g); g.connect(out);
    osc.start(t + dt); osc.stop(t + dt + 0.06);

    // Tiny noise per chip
    const cn = noise(ctx, 0.015);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.setValueAtTime(5000, t + dt);
    const gn = ctx.createGain();
    gn.gain.setValueAtTime(0.02, t + dt);
    gn.gain.exponentialRampToValueAtTime(0.001, t + dt + 0.015);
    cn.connect(hp); hp.connect(gn); gn.connect(out);
    cn.start(t + dt); cn.stop(t + dt + 0.015);
  }
}
