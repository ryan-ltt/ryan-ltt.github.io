// ═══ citybuilder/js/13-ui.js ══════════════════════════════════════════
// DOM refresh: throttled updateUI, stats/stockpile/votes panels, politics and town-affairs UI, minimap, trend graphs.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── UI ────────────────────────────────────────────────────────────────────────

// Building counts are cached and refreshed every few UI ticks — scanning all
// 10,000 tiles every 250ms tick was wasteful at high sim speeds.
let uiTickCounter = 0;
let cachedCounts = null;

// The sim can tick 40×/s at 10× speed; the DOM only needs a few refreshes per
// second. simulationTick uses this throttled entry point — direct updateUI()
// calls from user actions still refresh immediately.
let lastUIRefreshAt = 0;
const UI_REFRESH_MS = 150;

function updateUIThrottled() {
  if (performance.now() - lastUIRefreshAt >= UI_REFRESH_MS) updateUI();
}

function recomputeTileCounts() {
  let buildings = 0, factories = 0;
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const t = grid[r][c];
      if (t !== GRASS) buildings++;
      if (t === FACTORY) factories++;
    }
  }
  cachedCounts = { buildings, factories };
}

function updateUI() {
  lastUIRefreshAt = performance.now();
  uiTickCounter++;
  document.getElementById('gold').textContent = '$' + Math.floor(gold);
  document.getElementById('souls').textContent = '✨ ' + Math.floor(souls);

  const { hour, minute } = timeOfDay();
  const h12  = hour % 12 || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  const mm   = String(minute).padStart(2, '0');
  document.getElementById('sim-time').textContent = `${h12}:${mm}${ampm}`;

  const day = Math.floor(simTick / DAY_LENGTH) + 1;
  document.getElementById('sim-day').textContent = day;
  document.getElementById('season-val').textContent = currentSeason();
  document.getElementById('era-val').textContent = ERAS[eraIndex].name;

  if (!cachedCounts || uiTickCounter % 4 === 1) recomputeTileCounts();
  document.getElementById('stat-buildings').textContent = cachedCounts.buildings;

  const happy = townHalls.length > 0 ? globalHappiness() : 100;
  const hapEl = document.getElementById('happiness');
  hapEl.textContent = happy + '%';
  hapEl.className = 'value ' + (happy >= 70 ? 'pos' : happy >= 40 ? '' : 'neg');

  const cap = globalPopCap();
  document.getElementById('people-count').textContent = people.length + ' / ' + cap;
  document.getElementById('lifespan-val').textContent = Math.round(currentMaxAge() / DAY_LENGTH) + 'd';
  const homeless = homelessCount();
  const homelessEl = document.getElementById('people-homeless');
  if (homelessEl) {
    homelessEl.textContent = homeless;
    homelessEl.className = 'value ' + (homeless > 0 ? 'neg' : 'pos');
  }
  const vacancyEl = document.getElementById('people-vacancy');
  if (vacancyEl) vacancyEl.textContent = housingVacancy().empty;

  // Per-TH stockpile display
  if (selectedTHIndex >= townHalls.length) selectedTHIndex = Math.max(0, townHalls.length - 1);
  const selectedTH = townHalls[selectedTHIndex] || null;
  document.getElementById('res-wood').textContent  = selectedTH ? Math.floor(selectedTH.resources.wood)  : 0;
  document.getElementById('res-stone').textContent = selectedTH ? Math.floor(selectedTH.resources.stone) : 0;
  document.getElementById('res-food').textContent  = selectedTH ? Math.floor(selectedTH.resources.food)  : 0;
  const clayEl = document.getElementById('res-clay');
  if (clayEl) clayEl.textContent = selectedTH ? Math.floor(selectedTH.resources.clay || 0) : 0;
  const oreEl = document.getElementById('res-ore');
  if (oreEl) oreEl.textContent = selectedTH ? Math.floor(selectedTH.resources.ore || 0) : 0;
  const lvlEl = document.getElementById('res-level');
  if (lvlEl) lvlEl.textContent = selectedTH ? 'lv ' + (selectedTH.level || 1) + ' / ' + TH_MAX_LEVEL : '—';
  const thHappyEl = document.getElementById('res-happiness');
  if (thHappyEl) {
    thHappyEl.textContent = selectedTH ? (selectedTH.happiness ?? 70) + '%' : '—';
    thHappyEl.className = 'value ' + (selectedTH && selectedTH.happiness >= 70 ? 'pos' : selectedTH && selectedTH.happiness < 40 ? 'neg' : '');
  }
  document.getElementById('stockpile-th-label').textContent = townHalls.length > 1
    ? 'TH ' + (selectedTHIndex + 1) + ' / ' + townHalls.length + ' (' + (selectedTH ? selectedTH.c + ',' + selectedTH.r : '—') + ')'
    : 'town hall';
  document.getElementById('stockpile-prev').disabled = selectedTHIndex === 0;
  document.getElementById('stockpile-next').disabled = selectedTHIndex >= townHalls.length - 1;

  // The four soul upgrades
  const landSize = landHalf(landLevel) * 2;
  const upgRows = [
    ['upg-life',  '❤️ life',  lifespanLevel, MAX_LIFESPAN_UPGRADES, lifespanUpgradeCost(), Math.round(currentMaxAge() / DAY_LENGTH) + 'd'],
    ['upg-speed', '👟 speed', speedLevel,    MAX_SPEED_UPGRADES,    speedUpgradeCost(),    null],
    ['upg-sight', '👁 sight', sightLevel,    MAX_SIGHT_UPGRADES,    sightUpgradeCost(),    null],
    ['upg-land',  '🗺 land',  landLevel,     MAX_LAND_LEVEL,        landUpgradeCost(),     landSize + '×' + landSize],
  ];
  for (const [id, label, lvl, max, cost, detail] of upgRows) {
    const btn = document.getElementById(id);
    if (!btn) continue;
    const suffix = detail ? ' · ' + detail : '';
    if (lvl >= max) {
      btn.textContent = label + ' maxed' + suffix;
      btn.disabled = true;
    } else {
      btn.textContent = label + ' ' + lvl + suffix + ' (✨' + cost + ')';
      btn.disabled = souls < cost;
    }
  }

  // Workforce breakdown
  const jobCounts = { founder: 0, gatherer: 0, explorer: 0, worker: 0, soldier: 0, idle: 0 };
  for (const p of people) jobCounts[p.job] = (jobCounts[p.job] || 0) + 1;
  document.getElementById('job-founder').textContent  = jobCounts.founder;
  document.getElementById('job-gatherer').textContent = jobCounts.gatherer;
  document.getElementById('job-explorer').textContent = jobCounts.explorer;
  document.getElementById('job-worker').textContent   = jobCounts.worker;
  const soldierEl = document.getElementById('job-soldier');
  if (soldierEl) soldierEl.textContent = jobCounts.soldier;
  document.getElementById('job-idle').textContent     = jobCounts.idle;
  const bEntries = Object.values(buildingRegistry);
  const staffed = bEntries.filter(e => e.workers.length > 0).length;
  document.getElementById('buildings-staffed').textContent = staffed + ' / ' + bEntries.length;

  document.getElementById('zoom-label').textContent = ZOOM_LABELS[zoomIndex];
  const centerC = Math.floor(camX + (canvas.width  / tileSize) / 2);
  const centerR = Math.floor(camY + (canvas.height / tileSize) / 2);
  document.getElementById('cam-pos').textContent = centerC + ', ' + centerR;

  // Powers panel button states
  const modeSpawn = document.getElementById('mode-spawn');
  modeSpawn.disabled = townHalls.length > 0 && (souls < SPAWN_COST || people.length >= cap);
  document.getElementById('mode-road').disabled       = gold < POWER_COSTS.road;
  document.getElementById('mode-drop-wood').disabled  = gold < POWER_COSTS.drop;
  document.getElementById('mode-drop-stone').disabled = gold < POWER_COSTS.drop;
  document.getElementById('mode-drop-food').disabled  = gold < POWER_COSTS.drop;
  const dropClayBtn = document.getElementById('mode-drop-clay');
  if (dropClayBtn) dropClayBtn.disabled = gold < POWER_COSTS.drop;
  const dropOreBtn = document.getElementById('mode-drop-ore');
  if (dropOreBtn) dropOreBtn.disabled = gold < POWER_COSTS.drop;
  const festBtn = document.getElementById('festival-btn');
  const festActive = selectedTH && (selectedTH.festivalUntil || 0) > simTick;
  festBtn.disabled = !selectedTH || gold < POWER_COSTS.festival || festActive;
  festBtn.textContent = festActive ? '🎪 festival underway!' : 'festival ($' + POWER_COSTS.festival + ')';
  document.getElementById('charter-btn').disabled =
    !selectedTH || gold < POWER_COSTS.charter || people.some(p => p.mode === 'found');

  // Votes panel
  document.getElementById('votes-panel').style.display = townHalls.length > 0 ? '' : 'none';
  const voteTH = townHalls[selectedTHIndex] || null;
  const v = voteTH ? voteTH.votes : {};
  document.getElementById('votes-th-label').textContent = townHalls.length > 1
    ? 'TH ' + (selectedTHIndex + 1) + ' / ' + townHalls.length + ' (' + (voteTH ? voteTH.c + ',' + voteTH.r : '—') + ')'
    : 'town hall';
  document.getElementById('votes-prev').disabled = selectedTHIndex === 0;
  document.getElementById('votes-next').disabled = selectedTHIndex >= townHalls.length - 1;
  const voteRows = [
    ['votes-church',     CHURCH,     0],
    ['votes-park',       PARK,       0],
    ['votes-factory',    FACTORY,    0],
    ['votes-tree-farm',  TREE_FARM,  0],
    ['votes-stone-farm', STONE_FARM, 0],
    ['votes-farm',       FARM,       0],
    ['votes-shop',       SHOP,       1],
    ['votes-well',       WELL,       1],
    ['votes-school',     SCHOOL,     2],
  ];
  for (const [elId, type, minEra] of voteRows) {
    const el = document.getElementById(elId);
    if (!el) continue;
    const rkey = RESEARCH_FOR_TYPE[type];
    const needLvl = BUILDING_TH_LEVEL[type] || 1;
    let lockText = null;
    if (eraIndex < minEra)                                lockText = '🔒 ' + ERAS[minEra].name;
    else if (rkey && !researched.has(rkey))               lockText = '🔒 ' + RESEARCH[rkey].name;
    else if (voteTH && needLvl > (voteTH.level || 1))     lockText = '🔒 hall lv ' + needLvl;
    el.textContent = lockText || (v[type] || 0) + ' / ' + VOTE_THRESHOLD;
    const btn = document.querySelector('.sway-btn[data-type="' + type + '"]');
    if (btn) btn.disabled = !!lockText || !voteTH || gold < POWER_COSTS.sway;
  }

  // Research panel
  renderResearch();

  // Politics panel
  updatePoliticsUI();
  updateTownAffairsUI();

  // Inspector panel
  updateInspector();

  // Records panel
  document.getElementById('rec-peak-pop').textContent  = records.peakPop;
  document.getElementById('rec-oldest').textContent    = records.oldestEver + 'd';
  document.getElementById('rec-births').textContent    = records.totalBirths;
  document.getElementById('rec-deaths').textContent    = records.totalDeaths;
  document.getElementById('rec-towns').textContent     = records.townsFounded;
  document.getElementById('rec-fires').textContent     = records.firesSurvived;
  const recSouls = document.getElementById('rec-souls');
  if (recSouls) recSouls.textContent = Math.floor(records.soulsHarvested);
  const recWars = document.getElementById('rec-wars');
  if (recWars) recWars.textContent = records.warsWaged || 0;
  const recBattle = document.getElementById('rec-battle-deaths');
  if (recBattle) recBattle.textContent = records.battleDeaths || 0;

  // Minimap & trend graphs (throttled — they redraw whole canvases)
  if (uiTickCounter % 4 === 1) drawMinimap();
  if (uiTickCounter % 8 === 1) drawTrends();
}

