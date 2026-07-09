// ═══ citybuilder/js/16-ui-shell.js ════════════════════════════════════
// Sidebar tabs, fullscreen mode and responsive canvas, message toasts, event log, hover tooltip, factory income interval.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Sidebar tabs ──────────────────────────────────────────────────────────────

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    for (const b of document.querySelectorAll('.tab-btn'))
      b.classList.toggle('selected', b === btn);
    for (const page of document.querySelectorAll('.tab-page'))
      page.style.display = page.id === btn.dataset.tab ? '' : 'none';
  });
}

document.getElementById('mute-btn').addEventListener('click', () => {
  muted = !muted;
  document.getElementById('mute-btn').textContent = muted ? '🔇' : '🔊';
});

// ── Fullscreen & responsive canvas ────────────────────────────────────────────
// The canvas drawing buffer always matches its on-screen size (the CSS lets it
// flex to fill the space between the side panels). The ⛶ button fullscreens
// the whole page — panels included — and the canvas grows to fill the screen.

function resizeCanvasToDisplay() {
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
    canvas.width = w; canvas.height = h; // resizing resets all context state
    ctx.imageSmoothingEnabled = false;
    clampCamera();
    render();
  }
}
new ResizeObserver(resizeCanvasToDisplay).observe(canvas);

const fullscreenBtn = document.getElementById('fullscreen-btn');
fullscreenBtn.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen();
});
document.addEventListener('fullscreenchange', () => {
  const fs = !!document.fullscreenElement;
  document.body.classList.toggle('fullscreen', fs);
  fullscreenBtn.textContent = fs ? '🗙' : '⛶';
  fullscreenBtn.title = fs ? 'exit fullscreen' : 'fullscreen';
  // the ResizeObserver picks up the resulting canvas size change
});

