// ═══ citybuilder/js/15-input.js ═══════════════════════════════════════
// Zoom, click modes (spawn/road/drops/demolish), mouse and keyboard input, hold-to-spawn streams.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Zoom ──────────────────────────────────────────────────────────────────────

function applyZoom(newIdx, pivotPx, pivotPy) {
  const tileC = camX + pivotPx / tileSize;
  const tileR = camY + pivotPy / tileSize;

  zoomIndex = clamp(newIdx, 0, ZOOM_LEVELS.length - 1);
  tileSize  = ZOOM_LEVELS[zoomIndex];

  camX = tileC - pivotPx / tileSize;
  camY = tileR - pivotPy / tileSize;
  clampCamera();
  render();
  updateUI();
}

// ── Click modes & demolish ────────────────────────────────────────────────────

const MODE_BUTTONS = {
  'spawn':      'mode-spawn',
  'road':       'mode-road',
  'drop-wood':  'mode-drop-wood',
  'drop-stone': 'mode-drop-stone',
  'drop-food':  'mode-drop-food',
  'drop-clay':  'mode-drop-clay',
  'drop-ore':   'mode-drop-ore',
  'demolish':   'mode-demolish',
};

function setClickMode(mode) {
  clickMode = mode;
  for (const [m, id] of Object.entries(MODE_BUTTONS)) {
    const btn = document.getElementById(id);
    if (btn) btn.classList.toggle('selected', m === mode);
  }
  canvas.classList.toggle('demolish', mode === 'demolish');
}

function demolishTile(r, c) {
  const t = grid[r][c];
  // Demolishing a burning tile snuffs the fire (firebreak) even if it clears the tile
  delete burningTiles[r + ',' + c];
  if (t === GRASS) return;

  if (t === HOUSE || t === ROW_HOUSE || t === APARTMENT) {
    for (const [id, h] of Object.entries(houseRegistry)) {
      if (h.r === r && h.c === c) {
        // Displace residents — try to reassign each to another house with vacancy
        for (const personId of [...h.residents]) {
          const p = people.find(q => q.id === personId);
          if (!p) continue;
          p.houseId = null;
          const vacancy = findHouseWithVacancy();
          if (vacancy) assignHouse(p, vacancy[0], vacancy[1]);
        }
        delete houseRegistry[id];
        const th = nearestTownHall(r, c);
        if (th) th.popCap = Math.max(1, th.popCap - h.slots);
        break;
      }
    }
  }

  if (WORKER_JOBS.has(t)) unregisterBuilding(r, c);

  // A felled wall segment weakens its town's defenses (hasWalls counts built)
  if (t === WALL) {
    const th = nearestTownHall(r, c);
    if (th && th.wallPlan) th.wallPlan.built = Math.max(0, th.wallPlan.built - 1);
  }

  if (t === TOWN_HALL) {
    const idx = townHalls.findIndex(th => th.r === r && th.c === c);
    if (idx !== -1) townHalls.splice(idx, 1);
  }

  grid[r][c] = GRASS;
  updateUI();
}

// ── Input ─────────────────────────────────────────────────────────────────────

// Hold-to-spawn: holding the mouse (or spacebar) streams people out, Farm of
// Souls style. The stream starts on mousedown but the first person only spawns
// after the interval fires — so a quick click still spawns exactly one (via the
// click handler), and drag-to-pan doesn't leak a spawn.
let spawnStreamId    = null;
let streamSpawnCount = 0;

function startSpawnStream(getSite, stopOnDrag = true) {
  stopSpawnStream();
  streamSpawnCount = 0;
  spawnStreamId = setInterval(() => {
    if (stopOnDrag && dragMoved) { stopSpawnStream(); return; }
    const site = getSite();
    if (site && spawnPerson(site.r, site.c, true)) {
      streamSpawnCount++;
      render();
    }
  }, 170);
}

function stopSpawnStream() {
  if (spawnStreamId) { clearInterval(spawnStreamId); spawnStreamId = null; }
}

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragMoved     = false;
  streamSpawnCount = 0;
  mouseDownX    = e.clientX;
  mouseDownY    = e.clientY;
  camDragStartX = camX;
  camDragStartY = camY;

  // Begin a spawn stream under the cursor (only once a town hall exists)
  if (clickMode === 'spawn' && townHalls.length > 0) {
    const { px, py } = getCanvasPos(e);
    const { r, c }   = canvasToTile(px, py);
    const onPerson = people.some(p => !p.insideBuilding && Math.round(p.y) === r && Math.round(p.x) === c);
    if (inBounds(r, c) && !onPerson) {
      startSpawnStream(() => inBounds(hoverR, hoverC) ? { r: hoverR, c: hoverC } : null);
    }
  }
});