// ── Politics UI ───────────────────────────────────────────────────────────────

// Polling every citizen on every UI refresh would be wasteful — cache results
// and refresh every couple of seconds (or immediately when the ballot changes)
let cachedPoll       = { tick: -1, value: 50, key: null };
let cachedLawSupport = { tick: -1, values: {} };

function updatePoliticsUI() {
  const lockedEl = document.getElementById('politics-locked');
  const boxEl    = document.getElementById('referendum-box');
  if (!lockedEl || !boxEl) return;
  const awake = politics.nextReferendumTick > 0;
  lockedEl.style.display = awake ? 'none' : '';
  boxEl.style.display    = awake ? '' : 'none';

  if (awake) {
    const ticksLeft = Math.max(0, politics.nextReferendumTick - simTick);
    document.getElementById('ballot-when').textContent = ticksLeft >= DAY_LENGTH
      ? (ticksLeft / DAY_LENGTH).toFixed(1) + 'd'
      : Math.max(1, Math.ceil(ticksLeft / 4)) + 'h';
    const b = politics.ballot;
    const pol = b ? POLICIES[b.key] : null;
    document.getElementById('ballot-measure').textContent =
      b ? (b.kind === 'repeal' ? 'repeal ' : '') + pol.emoji + ' ' + pol.name : 'being drafted…';
    document.getElementById('ballot-desc').textContent = b ? pol.desc : '';
    const pollEl = document.getElementById('ballot-poll');
    if (b) {
      const pollKey = b.key + b.kind + b.for + b.against;
      if (cachedPoll.key !== pollKey || simTick - cachedPoll.tick >= 8) {
        cachedPoll = { tick: simTick, value: pollBallot(), key: pollKey };
      }
      pollEl.textContent = cachedPoll.value + '% in favour';
      pollEl.className = 'value ' + (cachedPoll.value >= 50 ? 'pos' : 'neg');
    } else {
      pollEl.textContent = '—';
      pollEl.className = 'value';
    }
    document.getElementById('campaign-for').disabled =
      !b || gold < POWER_COSTS.campaign || b.for >= CAMPAIGN_MAX;
    document.getElementById('campaign-against').disabled =
      !b || gold < POWER_COSTS.campaign || b.against >= CAMPAIGN_MAX;
  }

  // Laws in force, with how the people feel about each — a resented law is
  // headed for a repeal vote
  const list = document.getElementById('laws-list');
  if (!list) return;
  if (politics.enacted.length === 0) {
    if (list.dataset.sig !== 'none') {
      list.dataset.sig = 'none';
      list.innerHTML = '<p class="hint">no laws have been enacted yet</p>';
    }
    return;
  }
  if (simTick - cachedLawSupport.tick >= 32
      || Object.keys(cachedLawSupport.values).length !== politics.enacted.length) {
    const values = {};
    for (const key of politics.enacted) values[key] = avgSupport(key);
    cachedLawSupport = { tick: simTick, values };
  }
  const moodOf = a => a >= 0.05 ? 'popular' : a <= -0.05 ? 'resented' : 'tolerated';
  // Rebuild the rows only when the laws or their moods change — rebuilding on
  // every UI refresh would tear the hover tooltips down as they appear
  const sig = politics.enacted.map(k => k + ':' + moodOf(cachedLawSupport.values[k] ?? 0)).join('|');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  if (lawTooltipKey) clearHoverInfo(); // the hovered row is about to be replaced
  list.innerHTML = '';
  for (const key of politics.enacted) {
    const pol = POLICIES[key];
    const row = document.createElement('div');
    row.className = 'stat-row law-row';
    const name = document.createElement('span');
    name.textContent = pol.emoji + ' ' + pol.name;
    const val = document.createElement('span');
    const a = cachedLawSupport.values[key] ?? 0;
    val.className = 'value ' + (a >= 0.05 ? 'pos' : a <= -0.05 ? 'neg' : '');
    val.textContent = moodOf(a);
    row.appendChild(name);
    row.appendChild(val);
    row.addEventListener('mouseenter', (e) => showLawTooltip(key, e));
    row.addEventListener('mousemove',  (e) => showLawTooltip(key, e));
    row.addEventListener('mouseleave', clearHoverInfo);
    list.appendChild(row);
  }
}