// Minimap: click or drag to jump the camera
if (minimapCanvas) {
  const minimapJump = (e) => {
    const rect = minimapCanvas.getBoundingClientRect();
    const mc = (e.clientX - rect.left) / rect.width  * MAP_COLS;
    const mr = (e.clientY - rect.top)  / rect.height * MAP_ROWS;
    camX = mc - (canvas.width  / tileSize) / 2;
    camY = mr - (canvas.height / tileSize) / 2;
    followSelected = false;
    clampCamera();
    render();
    drawMinimap();
    updateUI();
  };
  minimapCanvas.addEventListener('mousedown', (e) => {
    minimapJump(e);
    const move = (ev) => minimapJump(ev);
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
}

// Hold space to pour people out beside the selected town hall — the Farm of
// Souls signature move
function spaceSpawnSite() {
  const th = townHalls[selectedTHIndex] || townHalls[0];
  if (!th) return null;
  return findGrassSiteNear(th.r, th.c, 1, 5);
}

window.addEventListener('keyup', (e) => {
  if (e.key === ' ') stopSpawnStream();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  let dx = 0, dy = 0;
  switch (e.key) {
    case 'ArrowLeft':  case 'a': dx = -3; break;
    case 'ArrowRight': case 'd': dx =  3; break;
    case 'ArrowUp':    case 'w': dy = -3; break;
    case 'ArrowDown':  case 's': dy =  3; break;
    case ' ':
      e.preventDefault();
      if (!e.repeat && !spawnStreamId && townHalls.length > 0) {
        const site = spaceSpawnSite();
        if (site) spawnPerson(site.r, site.c, true);
        startSpawnStream(spaceSpawnSite, false);
        render();
      }
      return;
    case '+': case '=': applyZoom(zoomIndex + 1, canvas.width/2, canvas.height/2); e.preventDefault(); return;
    case '-':           applyZoom(zoomIndex - 1, canvas.width/2, canvas.height/2); e.preventDefault(); return;
    case 'Escape':
      setClickMode('spawn');
      selectedPersonId = null;
      followSelected = false;
      updateInspector();
      render();
      return;
    default: return;
  }

  e.preventDefault();
  followSelected = false; // manual camera movement cancels follow-cam
  camX = clamp(camX + dx, 0, Math.max(0, MAP_COLS - canvas.width  / tileSize));
  camY = clamp(camY + dy, 0, Math.max(0, MAP_ROWS - canvas.height / tileSize));
  render();
  updateUI();
});

// ── Messages & event log ──────────────────────────────────────────────────────

// cls: undefined (neutral) | 'good' (green) | 'bad' (red) | 'info' (blue)
function logEvent(msg, cls) {
  const log = document.getElementById('event-log');
  if (!log) return;
  const entry = document.createElement('div');
  entry.className = 'log-entry' + (cls ? ' log-' + cls : '');
  entry.textContent = msg;
  log.prepend(entry);
  // Keep at most 40 entries
  while (log.children.length > 40) log.removeChild(log.lastChild);
}

function showMessage(msg) { logEvent(msg); }

// ── Hover tooltip ─────────────────────────────────────────────────────────────

const tooltip = document.createElement('div');
tooltip.id = 'tile-tooltip';
document.body.appendChild(tooltip);

let lastMouseX = 0, lastMouseY = 0;

function showHoverInfo(r, c) {
  const lines = [];

  if (!inLand(r, c)) {
    tooltip.innerHTML = '';
    const div = document.createElement('div');
    div.textContent = '🌲 unexplored wilderness — expand your land with souls';
    tooltip.appendChild(div);
    tooltip.style.display = 'block';
    positionTooltip();
    return;
  }

  // Citizens standing here
  for (const p of people) {
    if (p.insideBuilding) continue;
    if (Math.round(p.y) === r && Math.round(p.x) === c) {
      lines.push('🧍 ' + p.name + ' (lv ' + (p.level || 0) + ') — ' + jobTitle(p) + (p.sick ? ' (sick)' : p.hungry ? ' (hungry)' : ''));
    }
  }

  const t = grid[r][c];
  if (burningTiles[r + ',' + c]) {
    lines.push('🔥 ' + TILE_NAMES[t] + ' — ON FIRE!');
  } else if (t !== GRASS) {
    lines.push(TILE_NAMES[t]);
  }

  // House occupancy
  if (t === HOUSE || t === ROW_HOUSE || t === APARTMENT) {
    const h = findHouseRegistryEntry(r, c);
    if (h) lines.push('residents: ' + h.residents.length + ' / ' + h.slots);
  }

  // Workplace staffing
  const bEntry = buildingRegistry[r + ',' + c];
  if (bEntry) lines.push('workers: ' + bEntry.workers.length + ' / ' + MAX_WORKERS_PER_BUILDING);

  // Town hall stockpile
  if (t === TOWN_HALL) {
    const th = townHalls.find(x => x.r === r && x.c === c);
    if (th) {
      lines.push('🏛 level ' + (th.level || 1) + ' / ' + TH_MAX_LEVEL);
      lines.push('wood ' + Math.floor(th.resources.wood) + ' · stone ' + Math.floor(th.resources.stone) + ' · food ' + Math.floor(th.resources.food));
      lines.push('clay ' + Math.floor(th.resources.clay || 0) + ' · ore ' + Math.floor(th.resources.ore || 0));
      lines.push('happiness ' + (th.happiness ?? 70) + '%' + ((th.festivalUntil || 0) > simTick ? ' 🎪' : ''));
      lines.push('citizens ' + citizensOf(th).length
        + (th.militia ? ' · 🛡 ' + soldiersOf(th).length + ' soldiers' : '')
        + (hasWalls(th) ? ' · 🧱 walled' : th.wallPlan ? ' · 🧱 walls rising' : ''));
      if (isAtWar(th)) lines.push('⚔️ at war!');
    }
  }

  // Resource node
  const res = resourceMap[r][c];
  if (res && res.amount > 0) lines.push(res.type + ' ×' + Math.floor(res.amount));

  if (lines.length === 0) {
    clearHoverInfo();
    return;
  }
  tooltip.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    tooltip.appendChild(div);
  }
  tooltip.style.display = 'block';
  positionTooltip();
}

function positionTooltip() {
  const pad = 14;
  let tx = lastMouseX + pad, ty = lastMouseY + pad;
  const w = tooltip.offsetWidth, h = tooltip.offsetHeight;
  if (tx + w > window.innerWidth  - 4) tx = lastMouseX - w - 6;
  if (ty + h > window.innerHeight - 4) ty = lastMouseY - h - 6;
  tooltip.style.left = tx + 'px';
  tooltip.style.top  = ty + 'px';
}

function clearHoverInfo() {
  lawTooltipKey = null;
  tooltip.style.display = 'none';
}

// ── Income tick ───────────────────────────────────────────────────────────────

setInterval(() => {
  // Factory count comes from the cached tile counts (refreshed by updateUI)
  // instead of scanning all 10,000 tiles every second
  if (!cachedCounts) recomputeTileCounts();
  const income = (TILE_INCOME[FACTORY] || 0) * cachedCounts.factories
    * (lawActive('clean_air_act') ? 0.6 : 1);
  if (income !== 0) {
    gold = Math.max(0, gold + income);
    updateUI();
  }
}, 1000);
