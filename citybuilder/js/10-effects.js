// ═══ citybuilder/js/10-effects.js ═════════════════════════════════════
// Particles, chronicle/records/era tracking, trend-history sampling, camera follow, WebAudio sound effects.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Particles ─────────────────────────────────────────────────────────────────

function addParticles(r, c, color, n = 5) {
  for (let i = 0; i < n; i++) {
    const life = 10 + Math.floor(Math.random() * 8);
    particles.push({
      x: c + 0.3 + Math.random() * 0.4,
      y: r + 0.3 + Math.random() * 0.4,
      vx: (Math.random() - 0.5) * 0.12,
      vy: -0.04 - Math.random() * 0.08,
      life, maxLife: life,
      color,
    });
  }
  if (particles.length > 400) particles.splice(0, particles.length - 400);
}

// Pale wisps that drift slowly skyward from a death site — the soul harvest, made visible
function addSoulWisp(r, c, n = 3) {
  for (let i = 0; i < n; i++) {
    const life = 26 + Math.floor(Math.random() * 14);
    particles.push({
      x: c + 0.35 + Math.random() * 0.3,
      y: r + 0.2 + Math.random() * 0.3,
      vx: (Math.random() - 0.5) * 0.03,
      vy: -0.05 - Math.random() * 0.04,
      life, maxLife: life,
      color: i % 2 === 0 ? '#e1f5fe' : '#b3e5fc',
    });
  }
  if (particles.length > 400) particles.splice(0, particles.length - 400);
}

function updateParticles() {
  for (const pt of particles) {
    pt.x += pt.vx;
    pt.y += pt.vy;
    pt.life--;
  }
  particles = particles.filter(pt => pt.life > 0);
}

// ── Chronicle, records & era ──────────────────────────────────────────────────

function addChronicle(text) {
  chronicle.push({ day: Math.floor(simTick / DAY_LENGTH) + 1, text });
  if (chronicle.length > 80) chronicle.shift();
  renderChronicle();
}

function renderChronicle() {
  const list = document.getElementById('chronicle-list');
  if (!list) return;
  list.innerHTML = '';
  for (let i = chronicle.length - 1; i >= 0; i--) {
    const entry = document.createElement('div');
    entry.className = 'chronicle-entry';
    entry.textContent = 'day ' + chronicle[i].day + ' — ' + chronicle[i].text;
    list.appendChild(entry);
  }
}

function updateRecordsAndEra() {
  if (people.length > records.peakPop) records.peakPop = people.length;
  let idx = 0;
  for (let i = 0; i < ERAS.length; i++) if (records.peakPop >= ERAS[i].pop) idx = i;
  if (idx > eraIndex) {
    eraIndex = idx;
    const era = ERAS[eraIndex];
    addChronicle('the settlement grew into a ' + era.name);
    logEvent('🎉 a new era: your settlement is now a ' + era.name + '!', 'good');
    showBanner('🎉 ' + era.name + ' era 🎉');
    sfx('era');
    if (eraIndex === ERAS.length - 1 && !records.won) {
      records.won = true;
      addChronicle('the city thrives — the dream is complete');
      setTimeout(() => showBanner('🏆 your civilization thrives! 🏆'), 4000);
    }
  }
}

function showBanner(text) {
  const b = document.createElement('div');
  b.className = 'era-banner';
  b.textContent = text;
  document.body.appendChild(b);
  requestAnimationFrame(() => b.classList.add('show'));
  setTimeout(() => {
    b.classList.remove('show');
    setTimeout(() => b.remove(), 700);
  }, 3500);
}

// ── Trend history ─────────────────────────────────────────────────────────────

function recordHistory() {
  const totalFood = townHalls.reduce((s, th) => s + th.resources.food, 0);
  history.pop.push(people.length);
  history.food.push(Math.floor(totalFood));
  history.gold.push(Math.floor(gold));
  history.souls.push(Math.floor(souls));
  for (const key of ['pop', 'food', 'gold', 'souls']) {
    if (history[key].length > HISTORY_MAX) history[key].shift();
  }
}

// ── Camera follow ─────────────────────────────────────────────────────────────

function followCamera() {
  const p = people.find(q => q.id === selectedPersonId);
  if (!p) { followSelected = false; return; }
  camX = p.x + 0.5 - (canvas.width  / tileSize) / 2;
  camY = p.y + 0.5 - (canvas.height / tileSize) / 2;
  clampCamera();
}

// ── Sound ─────────────────────────────────────────────────────────────────────

let audioCtx = null;
function ensureAudio() {
  if (audioCtx) return;
  try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { /* no audio */ }
}
document.addEventListener('pointerdown', ensureAudio, { once: true });

function playTone(freq, dur, delay = 0, type = 'square', vol = 0.04) {
  if (!audioCtx) return;
  const t = audioCtx.currentTime + delay;
  const osc = audioCtx.createOscillator();
  const g   = audioCtx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  osc.connect(g).connect(audioCtx.destination);
  osc.start(t);
  osc.stop(t + dur + 0.02);
}

function sfx(name) {
  if (muted || !audioCtx) return;
  switch (name) {
    case 'birth': playTone(880, 0.07); playTone(1320, 0.09, 0.08); break;
    case 'build': playTone(220, 0.06, 0, 'square', 0.05); playTone(165, 0.06, 0.07, 'square', 0.05); break;
    case 'coin':  playTone(1040, 0.05, 0, 'triangle'); playTone(1560, 0.08, 0.05, 'triangle'); break;
    case 'fire':  playTone(440, 0.15, 0, 'sawtooth', 0.05); playTone(370, 0.15, 0.18, 'sawtooth', 0.05); playTone(440, 0.15, 0.36, 'sawtooth', 0.05); break;
    case 'bad':   playTone(220, 0.2, 0, 'sawtooth', 0.04); playTone(175, 0.25, 0.2, 'sawtooth', 0.04); break;
    case 'era':   [523, 659, 784, 1046].forEach((f, i) => playTone(f, 0.14, i * 0.1, 'triangle', 0.05)); break;
    case 'soul':  playTone(1568, 0.12, 0, 'sine', 0.03); playTone(2093, 0.16, 0.1, 'sine', 0.02); break;
    case 'spawn': playTone(660, 0.05, 0, 'triangle', 0.03); break;
  }
}