// Town affairs: the selected town's militia, walls, and wars (politics tab)
function updateTownAffairsUI() {
  const label = document.getElementById('town-th-label');
  if (!label) return;
  const th = townHalls[selectedTHIndex] || null;
  label.textContent = townHalls.length > 1
    ? 'TH ' + (selectedTHIndex + 1) + ' / ' + townHalls.length + ' (' + (th ? th.c + ',' + th.r : '—') + ')'
    : 'town hall';
  document.getElementById('town-prev').disabled = selectedTHIndex === 0;
  document.getElementById('town-next').disabled = selectedTHIndex >= townHalls.length - 1;

  const czEl = document.getElementById('town-citizens');
  const miEl = document.getElementById('town-militia');
  const waEl = document.getElementById('town-walls');
  const wrEl = document.getElementById('town-war');
  if (!th) {
    czEl.textContent = '—'; miEl.textContent = '—'; waEl.textContent = '—'; wrEl.textContent = '—';
  } else {
    const pop = citizensOf(th).length;
    czEl.textContent = pop + (pop < TOWN_MIN_POP ? ' (meets at ' + TOWN_MIN_POP + ')' : '');
    miEl.textContent = th.militia ? '🛡 ' + soldiersOf(th).length + ' soldiers' : 'none';
    const plan = th.wallPlan;
    waEl.textContent = !plan ? 'none'
      : plan.done ? '🧱 standing (' + plan.built + ' segments)' + (plan.needsWork ? ' · in disrepair' : '')
      : '🧱 building… (' + plan.built + ' laid)';
    const attacking = wars.find(w => w.attackerId === th.id);
    const defending = wars.find(w => w.defenderId === th.id);
    wrEl.textContent = attacking ? '⚔️ raiding ' + (townById(attacking.defenderId) ? townById(attacking.defenderId).c + ',' + townById(attacking.defenderId).r : '?')
                     : defending ? '🛡 under attack!'
                     : raidedRecently(th) ? 'at peace (recently raided)'
                     : 'at peace';
    wrEl.className = 'value ' + (attacking || defending ? 'neg' : 'pos');
  }

  // All active wars, with time left and the running tally
  const list = document.getElementById('wars-list');
  if (!list) return;
  const sig = wars.map(w => w.attackerId + '>' + w.defenderId + ':' + Math.floor(w.loot) + ':'
    + w.attackerLosses + ':' + w.defenderLosses + ':' + (w.razed || 0) + ':'
    + Math.ceil((w.endTick - simTick) / 4)).join('|');
  if (list.dataset.sig === sig) return;
  list.dataset.sig = sig;
  list.innerHTML = '';
  for (const w of wars) {
    const att = townById(w.attackerId), def = townById(w.defenderId);
    const row = document.createElement('div');
    row.className = 'stat-row';
    const name = document.createElement('span');
    name.textContent = '⚔️ TH' + (townHalls.indexOf(att) + 1) + ' → TH' + (townHalls.indexOf(def) + 1);
    const val = document.createElement('span');
    val.className = 'value neg';
    const hoursLeft = Math.max(0, Math.ceil((w.endTick - simTick) / 4));
    val.textContent = Math.floor(w.loot) + ' looted · ' + (w.razed || 0) + ' razed · '
      + (w.attackerLosses + w.defenderLosses)
      + ' fallen · ' + (hoursLeft >= 24 ? (hoursLeft / 24).toFixed(1) + 'd' : hoursLeft + 'h') + ' left';
    row.appendChild(name);
    row.appendChild(val);
    list.appendChild(row);
  }
}

