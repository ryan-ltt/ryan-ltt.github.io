// ═══ citybuilder/js/17-save.js ════════════════════════════════════════
// Save/load (localStorage, JSON v10), all version migrations, export/import, save-tab buttons.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Save / Load ───────────────────────────────────────────────────────────────

const SAVE_KEY = 'citybuilder_save';

function saveGame() {
  const data = {
    v: 10,
    gold, souls, lifespanLevel, speedLevel, sightLevel, landLevel,
    simTick, nextPersonId, nextHouseId, lastExploreTick, nextTownId,
    researched: [...researched],
    grid:        grid.map(row => [...row]),
    resourceMap: resourceMap.map(row => row.map(cell => cell ? { ...cell } : null)),
    townHalls:   townHalls.map(th => ({
      r: th.r, c: th.c,
      id: th.id,
      resources: { ...th.resources },
      level: th.level ?? 1,
      votes: { ...th.votes },
      popCap: th.popCap,
      buildTimer: th.buildTimer ?? TH_BUILD_INTERVAL,
      happiness: th.happiness ?? 70,
      festivalUntil: th.festivalUntil ?? 0,
      nextMeasureTick: th.nextMeasureTick ?? 0,
      militia: th.militia ?? false,
      wallPlan: th.wallPlan ? { ...th.wallPlan } : null,
      lastRaidedTick: th.lastRaidedTick ?? -99999,
      lastWarEndTick: th.lastWarEndTick ?? -99999,
      grudgeAgainst: th.grudgeAgainst ?? null,
      grudgeTick: th.grudgeTick ?? -99999,
      abandonedSince: th.abandonedSince ?? null,
      sparseSince: th.sparseSince ?? null,
    })),
    wars: wars.map(w => ({ ...w })),
    houseRegistry: JSON.parse(JSON.stringify(houseRegistry)),
    buildingRegistry: JSON.parse(JSON.stringify(buildingRegistry)),
    people: people.map(p => ({ ...p })),
    discovered: [...discovered],
    records: { ...records },
    chronicle: chronicle.map(e => ({ ...e })),
    burningTiles: JSON.parse(JSON.stringify(burningTiles)),
    politics: JSON.parse(JSON.stringify(politics)),
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  showMessage('game saved!');
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showMessage('no save found.'); return false; }
  try {
    const data = JSON.parse(raw);
    if (!(data.v >= 1 && data.v <= 10)) { showMessage('save version mismatch.'); return false; }

    // Map growth (v10: 100×100 → 160×160). Saves from a smaller map are
    // recentered: every stored coordinate shifts by the same offset so the
    // old world sits in the middle of the new one, with fresh wilderness
    // (and fresh resource nodes, below) around it.
    const oldRows = data.grid.length, oldCols = data.grid[0].length;
    const offR = Math.max(0, Math.floor((MAP_ROWS - oldRows) / 2));
    const offC = Math.max(0, Math.floor((MAP_COLS - oldCols) / 2));
    if (offR > 0 || offC > 0) {
      const shiftRC = (o) => { if (o && o.r != null) { o.r += offR; o.c += offC; } };
      for (const th of data.townHalls || []) {
        shiftRC(th);
        if (th.wallPlan && th.wallPlan.cells)
          th.wallPlan.cells = th.wallPlan.cells.map(([r, c]) => [r + offR, c + offC]);
      }
      for (const p of data.people || []) {
        p.x += offC; p.y += offR;
        if (p.homeR != null) { p.homeR += offR; p.homeC += offC; }
        shiftRC(p.gatherTarget); shiftRC(p.socialTarget);
        shiftRC(p.foundTarget);  shiftRC(p.warTarget);
      }
      for (const h of Object.values(data.houseRegistry || {})) shiftRC(h);
      const shiftKeyed = (obj) => {
        const out = {};
        for (const e of Object.values(obj || {})) { shiftRC(e); out[e.r + ',' + e.c] = e; }
        return out;
      };
      data.buildingRegistry = shiftKeyed(data.buildingRegistry);
      data.burningTiles     = shiftKeyed(data.burningTiles);
    }

    gold             = data.gold;
    souls            = data.souls ?? 10;
    lifespanLevel    = data.lifespanLevel;
    speedLevel       = data.speedLevel ?? 0;
    sightLevel       = data.sightLevel ?? 0;
    simTick          = data.simTick;
    nextPersonId     = data.nextPersonId;
    nextHouseId      = data.nextHouseId;
    lastExploreTick  = data.lastExploreTick ?? -200;

    // v5 additions — default sensibly for older saves
    records = {
      peakPop: 0, oldestEver: 0, totalBirths: 0, totalDeaths: 0,
      townsFounded: (data.townHalls || []).length, firesSurvived: 0, won: false,
      soulsHarvested: 0, warsWaged: 0, battleDeaths: 0,
      ...(data.records || {}),
    };
    chronicle    = data.chronicle || [];
    burningTiles = data.burningTiles || {};

    // Politics (v8) — older saves start with a fresh slate; drop any law or
    // ballot whose policy no longer exists
    politics = {
      enacted: [], ballot: null, nextReferendumTick: 0, announcedFor: -1,
      ...(data.politics || {}),
    };
    politics.enacted = (politics.enacted || []).filter(k => POLICIES[k]);
    if (politics.ballot && !POLICIES[politics.ballot.key]) politics.ballot = null;
    fireActive   = Object.keys(burningTiles).length > 0;
    particles    = [];
    history      = { pop: [], food: [], gold: [], souls: [] };
    selectedPersonId = null;
    followSelected   = false;

    for (let r = 0; r < MAP_ROWS; r++)
      for (let c = 0; c < MAP_COLS; c++) {
        const inOld = r >= offR && r < offR + oldRows && c >= offC && c < offC + oldCols;
        grid[r][c]        = inOld ? data.grid[r - offR][c - offC] : GRASS;
        resourceMap[r][c] = inOld ? data.resourceMap[r - offR][c - offC] : null;
      }
    // Seed the newly exposed wilderness of a grown map with resource nodes so
    // expansion out there is worth it (regenerateResources alone is too slow)
    if (offR > 0 || offC > 0) {
      const types = ['wood', 'stone', 'food', 'clay', 'ore'];
      const counts = [120, 60, 80, 45, 30].map(n => Math.round(n * (MAP_AREA_SCALE - (oldRows * oldCols) / 10000)));
      for (let t = 0; t < types.length; t++)
        for (let i = 0; i < counts[t]; i++) {
          const r = Math.floor(Math.random() * MAP_ROWS);
          const c = Math.floor(Math.random() * MAP_COLS);
          const inOld = r >= offR && r < offR + oldRows && c >= offC && c < offC + oldCols;
          if (inOld || resourceMap[r][c]) continue;
          resourceMap[r][c] = { type: types[t], amount: 10 + Math.floor(Math.random() * 15) };
        }
    }

    // Land level (v6). Older saves may have built anywhere — unlock enough
    // land to cover every existing structure and citizen.
    if (data.landLevel != null) {
      landLevel = data.landLevel;
    } else {
      let need = LAND_BASE_HALF;
      const coverHalf = (r, c) =>
        Math.max(r - (LAND_CENTER - 1), LAND_CENTER - r, c - (LAND_CENTER - 1), LAND_CENTER - c);
      for (let r = 0; r < MAP_ROWS; r++)
        for (let c = 0; c < MAP_COLS; c++)
          if (grid[r][c] !== GRASS) need = Math.max(need, coverHalf(r, c));
      for (const p of (data.people || []))
        need = Math.max(need, coverHalf(Math.round(p.y), Math.round(p.x)));
      landLevel = clamp(Math.ceil((need - LAND_BASE_HALF) / LAND_STEP), 0, MAX_LAND_LEVEL);
    }

    townHalls    = data.townHalls.map(th => ({
      ...th,
      level: th.level ?? 1,
      resources: { wood: 0, stone: 0, food: 0, clay: 0, ore: 0, ...(th.resources || {}) },
      buildTimer: th.buildTimer ?? TH_BUILD_INTERVAL,
      happiness: th.happiness ?? 70,
      festivalUntil: th.festivalUntil ?? 0,
      // Ensure all vote keys exist for old saves
      votes: { ...emptyVotes(), ...(th.votes || {}) },
      // War & politics (v9) — pre-v9 towns start unarmed and at peace
      nextMeasureTick: th.nextMeasureTick ?? 0,
      militia: th.militia ?? false,
      wallPlan: th.wallPlan ?? null,
      lastRaidedTick: th.lastRaidedTick ?? -99999,
      lastWarEndTick: th.lastWarEndTick ?? -99999,   // v10
      grudgeAgainst: th.grudgeAgainst ?? null,
      grudgeTick: th.grudgeTick ?? -99999,           // v10 — old grudges load fresh-ish
      abandonedSince: th.abandonedSince ?? null,     // v10
      sparseSince: th.sparseSince ?? null,           // v10
    }));
    // Wall plans (v10): pre-v10 plans were square rings described by a radius.
    // Convert them to the cell-list format; segments already standing keep
    // counting toward hasWalls, and unbuilt legacy cells finish as planned.
    for (const th of townHalls) {
      const plan = th.wallPlan;
      if (!plan || plan.cells) continue;
      plan.cells = ringPositions(th.r, th.c, plan.radius).filter(([r, c]) => inBounds(r, c));
      plan.idx   = Math.min(plan.idx ?? 0, plan.cells.length);
      plan.built = plan.built ?? plan.cells.reduce((s, [r, c]) => s + (grid[r][c] === WALL ? 1 : 0), 0);
    }
    // Stable town ids (v9): assign fresh ids to older saves
    nextTownId = data.nextTownId ?? 0;
    for (const th of townHalls) {
      if (th.id == null) th.id = nextTownId++;
      else nextTownId = Math.max(nextTownId, th.id + 1);
    }
    // Wars (v9): drop any war whose towns no longer stand
    wars = (data.wars || []).filter(w => townHalls.some(t => t.id === w.attackerId)
                                      && townHalls.some(t => t.id === w.defenderId));
    for (const th of townHalls) if (th.grudgeAgainst != null
      && !townHalls.some(t => t.id === th.grudgeAgainst)) th.grudgeAgainst = null;
    houseRegistry = data.houseRegistry;
    // Migrate old saves that lack the `slots` or `residents` fields
    for (const [, h] of Object.entries(houseRegistry)) {
      if (h.slots == null) {
        const t = grid[h.r][h.c];
        h.slots = t === APARTMENT ? APARTMENT_POP
                : t === ROW_HOUSE ? ROW_HOUSE_POP
                : HOUSE_POP;
      }
      if (!Array.isArray(h.residents)) h.residents = [];
    }
    // Restore buildingRegistry (v2+), then reconcile against the grid so every
    // worker-capable building has an entry (also reconstructs v1 saves, and
    // farmProduceFood relies on farms being registered)
    buildingRegistry = data.buildingRegistry || {};
    for (let r = 0; r < MAP_ROWS; r++)
      for (let c = 0; c < MAP_COLS; c++) {
        const t = grid[r][c];
        if (WORKER_JOBS.has(t) && !buildingRegistry[r + ',' + c])
          buildingRegistry[r + ',' + c] = { r, c, type: t, workers: [] };
      }

    people       = data.people;
    // Migrate people fields added after initial save
    for (const p of people) {
      if (p.name  === undefined) p.name  = randomName();
      if (p.level === undefined) { p.level = 0; p.xp = 0; }
      if (p.sick  === undefined) p.sick  = false;
      if (p.sickTicks === undefined) p.sickTicks = 0;
      if (p.hungry === undefined) p.hungry = false;
      if (p.clay === undefined) p.clay = 0;
      if (p.ore  === undefined) p.ore  = 0;
      if (p.gatherTarget        === undefined) p.gatherTarget        = null;
      if (p.gatherPref          === undefined) p.gatherPref          = p.gatherFood ? 'food' : null;
      delete p.gatherFood;
      if (p.exploreWood         === undefined) p.exploreWood         = 0;
      if (p.exploreStone        === undefined) p.exploreStone        = 0;
      if (p.exploreTick         === undefined) p.exploreTick         = 0;
      if (p.houseId             === undefined) p.houseId             = null;
      if (p.assignedBuildingKey === undefined) p.assignedBuildingKey = null;
      if (p.insideBuilding      === undefined) p.insideBuilding      = false;
      if (p.sleeping            === undefined) p.sleeping            = false;
      if (p.socialTarget        === undefined) p.socialTarget        = null;
      if (p.foundTarget         === undefined) p.foundTarget         = null;
      // Citizenship (v9): adopt the nearest hall for older saves
      if (p.townId === undefined || !townHalls.some(t => t.id === p.townId)) {
        p.townId = nearestTownHall(Math.round(p.y), Math.round(p.x))?.id ?? null;
      }
      p.warTarget = null; // militaryTick re-issues orders every tick
      // Migrate old job/mode values
      if (p.job  === 'builder') p.job  = 'gatherer';
      if (p.job  === undefined) p.job  = 'gatherer';
      if (p.mode === 'build')   p.mode = 'gather';
      if (p.mode === undefined) p.mode = 'gather';
      delete p.buildCooldown;
      // Reset non-standard modes that can't safely resume across loads
      if (p.mode === 'explore' || p.mode === 'social' || p.mode === 'home' || p.mode === 'found'
          || p.mode === 'patrol' || p.mode === 'war' || p.mode === 'defend') {
        p.mode = 'gather';
        p.foundTarget = null;
      }
      // Soldiers of a disbanded (or vanished) militia stand down
      if (p.job === 'soldier') {
        const th = townHalls.find(t => t.id === p.townId);
        if (!th || !th.militia) p.job = 'gatherer';
        else p.mode = 'patrol';
      }
      // Validate worker links — drop stale references
      if (p.job === 'worker' && !buildingRegistry[p.assignedBuildingKey]) {
        p.job = 'gatherer'; p.assignedBuildingKey = null; p.insideBuilding = false;
      }
    }
    // Re-link workers into buildingRegistry.workers arrays
    for (const p of people) {
      if (p.job === 'worker' && p.assignedBuildingKey) {
        const entry = buildingRegistry[p.assignedBuildingKey];
        if (entry && !entry.workers.includes(p.id)) entry.workers.push(p.id);
      }
    }
    // Re-link people who already have a houseId (saves written after this patch)
    for (const p of people) {
      if (p.houseId != null && houseRegistry[p.houseId]) {
        const h = houseRegistry[p.houseId];
        if (!h.residents.includes(p.id)) h.residents.push(p.id);
        // Use walkable tile adjacent to house (house tile itself is impassable)
        let homeR = h.r, homeC = h.c;
        for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
          const nr = h.r + dr, nc = h.c + dc;
          if (!inBounds(nr, nc)) continue;
          const t = grid[nr][nc];
          if (t === GRASS || t === ROAD || t === PARK) { homeR = nr; homeC = nc; break; }
        }
        p.homeR = homeR; p.homeC = homeC;
      }
    }
    // Assign homeless people to any house with vacancy (old saves)
    for (const p of people) {
      if (p.houseId == null) {
        const vacancy = findHouseWithVacancy();
        if (vacancy) assignHouse(p, vacancy[0], vacancy[1]);
      }
    }
    discovered.clear();
    for (const t of data.discovered) discovered.add(t);

    // Research (v7). Older saves may already have gated buildings standing —
    // grant the matching research (and its prereqs) so those towns keep working.
    researched.clear();
    for (const k of data.researched || []) if (RESEARCH[k]) researched.add(k);
    const grantResearch = (key) => {
      if (!key || !RESEARCH[key] || researched.has(key)) return;
      researched.add(key);
      RESEARCH[key].req.forEach(grantResearch);
    };
    for (const entry of Object.values(buildingRegistry)) grantResearch(RESEARCH_FOR_TYPE[entry.type]);

    // Recompute era from restored records (never regresses within a save)
    if (records.peakPop < people.length) records.peakPop = people.length;
    eraIndex = 0;
    for (let i = 0; i < ERAS.length; i++) if (records.peakPop >= ERAS[i].pop) eraIndex = i;

    refreshHappiness();
    renderChronicle();
    renderDiscoveries();
    clampCamera();
    render();
    updateUI();
    showMessage('game loaded!');
    return true;
  } catch (e) {
    showMessage('failed to load save.');
    return false;
  }
}