canvas.addEventListener('mousemove', (e) => {
  const { px, py } = getCanvasPos(e);
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;

  if (e.buttons === 1) {
    const dx = e.clientX - mouseDownX;
    const dy = e.clientY - mouseDownY;

    if (!dragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragMoved = true;
      followSelected = false; // dragging cancels follow-cam
      canvas.style.cursor = 'grabbing';
    }

    if (dragMoved) {
      camX = camDragStartX - dx / tileSize;
      camY = camDragStartY - dy / tileSize;
      clampCamera();
      const { r, c } = canvasToTile(px, py);
      hoverR = r; hoverC = c;
      clearHoverInfo();
      render();
      updateUI();
      return;
    }
  }

  const { r, c } = canvasToTile(px, py);
  if (r !== hoverR || c !== hoverC) {
    hoverR = r; hoverC = c;
    render();
  }
  if (inBounds(r, c)) showHoverInfo(r, c);
});

window.addEventListener('mouseup', () => {
  stopSpawnStream();
  canvas.style.cursor = clickMode === 'demolish' ? '' : 'crosshair';
});

window.addEventListener('blur', stopSpawnStream);

canvas.addEventListener('mouseleave', () => {
  if (hoverR !== -1 || hoverC !== -1) {
    hoverR = -1; hoverC = -1;
    render();
  }
  clearHoverInfo();
});

canvas.addEventListener('click', (e) => {
  if (dragMoved) return;

  const { px, py } = getCanvasPos(e);
  const { r, c }   = canvasToTile(px, py);
  if (!inBounds(r, c)) return;

  if (clickMode === 'demolish') {
    demolishTile(r, c);
  } else if (clickMode === 'road') {
    payRoad(r, c);
  } else if (clickMode.startsWith('drop-')) {
    dropSupplies(r, c, clickMode.slice(5));
  } else {
    // Spawn mode: clicking a citizen inspects them; clicking open ground spawns.
    // If the held stream already spawned people here, the quick-click spawn is skipped.
    const clicked = people.find(p => !p.insideBuilding && Math.round(p.y) === r && Math.round(p.x) === c);
    if (clicked && streamSpawnCount === 0) {
      selectedPersonId = clicked.id;
      updateInspector();
    } else if (streamSpawnCount === 0) {
      spawnPerson(r, c);
    }
    streamSpawnCount = 0;
  }
  render();
});

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const { px, py } = getCanvasPos(e);
  const { r, c }   = canvasToTile(px, py);
  if (!inBounds(r, c) || grid[r][c] === GRASS) return;
  demolishTile(r, c);
  render();
});

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const { px, py } = getCanvasPos(e);
  applyZoom(zoomIndex + (e.deltaY < 0 ? 1 : -1), px, py);
}, { passive: false });

document.getElementById('zoom-in').addEventListener('click', () =>
  applyZoom(zoomIndex + 1, canvas.width / 2, canvas.height / 2));

document.getElementById('zoom-out').addEventListener('click', () =>
  applyZoom(zoomIndex - 1, canvas.width / 2, canvas.height / 2));

document.getElementById('speed-slider').addEventListener('input', e => {
  setSimSpeed(parseInt(e.target.value));
});

document.getElementById('speed-pause').addEventListener('click', () => {
  const slider = document.getElementById('speed-slider');
  const current = parseInt(slider.value);
  if (current === 0) {
    // Resume to 1× if we were fully paused
    slider.value = 1;
    setSimSpeed(1);
  } else {
    slider.value = 0;
    setSimSpeed(0);
  }
  document.getElementById('speed-pause').classList.toggle('selected', parseInt(slider.value) === 0);
});

document.getElementById('upg-life').addEventListener('click', upgradeLifespan);
document.getElementById('upg-speed').addEventListener('click', upgradeSpeed);
document.getElementById('upg-sight').addEventListener('click', upgradeSight);
document.getElementById('upg-land').addEventListener('click', upgradeLand);

// Power mode buttons — clicking the active one switches back to spawn mode
for (const [mode, id] of Object.entries(MODE_BUTTONS)) {
  const btn = document.getElementById(id);
  if (btn) btn.addEventListener('click', () => {
    setClickMode(clickMode === mode ? 'spawn' : mode);
  });
}

document.getElementById('festival-btn').addEventListener('click', startFestival);
document.getElementById('charter-btn').addEventListener('click', charterExpedition);
document.getElementById('campaign-for').addEventListener('click', () => campaign('for'));
document.getElementById('campaign-against').addEventListener('click', () => campaign('against'));

for (const btn of document.querySelectorAll('.sway-btn')) {
  btn.addEventListener('click', () => swayVote(parseInt(btn.dataset.type)));
}

document.getElementById('follow-btn').addEventListener('click', () => {
  followSelected = !followSelected;
  if (followSelected) followCamera();
  updateInspector();
  render();
});

document.getElementById('deselect-btn').addEventListener('click', () => {
  selectedPersonId = null;
  followSelected = false;
  updateInspector();
  render();
});