// Rich hover card for a law in force: what it does and where opinion stands
let lawTooltipKey = null;

function showLawTooltip(key, e) {
  const pol = POLICIES[key];
  lawTooltipKey = key;
  lastMouseX = e.clientX;
  lastMouseY = e.clientY;
  let favour = 0;
  for (const p of people) if (policySupport(key, p) > 0) favour++;
  const share = people.length > 0 ? Math.round((favour / people.length) * 100) : 0;
  const lines = [
    pol.emoji + ' ' + pol.name + ' — law in force',
    pol.desc,
    share + '% of citizens favour keeping it'
      + (share < 50 ? ' — a repeal vote is coming' : ''),
  ];
  tooltip.innerHTML = '';
  for (const line of lines) {
    const div = document.createElement('div');
    div.textContent = line;
    tooltip.appendChild(div);
  }
  tooltip.style.display = 'block';
  positionTooltip();
}

// Workers show their trade (forester, mason, priest…) instead of plain "worker"
function jobTitle(p) {
  if (p.job === 'worker' && p.assignedBuildingKey) {
    const entry = buildingRegistry[p.assignedBuildingKey];
    if (entry && WORKER_TITLES[entry.type]) return WORKER_TITLES[entry.type];
  }
  return p.job;
}

function updateInspector() {
  const panel = document.getElementById('inspector-panel');
  const p = selectedPersonId != null ? people.find(q => q.id === selectedPersonId) : null;
  if (!p) {
    panel.style.display = 'none';
    return;
  }
  panel.style.display = '';
  document.getElementById('insp-name').textContent = p.name;
  const days = (p.age / DAY_LENGTH).toFixed(1);
  const maxDays = Math.round(p.maxAge / DAY_LENGTH);
  document.getElementById('insp-age').textContent = days + 'd / ' + maxDays + 'd';
  document.getElementById('insp-job').textContent = jobTitle(p) + (p.sick ? ' (sick 🤒)' : p.hungry ? ' (hungry)' : '');
  const inspLevel = document.getElementById('insp-level');
  if (inspLevel) {
    inspLevel.textContent = (p.level || 0) >= MAX_PERSON_LEVEL
      ? 'lv ' + p.level + ' (max)'
      : 'lv ' + (p.level || 0) + ' · ' + Math.floor(p.xp || 0) + '/' + xpForNext(p.level || 0) + ' xp';
  }
  document.getElementById('insp-mode').textContent =
    p.insideBuilding ? 'inside a building' : p.sleeping ? 'sleeping' : p.mode;
  const carryParts = RES_KINDS.map(k => (p[k] ? p[k] + ' ' + k : null)).filter(Boolean);
  document.getElementById('insp-carrying').textContent = carryParts.length ? carryParts.join(', ') : 'nothing';
  document.getElementById('insp-home').textContent =
    p.houseId != null && houseRegistry[p.houseId] ? houseRegistry[p.houseId].c + ', ' + houseRegistry[p.houseId].r : 'homeless';
  const townEl = document.getElementById('insp-town');
  if (townEl) {
    const homeTown = townOf(p);
    townEl.textContent = homeTown
      ? 'TH ' + (townHalls.indexOf(homeTown) + 1) + ' (' + homeTown.c + ', ' + homeTown.r + ')'
      : '—';
  }
  const stanceEl = document.getElementById('insp-politics');
  if (stanceEl) {
    const b = politics.ballot;
    if (b) {
      const lean = ballotLeaning(p);
      const measure = (b.kind === 'repeal' ? 'repealing ' : '') + POLICIES[b.key].name;
      stanceEl.textContent = lean > 0.05 ? '👍 for ' + measure
                           : lean < -0.05 ? '👎 against ' + measure
                           : '🤷 unsure on ' + measure;
    } else {
      stanceEl.textContent = '—';
    }
  }
  const followBtn = document.getElementById('follow-btn');
  followBtn.textContent = followSelected ? '📷 following (stop)' : '📷 follow';
  followBtn.classList.toggle('selected', followSelected);
}