function deleteSave() {
  localStorage.removeItem(SAVE_KEY);
  showMessage('save deleted.');
}

function exportSave() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showMessage('nothing to export — save first.'); return; }
  const blob = new Blob([raw], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'citybuilder_save.json';
  a.click();
  URL.revokeObjectURL(url);
}

function importSave(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      JSON.parse(e.target.result); // validate JSON before storing
      localStorage.setItem(SAVE_KEY, e.target.result);
      loadGame();
    } catch {
      showMessage('invalid save file.');
    }
  };
  reader.readAsText(file);
}

document.getElementById('stockpile-prev').addEventListener('click', () => {
  if (selectedTHIndex > 0) { selectedTHIndex--; updateUI(); }
});
document.getElementById('stockpile-next').addEventListener('click', () => {
  if (selectedTHIndex < townHalls.length - 1) { selectedTHIndex++; updateUI(); }
});
document.getElementById('votes-prev').addEventListener('click', () => {
  if (selectedTHIndex > 0) { selectedTHIndex--; updateUI(); }
});
document.getElementById('votes-next').addEventListener('click', () => {
  if (selectedTHIndex < townHalls.length - 1) { selectedTHIndex++; updateUI(); }
});
document.getElementById('town-prev').addEventListener('click', () => {
  if (selectedTHIndex > 0) { selectedTHIndex--; updateUI(); }
});
document.getElementById('town-next').addEventListener('click', () => {
  if (selectedTHIndex < townHalls.length - 1) { selectedTHIndex++; updateUI(); }
});

document.getElementById('save-btn').addEventListener('click', saveGame);
document.getElementById('load-btn').addEventListener('click', loadGame);
document.getElementById('export-btn').addEventListener('click', exportSave);
document.getElementById('import-btn').addEventListener('click', () => {
  document.getElementById('import-input').click();
});
document.getElementById('import-input').addEventListener('change', (e) => {
  importSave(e.target.files[0]);
  e.target.value = ''; // reset so same file can be re-imported
});
document.getElementById('delete-save-btn').addEventListener('click', () => {
  if (confirm('Delete saved game?')) deleteSave();
});