// ── Minimap ───────────────────────────────────────────────────────────────────

const minimapCanvas = document.getElementById('minimap');
const minimapCtx = minimapCanvas ? minimapCanvas.getContext('2d') : null;
const miniBuffer = document.createElement('canvas');
miniBuffer.width = MAP_COLS; miniBuffer.height = MAP_ROWS;
const miniBufCtx = miniBuffer.getContext('2d');

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const TILE_RGB = TILE_COLORS.map(hexToRgb);

function drawMinimap() {
  if (!minimapCtx) return;
  const img = miniBufCtx.createImageData(MAP_COLS, MAP_ROWS);
  const data = img.data;
  const grassRgb = hexToRgb(grassPalette()[0]);
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const i = (r * MAP_COLS + c) * 4;
      if (!inLand(r, c)) {
        data[i] = 26; data[i+1] = 38; data[i+2] = 24; data[i+3] = 255;
        continue;
      }
      const t = grid[r][c];
      const rgb = t === GRASS ? grassRgb : (TILE_RGB[t] || TILE_RGB[0]);
      data[i] = rgb[0]; data[i+1] = rgb[1]; data[i+2] = rgb[2]; data[i+3] = 255;
    }
  }
  // Burning tiles pulse red-orange
  for (const key of Object.keys(burningTiles)) {
    const b = burningTiles[key];
    const i = (b.r * MAP_COLS + b.c) * 4;
    data[i] = 255; data[i+1] = 80; data[i+2] = 0;
  }
  // People as white dots
  for (const p of people) {
    if (p.insideBuilding) continue;
    const i = (Math.round(p.y) * MAP_COLS + Math.round(p.x)) * 4;
    data[i] = 255; data[i+1] = 255; data[i+2] = 255;
  }
  miniBufCtx.putImageData(img, 0, 0);
  minimapCtx.imageSmoothingEnabled = false;
  minimapCtx.drawImage(miniBuffer, 0, 0, minimapCanvas.width, minimapCanvas.height);
  // Viewport rectangle
  const sx = minimapCanvas.width  / MAP_COLS;
  const sy = minimapCanvas.height / MAP_ROWS;
  minimapCtx.strokeStyle = '#fff';
  minimapCtx.lineWidth = 1;
  minimapCtx.strokeRect(
    camX * sx, camY * sy,
    (canvas.width / tileSize) * sx, (canvas.height / tileSize) * sy
  );
}

// ── Trend graphs ──────────────────────────────────────────────────────────────

const trendsCanvas = document.getElementById('trends');
const trendsCtx = trendsCanvas ? trendsCanvas.getContext('2d') : null;

function drawSparkline(series, color, label, top, height) {
  const w = trendsCanvas.width, pad = 2;
  const max = Math.max(1, ...series);
  trendsCtx.strokeStyle = color;
  trendsCtx.lineWidth = 1.5;
  trendsCtx.beginPath();
  const n = series.length;
  for (let i = 0; i < n; i++) {
    const x = pad + (i / Math.max(1, HISTORY_MAX - 1)) * (w - pad * 2);
    const y = top + height - pad - (series[i] / max) * (height - pad * 2);
    if (i === 0) trendsCtx.moveTo(x, y);
    else trendsCtx.lineTo(x, y);
  }
  trendsCtx.stroke();
  trendsCtx.font = '9px Monaco,monospace';
  trendsCtx.fillStyle = color;
  const latest = series.length > 0 ? series[series.length - 1] : 0;
  trendsCtx.fillText(label + ' ' + latest, 4, top + 10);
}

function drawTrends() {
  if (!trendsCtx || history.pop.length < 2) return;
  trendsCtx.fillStyle = '#fafafa';
  trendsCtx.fillRect(0, 0, trendsCanvas.width, trendsCanvas.height);
  const rowH = trendsCanvas.height / 4;
  trendsCtx.strokeStyle = '#eee';
  trendsCtx.beginPath();
  trendsCtx.moveTo(0, rowH);     trendsCtx.lineTo(trendsCanvas.width, rowH);
  trendsCtx.moveTo(0, rowH * 2); trendsCtx.lineTo(trendsCanvas.width, rowH * 2);
  trendsCtx.moveTo(0, rowH * 3); trendsCtx.lineTo(trendsCanvas.width, rowH * 3);
  trendsCtx.stroke();
  drawSparkline(history.pop,   '#1e88e5', 'pop',   0,        rowH);
  drawSparkline(history.food,  '#f9a825', 'food',  rowH,     rowH);
  drawSparkline(history.gold,  '#43a047', 'gold',  rowH * 2, rowH);
  drawSparkline(history.souls, '#7e57c2', 'souls', rowH * 3, rowH);
}
