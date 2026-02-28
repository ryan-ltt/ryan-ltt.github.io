const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// Reference tile size all draw functions are authored at
const BASE = 32;

const MAP_COLS = 64;
const MAP_ROWS = 64;

const ZOOM_LEVELS = [8, 12, 16, 24, 32, 48, 64];
const ZOOM_LABELS  = ['25%', '37%', '50%', '75%', '100%', '150%', '200%'];

const GRASS = 0, ROAD = 1, HOUSE = 2, SHOP = 3, PARK = 4, FACTORY = 5, CHURCH = 6, TOWN_HALL = 7;

// Flat colours used for LOD / minimap-like rendering at very small tile sizes
const TILE_COLORS = ['#4caf50', '#a1887f', '#1e88e5', '#ffe082', '#66bb6a', '#616161', '#9c27b0', '#ff6f00'];
const TILE_NAMES  = ['grass', 'path', 'house', 'shop', 'park', 'factory', 'church', 'town hall'];

// Income per second from structures built by the civilization
const TILE_INCOME = { [FACTORY]: 30 };

// ── Simulation constants ───────────────────────────────────────────────────────

const SIM_INTERVAL        = 250;
const BASE_LIFESPAN       = 120;
const LIFESPAN_PER_LEVEL  = 40;
const MAX_LIFESPAN_UPGRADES = 10;
const CARRY_CAP           = 5;
const MAX_PEOPLE          = 80;
const BUILD_COOLDOWN      = 16;
const SPAWN_COST          = 5;    // gold cost to spawn a person
const PERSON_COLORS = ['#e53935','#fb8c00','#43a047','#1e88e5','#8e24aa','#d81b60','#546e7a','#6d4c41'];

const BUILD_COSTS = {
  [ROAD]:      { wood: 1, stone: 0, food: 0 },
  [HOUSE]:     { wood: 5, stone: 0, food: 0 },
  [CHURCH]:    { wood: 2, stone: 4, food: 0 },
  [PARK]:      { wood: 0, stone: 0, food: 0 },
  [FACTORY]:   { wood: 5, stone: 5, food: 2 },
  [TOWN_HALL]: { wood: 0, stone: 0, food: 0 }, // auto-placed, cost handled separately
};

const TOWN_HALL_TRIGGER = { houses: 6, wood: 20, stone: 15 };
const VOTE_THRESHOLD    = 10;

// ── Game state ────────────────────────────────────────────────────────────────

const grid = [];
for (let r = 0; r < MAP_ROWS; r++) grid.push(new Array(MAP_COLS).fill(GRASS));

const resourceMap = [];
for (let r = 0; r < MAP_ROWS; r++) resourceMap.push(new Array(MAP_COLS).fill(null));

let gold         = 5;
let people       = [];
let nextPersonId = 0;
let civilResources  = { wood: 0, stone: 0, food: 0 };
let lifespanLevel   = 0;
let simTick         = 0;
let townHallVotes   = { [CHURCH]: 0, [PARK]: 0, [FACTORY]: 0 };

// ── Discoveries ───────────────────────────────────────────────────────────────

const BUILDING_INFO = {
  [ROAD]:      { name: 'path',      desc: 'Dirt trail. People move faster along paths. Required before most buildings can be placed.' },
  [HOUSE]:     { name: 'house',     desc: 'Shelter. Resources are deposited here. Rarely spawns new people and enables town hall upgrade.' },
  [PARK]:      { name: 'park',      desc: '+5% happiness. Generates food nodes nearby over time.' },
  [FACTORY]:   { name: 'factory',   desc: '+$30 gold/sec. -10% happiness. Requires town hall.' },
  [CHURCH]:    { name: 'church',    desc: 'Place of worship. Requires 2 wood + 4 stone to build.' },
  [TOWN_HALL]: { name: 'town hall', desc: 'Civic centre. People deposit here and vote on new buildings. Unlocks factories.' },
};

// Set of tile types that have been placed at least once
const discovered = new Set();

// Draws a tile type into an arbitrary 2D context by temporarily swapping the global ctx
function drawTileToContext(targetCtx, type, x, y, size) {
  const prev = ctx;
  // eslint-disable-next-line no-global-assign
  ctx = targetCtx;
  targetCtx.save();
  targetCtx.translate(x, y);
  if (size !== BASE) targetCtx.scale(size / BASE, size / BASE);
  switch (type) {
    case ROAD:      drawRoad(0, 0);     break;
    case HOUSE:     drawHouse(0, 0);    break;
    case PARK:      drawPark(0, 0);     break;
    case FACTORY:   drawFactory(0, 0);  break;
    case CHURCH:    drawChurch(0, 0);   break;
    case TOWN_HALL: drawTownHall(0, 0); break;
    default:
      targetCtx.fillStyle = TILE_COLORS[type] || '#ccc';
      targetCtx.fillRect(0, 0, BASE, BASE);
  }
  targetCtx.restore();
  // eslint-disable-next-line no-global-assign
  ctx = prev;
}

function recordDiscovery(type) {
  if (discovered.has(type) || !BUILDING_INFO[type]) return;
  discovered.add(type);
  renderDiscoveries();
}

function renderDiscoveries() {
  const list = document.getElementById('discoveries-list');
  const empty = document.getElementById('discoveries-empty');
  if (discovered.size === 0) {
    if (empty) empty.style.display = '';
    // Remove any existing entries
    for (const el of list.querySelectorAll('.discovery-entry')) el.remove();
    return;
  }
  if (empty) empty.style.display = 'none';

  // Build set of already-rendered types
  const rendered = new Set(
    [...list.querySelectorAll('.discovery-entry')].map(el => parseInt(el.dataset.type))
  );

  for (const type of discovered) {
    if (rendered.has(type)) continue;
    const info = BUILDING_INFO[type];

    // Create off-screen canvas for the icon
    const iconCanvas = document.createElement('canvas');
    iconCanvas.width = 32;
    iconCanvas.height = 32;
    iconCanvas.className = 'discovery-icon';
    const ictx = iconCanvas.getContext('2d');
    ictx.imageSmoothingEnabled = false;
    drawTileToContext(ictx, type, 0, 0, 32);

    const nameEl = document.createElement('div');
    nameEl.className = 'discovery-name';
    nameEl.textContent = info.name;

    const descEl = document.createElement('div');
    descEl.className = 'discovery-desc';
    descEl.textContent = info.desc;

    const textDiv = document.createElement('div');
    textDiv.className = 'discovery-text';
    textDiv.appendChild(nameEl);
    textDiv.appendChild(descEl);

    const entry = document.createElement('div');
    entry.className = 'discovery-entry';
    entry.dataset.type = type;
    entry.appendChild(iconCanvas);
    entry.appendChild(textDiv);
    list.appendChild(entry);
  }
}

// ── Camera & zoom ─────────────────────────────────────────────────────────────

let camX = 0, camY = 0;
let zoomIndex = 4;
let tileSize  = ZOOM_LEVELS[zoomIndex];

// ── Interaction state ─────────────────────────────────────────────────────────

let hoverR = -1, hoverC = -1;
let dragMoved     = false;
let mouseDownX    = 0, mouseDownY    = 0;
let camDragStartX = 0, camDragStartY = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function clampCamera() {
  camX = clamp(camX, 0, Math.max(0, MAP_COLS - canvas.width  / tileSize));
  camY = clamp(camY, 0, Math.max(0, MAP_ROWS - canvas.height / tileSize));
}

function canvasToTile(px, py) {
  return {
    c: Math.floor(camX + px / tileSize),
    r: Math.floor(camY + py / tileSize),
  };
}

function tileToCanvas(r, c) {
  return {
    x: Math.round((c - camX) * tileSize),
    y: Math.round((r - camY) * tileSize),
  };
}

function inBounds(r, c) {
  return r >= 0 && r < MAP_ROWS && c >= 0 && c < MAP_COLS;
}

function getCanvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return {
    px: (e.clientX - rect.left) * (canvas.width  / rect.width),
    py: (e.clientY - rect.top)  * (canvas.height / rect.height),
  };
}

// ── Resource map ──────────────────────────────────────────────────────────────

function initResourceMap() {
  const types = ['wood', 'stone', 'food'];
  const counts = [120, 60, 80];
  const amounts = [[15, 10], [20, 15], [10, 10]]; // [base, spread]
  for (let t = 0; t < 3; t++) {
    for (let i = 0; i < counts[t]; i++) {
      const r = Math.floor(Math.random() * MAP_ROWS);
      const c = Math.floor(Math.random() * MAP_COLS);
      if (!resourceMap[r][c]) {
        resourceMap[r][c] = {
          type: types[t],
          amount: amounts[t][0] + Math.floor(Math.random() * amounts[t][1]),
        };
      }
    }
  }
}

function regenerateResources() {
  const types = ['wood', 'stone', 'food'];
  for (let i = 0; i < 3; i++) {
    const r = Math.floor(Math.random() * MAP_ROWS);
    const c = Math.floor(Math.random() * MAP_COLS);
    if (grid[r][c] === GRASS && !resourceMap[r][c]) {
      resourceMap[r][c] = { type: types[Math.floor(Math.random() * 3)], amount: 5 + Math.floor(Math.random() * 6) };
    }
  }
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (grid[r][c] !== PARK) continue;
      if (Math.random() > 0.4) continue;
      const site = findGrassSiteNear(r, c, 1, 3);
      if (site && !resourceMap[site.r][site.c]) {
        resourceMap[site.r][site.c] = { type: 'food', amount: 5 + Math.floor(Math.random() * 8) };
      }
    }
  }
}

function findGrassSiteNear(r, c, minR, maxR) {
  for (let radius = minR; radius <= maxR; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        if (inBounds(r+dr, c+dc) && grid[r+dr][c+dc] === GRASS)
          return { r: r+dr, c: c+dc };
      }
    }
  }
  return null;
}

// ── People simulation ─────────────────────────────────────────────────────────

function lifespanUpgradeCost() {
  return Math.floor(10 * Math.pow(2, lifespanLevel));
}

function currentMaxAge() {
  return BASE_LIFESPAN + lifespanLevel * LIFESPAN_PER_LEVEL;
}

function spawnPersonFree(r, c) {
  if (!inBounds(r, c) || people.length >= MAX_PEOPLE) return;
  people.push({
    id: nextPersonId++,
    x: c, y: r,
    age: 0,
    maxAge: currentMaxAge(),
    wood: 0, stone: 0, food: 0,
    buildCooldown: Math.floor(Math.random() * BUILD_COOLDOWN),
    color: PERSON_COLORS[nextPersonId % PERSON_COLORS.length],
    mode: 'build',   // 'build' | 'gather'
    homeR: r, homeC: c,
  });
}

function spawnPerson(r, c) {
  if (!inBounds(r, c)) return;
  if (people.length >= MAX_PEOPLE) {
    showMessage('too many people!');
    return;
  }
  if (gold < SPAWN_COST) {
    showMessage('need $' + SPAWN_COST + ' gold to spawn!');
    return;
  }
  gold -= SPAWN_COST;
  spawnPersonFree(r, c);
  updateUI();
}

function agePeople() {
  people = people.filter(p => {
    p.age++;
    if (p.age >= p.maxAge) {
      // Drop carried resources at death site
      const r = Math.round(p.y), c = Math.round(p.x);
      const total = p.wood + p.stone + p.food;
      if (total > 0 && inBounds(r, c) && !resourceMap[r][c]) {
        const dominant = p.wood >= p.stone && p.wood >= p.food ? 'wood'
                       : p.stone >= p.food ? 'stone' : 'food';
        resourceMap[r][c] = { type: dominant, amount: total };
      }
      gold += 5;
      return false;
    }
    return true;
  });
}

function updatePersonMode(p) {
  const carried = p.wood + p.stone + p.food;
  const r = Math.round(p.y), c = Math.round(p.x);

  if (p.mode === 'build') {
    // Switch to gather when empty and no nearby resource within 3 tiles
    let nearbyRes = false;
    for (let dr = -3; dr <= 3 && !nearbyRes; dr++)
      for (let dc = -3; dc <= 3 && !nearbyRes; dc++)
        if (inBounds(r+dr, c+dc) && resourceMap[r+dr][c+dc]) nearbyRes = true;
    if (!nearbyRes) p.mode = 'gather';
  } else {
    // Switch back to build when full, or when returning home and empty
    if (carried >= CARRY_CAP) p.mode = 'build';
    if (carried === 0 && Math.abs(r - p.homeR) + Math.abs(c - p.homeC) < 4) p.mode = 'build';
  }
}

function movePerson(p) {
  const dirs = [
    { dr: -1, dc:  0 },
    { dr:  1, dc:  0 },
    { dr:  0, dc: -1 },
    { dr:  0, dc:  1 },
  ];

  const carried = p.wood + p.stone + p.food;
  updatePersonMode(p);

  const weights = dirs.map(d => {
    const nr = Math.round(p.y) + d.dr;
    const nc = Math.round(p.x) + d.dc;
    if (!inBounds(nr, nc)) return 0;

    const t = grid[nr][nc];
    const res = resourceMap[nr][nc];
    let w = 1.0;

    if (p.mode === 'build') {
      // Stay near settlement: strongly prefer roads and buildings
      if (t === ROAD) w *= 4.0;
      if (t !== GRASS && t !== ROAD) w *= 2.0;
      // Avoid wandering far from home
      const distAfter = Math.abs(nr - p.homeR) + Math.abs(nc - p.homeC);
      if (distAfter > 12) w *= 0.1;
      // Gather nearby resources of opportunity
      if (res && res.amount > 0 && carried < CARRY_CAP) w *= 2.0;
      // Deposit when full
      if ((t === HOUSE || t === TOWN_HALL) && carried >= CARRY_CAP) w *= 5.0;

    } else {
      // Gather mode: head away from home toward resources, avoid roads (already settled)
      const distAfter = Math.abs(nr - p.homeR) + Math.abs(nc - p.homeC);
      // Bias away from home while empty
      if (carried === 0) w *= 1.0 + distAfter * 0.08;
      // Strongly seek resources
      if (res && res.amount > 0 && carried < CARRY_CAP) w *= 6.0;
      // Roads are fine to traverse but not a draw
      if (t === ROAD) w *= 1.2;
      // When carrying, head back toward home
      if (carried > 0) {
        const distBefore = Math.abs(Math.round(p.y) - p.homeR) + Math.abs(Math.round(p.x) - p.homeC);
        if (distAfter < distBefore) w *= 4.0;
        // Deposit at house/town hall
        if ((t === HOUSE || t === TOWN_HALL) && carried >= CARRY_CAP) w *= 6.0;
      }
    }

    return w;
  });

  const total = weights.reduce((a, b) => a + b, 0);
  if (total === 0) return;

  let rand = Math.random() * total;
  let chosen = dirs[0];
  for (let i = 0; i < dirs.length; i++) {
    rand -= weights[i];
    if (rand <= 0) { chosen = dirs[i]; break; }
  }

  const nr = Math.round(p.y) + chosen.dr;
  const nc = Math.round(p.x) + chosen.dc;
  if (inBounds(nr, nc)) {
    p.y = nr;
    p.x = nc;
    // Update home anchor when person is near a house or town hall
    const t = grid[nr][nc];
    if (t === HOUSE || t === TOWN_HALL) {
      p.homeR = nr;
      p.homeC = nc;
    }
  }
}

function movePeople() {
  for (const p of people) movePerson(p);
}

function gatherResources() {
  for (const p of people) {
    const r = Math.round(p.y), c = Math.round(p.x);
    const res = resourceMap[r][c];
    const carried = p.wood + p.stone + p.food;
    if (res && res.amount > 0 && carried < CARRY_CAP) {
      res.amount--;
      p[res.type]++;
      gold++;
      if (res.amount <= 0) resourceMap[r][c] = null;
    }
  }
}

function depositResources() {
  for (const p of people) {
    const r = Math.round(p.y), c = Math.round(p.x);
    const carried = p.wood + p.stone + p.food;
    if (carried === 0) continue;
    if (grid[r][c] === HOUSE || grid[r][c] === TOWN_HALL) {
      civilResources.wood  += p.wood;
      civilResources.stone += p.stone;
      civilResources.food  += p.food;
      p.wood = 0; p.stone = 0; p.food = 0;
      if (grid[r][c] === TOWN_HALL) castVote(r, c);
    }
  }
}

function chooseBuildType(r, c) {
  let localHouses = 0, localPaths = 0, localTownHalls = 0;
  let localParks = 0, localFactories = 0, localChurches = 0;
  for (let dr = -5; dr <= 5; dr++) {
    for (let dc = -5; dc <= 5; dc++) {
      if (!inBounds(r+dr, c+dc)) continue;
      const t = grid[r+dr][c+dc];
      if (t === HOUSE)     localHouses++;
      if (t === ROAD)      localPaths++;
      if (t === TOWN_HALL) localTownHalls++;
      if (t === PARK)      localParks++;
      if (t === FACTORY)   localFactories++;
      if (t === CHURCH)    localChurches++;
    }
  }

  // No house nearby — founding: build a house first
  if (localHouses === 0) return HOUSE;

  // Cardinal-only adjacency scan (N/S/E/W only)
  let cardinalPaths = 0, cardinalBuildings = 0;
  const N = inBounds(r-1,c) && grid[r-1][c] === ROAD;
  const S = inBounds(r+1,c) && grid[r+1][c] === ROAD;
  const W = inBounds(r,c-1) && grid[r][c-1] === ROAD;
  const E = inBounds(r,c+1) && grid[r][c+1] === ROAD;
  cardinalPaths = (N?1:0) + (S?1:0) + (W?1:0) + (E?1:0);
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const [dr, dc] of cardinals) {
    if (!inBounds(r+dr, c+dc)) continue;
    const t = grid[r+dr][c+dc];
    if (t !== ROAD && t !== GRASS) cardinalBuildings++;
  }

  // Straight-line bonus: continuing an existing axis scores much higher than branching
  const continuesNS = (N && S);
  const continuesEW = (E && W);
  const continuesStraight = continuesNS || continuesEW;
  // Branching penalty: 3+ cardinal path neighbours means we'd create a junction
  const branchPenalty = cardinalPaths >= 3 ? 0.15 : (cardinalPaths === 2 && !continuesStraight ? 0.35 : 1.0);

  // 8-neighbour path density — penalise when immediate area is already crowded
  let neighbourPaths = 0;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      if (inBounds(r+dr, c+dc) && grid[r+dr][c+dc] === ROAD) neighbourPaths++;
    }
  const overCrowded = Math.max(0, neighbourPaths - 2);
  const crowdPenalty = Math.pow(0.5, overCrowded);

  // 5×5 path saturation — the more paths already in the local area, the less we want more
  // localPaths is counted in the 11×11 scan above; rescale to a 5×5 equivalent (~25 tiles)
  // Treat >8 local paths as saturated; each path beyond that halves the weight again
  const pathSaturation = Math.max(0, localPaths - 8);
  const saturationPenalty = Math.pow(0.6, pathSaturation);

  // Paths only allowed adjacent to another path or a building
  const basePathWeight = continuesStraight ? 100
                       : cardinalPaths > 0 ? 50
                       : cardinalBuildings > 0 ? 20
                       : 0;
  const pathWeight = Math.round(basePathWeight * branchPenalty * crowdPenalty * saturationPenalty);

  // Houses: strong early on, fall off as local density grows; require path adjacency
  const houseWeight = cardinalPaths > 0
    ? Math.max(0, 40 - localHouses * 8)
    : 0;

  const weights = { [ROAD]: pathWeight, [HOUSE]: houseWeight };

  // Churches and parks available once there are a few local houses (no town hall required)
  if (cardinalPaths > 0 && localHouses >= 2) {
    weights[CHURCH]  = localChurches === 0 ? 30 : Math.max(2, 30 - localChurches * 10);
    weights[PARK]    = localParks === 0 ? 25 : Math.max(2, 25 - localParks * 8);
  }

  // Factories and boosted premium buildings only after a local town hall
  if (localTownHalls > 0 && cardinalPaths > 0) {
    weights[CHURCH]  = localChurches === 0 ? 35 : Math.max(2, 35 - localChurches * 10);
    weights[PARK]    = Math.max(2, 30 - localParks * 8);
    weights[FACTORY] = localHouses >= 5 && localFactories < 3 ? 25 : 3;
  }

  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let rand = Math.random() * total;
  for (const [type, w] of Object.entries(weights)) {
    rand -= w;
    if (rand <= 0) return parseInt(type);
  }
  return null;
}

function canAffordBuild(type) {
  const cost = BUILD_COSTS[type];
  return civilResources.wood  >= cost.wood
      && civilResources.stone >= cost.stone
      && civilResources.food  >= cost.food;
}

function spendBuildCost(type) {
  const cost = BUILD_COSTS[type];
  civilResources.wood  -= cost.wood;
  civilResources.stone -= cost.stone;
  civilResources.food  -= cost.food;
}

function tryBuild(p) {
  if (p.buildCooldown > 0) { p.buildCooldown--; return; }

  const r = Math.round(p.y), c = Math.round(p.x);
  if (grid[r][c] !== GRASS) return;

  const chosen = chooseBuildType(r, c);
  if (chosen === null || !canAffordBuild(chosen)) return;

  spendBuildCost(chosen);
  grid[r][c] = chosen;
  recordDiscovery(chosen);
  p.buildCooldown = BUILD_COOLDOWN;
}

function buildFromPeople() {
  for (const p of people) tryBuild(p);
}

function tryBuildTownHall() {
  for (let r = 5; r < MAP_ROWS-5; r += 3) {
    for (let c = 5; c < MAP_COLS-5; c += 3) {
      if (grid[r][c] !== HOUSE) continue;
      let localHouses = 0, localTownHalls = 0;
      for (let dr = -5; dr <= 5; dr++)
        for (let dc = -5; dc <= 5; dc++) {
          if (!inBounds(r+dr, c+dc)) continue;
          if (grid[r+dr][c+dc] === HOUSE)     localHouses++;
          if (grid[r+dr][c+dc] === TOWN_HALL) localTownHalls++;
        }
      if (localHouses >= TOWN_HALL_TRIGGER.houses && localTownHalls === 0) {
        if (civilResources.wood  >= TOWN_HALL_TRIGGER.wood &&
            civilResources.stone >= TOWN_HALL_TRIGGER.stone) {
          civilResources.wood  -= TOWN_HALL_TRIGGER.wood;
          civilResources.stone -= TOWN_HALL_TRIGGER.stone;
          grid[r][c] = TOWN_HALL;
          recordDiscovery(TOWN_HALL);
          showMessage('a town hall rises!');
          updateUI();
          return;
        }
      }
    }
  }
}

function castVote(thR, thC) {
  let localChurches = 0, localParks = 0, localFactories = 0, localHouses = 0;
  for (let dr = -5; dr <= 5; dr++)
    for (let dc = -5; dc <= 5; dc++) {
      if (!inBounds(thR+dr, thC+dc)) continue;
      const t = grid[thR+dr][thC+dc];
      if (t === CHURCH)  localChurches++;
      if (t === PARK)    localParks++;
      if (t === FACTORY) localFactories++;
      if (t === HOUSE)   localHouses++;
    }
  const w = {
    [CHURCH]:  localChurches === 0 ? 40 : Math.max(3, 40 - localChurches * 12),
    [PARK]:    Math.max(3, 30 - localParks * 8),
    [FACTORY]: localHouses >= 8 && localFactories < 3 ? 30 : 4,
  };
  const total = Object.values(w).reduce((a, b) => a + b, 0);
  let rand = Math.random() * total;
  for (const [type, weight] of Object.entries(w)) {
    rand -= weight;
    if (rand <= 0) {
      townHallVotes[parseInt(type)]++;
      checkVoteThreshold(thR, thC);
      return;
    }
  }
}

function checkVoteThreshold(thR, thC) {
  for (const type of [CHURCH, PARK, FACTORY]) {
    if (townHallVotes[type] >= VOTE_THRESHOLD) {
      if (canAffordBuild(type)) {
        const site = findGrassSiteNear(thR, thC, 2, 12);
        if (site) {
          spendBuildCost(type);
          grid[site.r][site.c] = type;
          recordDiscovery(type);
          townHallVotes[type] = 0;
          showMessage(TILE_NAMES[type] + ' built by popular vote!');
          updateUI();
        }
      } else {
        townHallVotes[type] = 0;
      }
    }
  }
}

function upgradeLifespan() {
  if (lifespanLevel >= MAX_LIFESPAN_UPGRADES) {
    showMessage('max lifespan reached!');
    return;
  }
  const cost = lifespanUpgradeCost();
  if (civilResources.food < cost) {
    showMessage('need ' + cost + ' food!');
    return;
  }
  civilResources.food -= cost;
  lifespanLevel++;
  const newMax = currentMaxAge();
  for (const p of people) p.maxAge = newMax;
  updateUI();
  showMessage('lifespan increased to ' + newMax + ' ticks!');
}

function houseSpawnPeople() {
  if (people.length >= MAX_PEOPLE) return;
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (grid[r][c] !== HOUSE) continue;
      if (Math.random() > 0.003) continue; // ~0.3% chance per house per tick
      const site = findGrassSiteNear(r, c, 1, 2);
      if (site) spawnPersonFree(site.r, site.c);
      if (people.length >= MAX_PEOPLE) return;
    }
  }
}

// ── Simulation tick ───────────────────────────────────────────────────────────

function simulationTick() {
  simTick++;
  agePeople();
  movePeople();
  gatherResources();
  depositResources();
  buildFromPeople();
  houseSpawnPeople();
  if (simTick % 40  === 0) tryBuildTownHall();
  if (simTick % 100 === 0) regenerateResources();
  updateUI();
  render();
}

setInterval(simulationTick, SIM_INTERVAL);

// ── UI ────────────────────────────────────────────────────────────────────────

function updateUI() {
  document.getElementById('gold').textContent = '$' + Math.floor(gold);

  const day = Math.floor(simTick / 16) + 1;
  document.getElementById('sim-day').textContent = day;

  let buildings = 0, parks = 0, factories = 0;
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      if (grid[r][c] !== GRASS) buildings++;
      if (grid[r][c] === PARK)    parks++;
      if (grid[r][c] === FACTORY) factories++;
    }
  }
  document.getElementById('stat-buildings').textContent = buildings;

  const happy = clamp(100 + parks * 5 - factories * 10, 0, 100);
  const hapEl = document.getElementById('happiness');
  hapEl.textContent = happy + '%';
  hapEl.className = 'value ' + (happy >= 70 ? 'pos' : happy >= 40 ? '' : 'neg');

  document.getElementById('people-count').textContent = people.length + ' / ' + MAX_PEOPLE;
  document.getElementById('lifespan-val').textContent = currentMaxAge() + 't';

  document.getElementById('res-wood').textContent  = civilResources.wood;
  document.getElementById('res-stone').textContent = civilResources.stone;
  document.getElementById('res-food').textContent  = civilResources.food;

  const upgCost = lifespanUpgradeCost();
  const upgBtn = document.getElementById('upgrade-btn');
  if (lifespanLevel >= MAX_LIFESPAN_UPGRADES) {
    upgBtn.textContent = 'lifespan maxed';
    upgBtn.disabled = true;
  } else {
    upgBtn.textContent = 'upgrade lifespan (' + upgCost + ' food)';
    upgBtn.disabled = civilResources.food < upgCost;
  }

  const spawnBtn = document.getElementById('spawn-btn');
  spawnBtn.textContent = 'spawn person ($' + SPAWN_COST + ' gold)';
  spawnBtn.disabled = gold < SPAWN_COST || people.length >= MAX_PEOPLE;

  document.getElementById('zoom-label').textContent = ZOOM_LABELS[zoomIndex];
  const centerC = Math.floor(camX + (canvas.width  / tileSize) / 2);
  const centerR = Math.floor(camY + (canvas.height / tileSize) / 2);
  document.getElementById('cam-pos').textContent = centerC + ', ' + centerR;

  let hasTownHall = false;
  outer: for (let r = 0; r < MAP_ROWS; r++)
    for (let c = 0; c < MAP_COLS; c++)
      if (grid[r][c] === TOWN_HALL) { hasTownHall = true; break outer; }
  document.getElementById('votes-panel').style.display = hasTownHall ? '' : 'none';
  document.getElementById('votes-church').textContent  = townHallVotes[CHURCH]  + ' / ' + VOTE_THRESHOLD;
  document.getElementById('votes-park').textContent    = townHallVotes[PARK]    + ' / ' + VOTE_THRESHOLD;
  document.getElementById('votes-factory').textContent = townHallVotes[FACTORY] + ' / ' + VOTE_THRESHOLD;
}

// ── Pixel-art draw functions (all authored at 32×32, origin at top-left) ──────

function drawGrass(x, y) {
  ctx.fillStyle = '#4caf50'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#66bb6a';
  ctx.fillRect(x+4,  y+6,  4, 4);
  ctx.fillRect(x+20, y+14, 4, 4);
  ctx.fillRect(x+10, y+22, 4, 4);
  ctx.fillStyle = '#388e3c';
  ctx.fillRect(x+14, y+4,  2, 2);
  ctx.fillRect(x+26, y+18, 2, 2);
  ctx.fillRect(x+6,  y+27, 2, 2);
}

function drawRoad(x, y) {
  ctx.fillStyle = '#a1887f'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#bcaaa4';
  ctx.fillRect(x+2,  y+4,  6, 4);
  ctx.fillRect(x+18, y+16, 6, 4);
  ctx.fillRect(x+8,  y+24, 5, 3);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+12, y+6,  2, 2);
  ctx.fillRect(x+5,  y+18, 2, 2);
  ctx.fillRect(x+22, y+10, 2, 2);
  ctx.fillRect(x+16, y+26, 2, 2);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x,         y,         BASE, 2);
  ctx.fillRect(x,         y+BASE-2,  BASE, 2);
  ctx.fillRect(x,         y,         2,    BASE);
  ctx.fillRect(x+BASE-2,  y,         2,    BASE);
}

function drawHouse(x, y) {
  ctx.fillStyle = '#1e88e5'; ctx.fillRect(x+2, y+16, 28, 14);
  ctx.fillStyle = '#c62828';
  ctx.fillRect(x+14, y+4,  4,  2);
  ctx.fillRect(x+10, y+6,  12, 2);
  ctx.fillRect(x+6,  y+8,  20, 2);
  ctx.fillRect(x+4,  y+10, 24, 2);
  ctx.fillRect(x+2,  y+12, 28, 4);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 8, 6);
  ctx.fillRect(x+20, y+18, 8, 6);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+18, 2, 6);
  ctx.fillRect(x+23, y+18, 2, 6);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+12, y+22, 8, 8);
}

function drawShop(x, y) {
  ctx.fillStyle = '#ef6c00'; ctx.fillRect(x+2, y+4,  28, 10);
  ctx.fillStyle = '#e65100'; ctx.fillRect(x+2, y+2,  28, 4);
  ctx.fillStyle = '#ffffff'; ctx.fillRect(x+6, y+6,  20, 6);
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+13, y+7, 6, 2);
  ctx.fillRect(x+13, y+9, 6, 2);
  ctx.fillRect(x+15, y+6, 2, 6);
  ctx.fillStyle = '#2e7d32'; ctx.fillRect(x+2,  y+13, 28, 4);
  ctx.fillStyle = '#ffe082'; ctx.fillRect(x+2,  y+16, 28, 14);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 6, 6);
  ctx.fillRect(x+22, y+18, 6, 6);
  ctx.fillStyle = '#4e342e'; ctx.fillRect(x+12, y+22, 8, 8);
}

function drawPark(x, y) {
  ctx.fillStyle = '#66bb6a'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+2,  y+2,  10, 10);
  ctx.fillRect(x+20, y+2,  10, 10);
  ctx.fillRect(x+2,  y+20, 10, 10);
  ctx.fillRect(x+20, y+20, 10, 10);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+6,  y+11, 2, 4);
  ctx.fillRect(x+24, y+11, 2, 4);
  ctx.fillRect(x+6,  y+29, 2, 4);
  ctx.fillRect(x+24, y+29, 2, 4);
  ctx.fillStyle = '#f44336'; ctx.fillRect(x+13, y+13, 6, 6);
  ctx.fillStyle = '#ffee58'; ctx.fillRect(x+15, y+15, 2, 2);
}

function drawFactory(x, y) {
  ctx.fillStyle = '#616161'; ctx.fillRect(x+2, y+14, 28, 16);
  ctx.fillStyle = '#424242';
  ctx.fillRect(x+4,  y+4, 8, 12);
  ctx.fillRect(x+20, y+8, 8, 8);
  ctx.fillStyle = '#b0bec5';
  ctx.fillRect(x+4,  y+2, 8, 4);
  ctx.fillRect(x+20, y+6, 8, 4);
  ctx.fillStyle = '#cfd8dc';
  ctx.fillRect(x+6,  y,   4, 4);
  ctx.fillRect(x+22, y+4, 4, 4);
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+4,  y+18, 4, 4);
  ctx.fillRect(x+14, y+18, 4, 4);
  ctx.fillRect(x+24, y+18, 4, 4);
  ctx.fillStyle = '#212121'; ctx.fillRect(x+12, y+24, 8, 6);
}

function drawChurch(x, y) {
  ctx.fillStyle = '#e8e0d0'; ctx.fillRect(x+4, y+16, 24, 14);
  ctx.fillStyle = '#d5ccc0'; ctx.fillRect(x+12, y+8, 8, 10);
  ctx.fillStyle = '#b0a090';
  ctx.fillRect(x+14, y+4, 4, 2);
  ctx.fillRect(x+13, y+6, 6, 2);
  ctx.fillRect(x+12, y+8, 8, 2);
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+15, y+4, 2, 6);
  ctx.fillRect(x+13, y+6, 6, 2);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+13, y+22, 6, 8);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+18, 4, 4);
  ctx.fillRect(x+23, y+18, 4, 4);
  ctx.fillStyle = '#7b1fa2'; ctx.fillRect(x+4, y+15, 24, 2);
}

function drawTownHall(x, y) {
  ctx.fillStyle = '#d7ccc8'; ctx.fillRect(x+1, y+14, 30, 16);
  ctx.fillStyle = '#bcaaa4'; ctx.fillRect(x+10, y+8, 12, 8);
  ctx.fillStyle = '#ff6f00';
  ctx.fillRect(x+15, y+2, 2, 2);
  ctx.fillRect(x+13, y+4, 6, 2);
  ctx.fillRect(x+11, y+6, 10, 2);
  ctx.fillStyle = '#ff6f00'; ctx.fillRect(x+15, y+2, 6, 4);
  ctx.fillStyle = '#fff';    ctx.fillRect(x+16, y+3, 2, 2);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+12, y+10, 3, 4);
  ctx.fillRect(x+21, y+10, 3, 4);
  ctx.fillStyle = '#efebe9';
  ctx.fillRect(x+3,  y+14, 3, 16);
  ctx.fillRect(x+26, y+14, 3, 16);
  ctx.fillStyle = '#5d4037'; ctx.fillRect(x+13, y+22, 6, 8);
  ctx.fillStyle = '#795548'; ctx.fillRect(x+14, y+20, 4, 4);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+17, 5, 5);
  ctx.fillRect(x+22, y+17, 5, 5);
  ctx.fillStyle = '#ff6f00'; ctx.fillRect(x+1, y+13, 30, 2);
}

// ── Tile & entity renderers ────────────────────────────────────────────────────

function drawTile(r, c, x, y, ts) {
  if (ts <= 12) {
    ctx.fillStyle = TILE_COLORS[grid[r][c]] || TILE_COLORS[0];
    ctx.fillRect(x, y, ts, ts);
  } else {
    ctx.save();
    ctx.translate(x, y);
    if (ts !== BASE) ctx.scale(ts / BASE, ts / BASE);
    switch (grid[r][c]) {
      case GRASS:     drawGrass(0, 0);    break;
      case ROAD:      drawRoad(0, 0);     break;
      case HOUSE:     drawHouse(0, 0);    break;
      case SHOP:      drawShop(0, 0);     break;
      case PARK:      drawPark(0, 0);     break;
      case FACTORY:   drawFactory(0, 0);  break;
      case CHURCH:    drawChurch(0, 0);   break;
      case TOWN_HALL: drawTownHall(0, 0); break;
    }
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(0,0,0,0.15)';
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1);
}

function drawResourceNodes() {
  const startC = Math.floor(camX), startR = Math.floor(camY);
  const endC   = Math.ceil(camX + canvas.width  / tileSize);
  const endR   = Math.ceil(camY + canvas.height / tileSize);

  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      if (!inBounds(r, c)) continue;
      const res = resourceMap[r][c];
      if (!res) continue;
      const { x, y } = tileToCanvas(r, c);
      const iconS = Math.max(3, Math.floor(tileSize * 0.25));
      const iconX = x + tileSize - iconS - 1;
      const iconY = y + tileSize - iconS - 1;
      ctx.fillStyle = res.type === 'wood'  ? '#2e7d32'
                    : res.type === 'stone' ? '#78909c'
                    : '#f9a825';
      ctx.fillRect(iconX, iconY, iconS, iconS);
    }
  }
}

function drawPeople() {
  for (const p of people) {
    const { x: px, y: py } = tileToCanvas(p.y, p.x);
    if (px < -tileSize || px > canvas.width  + tileSize) continue;
    if (py < -tileSize || py > canvas.height + tileSize) continue;

    const carried = p.wood + p.stone + p.food;

    if (tileSize <= 12) {
      // Tiny dot: cyan = gather mode, player colour = build mode, yellow = carrying
      ctx.fillStyle = carried > 0 ? '#ffee58' : (p.mode === 'gather' ? '#4dd0e1' : p.color);
      ctx.fillRect(px + Math.floor(tileSize / 2) - 1, py + Math.floor(tileSize / 2) - 1, 2, 2);
    } else {
      const s = tileSize / BASE; // scale factor

      // Anchor sprite in lower-centre of tile
      const cx = px + Math.floor(tileSize / 2);
      const bot = py + Math.floor(tileSize * 0.88);

      // pixel helpers
      const px_ = (ox, oy, w, h) => ctx.fillRect(
        Math.round(cx + ox * s), Math.round(bot + oy * s),
        Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s))
      );

      // Legs (two pixels wide each, animated by age parity)
      const legSwing = (p.age % 4 < 2) ? 1 : -1;
      ctx.fillStyle = '#5d4037';
      px_(-3,  -5 - legSwing,  2, 3);  // left leg
      px_( 1,  -5 + legSwing,  2, 3);  // right leg

      // Body / shirt in player colour
      ctx.fillStyle = p.color;
      px_(-4, -13, 8, 8);

      // Arms
      ctx.fillStyle = p.color;
      px_(-6, -12 + legSwing,  2, 4); // left arm
      px_( 4, -12 - legSwing,  2, 4); // right arm

      // Head (skin tone)
      ctx.fillStyle = '#ffcc80';
      px_(-3, -19, 6, 6);

      // Eyes
      ctx.fillStyle = '#333';
      px_(-2, -17, 1, 1);
      px_( 1, -17, 1, 1);

      // Mode indicator above head
      if (p.mode === 'gather') {
        // Cyan arrow pointing away from home (outward)
        ctx.fillStyle = '#4dd0e1';
        px_(-1, -23, 2, 3); // arrow shaft
        px_(-2, -24, 4, 1); // arrow head
      } else {
        // Orange hammer icon (build mode)
        ctx.fillStyle = '#ff8f00';
        px_(-1, -23, 1, 3); // handle
        px_(-2, -25, 3, 2); // hammerhead
      }

      // Carried-resource pack (shown on back, above body)
      if (carried > 0) {
        const packColor = p.wood >= p.stone && p.wood >= p.food ? '#2e7d32'
                        : p.stone >= p.food                     ? '#78909c'
                        : '#f9a825';
        // Pack strapped to back (top-right of body)
        ctx.fillStyle = packColor;
        px_(3, -14, 4, 5);
        // Small highlight on pack
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        px_(3, -14, 2, 2);
        // Fullness indicator: outline turns white when at carry cap
        if (carried >= CARRY_CAP) {
          ctx.strokeStyle = '#fff';
          ctx.lineWidth = Math.max(1, Math.round(s));
          ctx.strokeRect(
            Math.round(cx + 3 * s), Math.round(bot - 14 * s),
            Math.max(1, Math.round(4 * s)), Math.max(1, Math.round(5 * s))
          );
        }
      }
    }
  }
}

function render() {
  ctx.fillStyle = '#1a2633';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const startC = Math.floor(camX), startR = Math.floor(camY);
  const endC   = Math.ceil(camX + canvas.width  / tileSize);
  const endR   = Math.ceil(camY + canvas.height / tileSize);

  for (let r = startR; r <= endR; r++) {
    for (let c = startC; c <= endC; c++) {
      if (!inBounds(r, c)) continue;
      const { x, y } = tileToCanvas(r, c);
      drawTile(r, c, x, y, tileSize);
    }
  }

  if (inBounds(hoverR, hoverC)) {
    const { x, y } = tileToCanvas(hoverR, hoverC);
    ctx.fillStyle = 'rgba(255,255,255,0.3)';
    ctx.fillRect(x, y, tileSize, tileSize);
  }

  drawResourceNodes();
  drawPeople();
}

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

// ── Input ─────────────────────────────────────────────────────────────────────

canvas.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  dragMoved     = false;
  mouseDownX    = e.clientX;
  mouseDownY    = e.clientY;
  camDragStartX = camX;
  camDragStartY = camY;
});

canvas.addEventListener('mousemove', (e) => {
  const { px, py } = getCanvasPos(e);

  if (e.buttons === 1) {
    const dx = e.clientX - mouseDownX;
    const dy = e.clientY - mouseDownY;

    if (!dragMoved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      dragMoved = true;
      canvas.style.cursor = 'grabbing';
    }

    if (dragMoved) {
      camX = camDragStartX - dx / tileSize;
      camY = camDragStartY - dy / tileSize;
      clampCamera();
      const { r, c } = canvasToTile(px, py);
      hoverR = r; hoverC = c;
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
  canvas.style.cursor = 'crosshair';
});

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

  spawnPerson(r, c);
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

document.getElementById('spawn-btn').addEventListener('click', () => {
  showMessage('click the map to spawn a person');
});

document.getElementById('upgrade-btn').addEventListener('click', () => {
  upgradeLifespan();
});

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;

  let dx = 0, dy = 0;
  switch (e.key) {
    case 'ArrowLeft':  case 'a': dx = -3; break;
    case 'ArrowRight': case 'd': dx =  3; break;
    case 'ArrowUp':    case 'w': dy = -3; break;
    case 'ArrowDown':  case 's': dy =  3; break;
    case '+': case '=': applyZoom(zoomIndex + 1, canvas.width/2, canvas.height/2); e.preventDefault(); return;
    case '-':           applyZoom(zoomIndex - 1, canvas.width/2, canvas.height/2); e.preventDefault(); return;
    default: return;
  }

  e.preventDefault();
  camX = clamp(camX + dx, 0, Math.max(0, MAP_COLS - canvas.width  / tileSize));
  camY = clamp(camY + dy, 0, Math.max(0, MAP_ROWS - canvas.height / tileSize));
  render();
  updateUI();
});

// ── Messages ──────────────────────────────────────────────────────────────────

function showMessage(msg) {
  const el = document.getElementById('message');
  el.textContent = msg;
  el.style.color = '#c62828';
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

function showHoverInfo(r, c) {
  const el = document.getElementById('message');
  clearTimeout(el._t);
  const name = TILE_NAMES[grid[r][c]] || 'unknown';
  const res = resourceMap[r][c];
  el.textContent = name + (res ? ' [' + res.type + ' ×' + res.amount + ']' : '');
  el.style.opacity = '1';
  el.style.color = '#333';
}

function clearHoverInfo() {
  const el = document.getElementById('message');
  clearTimeout(el._t);
  el.style.opacity = '0';
  el.style.color = '#c62828';
}

// ── Income tick ───────────────────────────────────────────────────────────────

setInterval(() => {
  let income = 0;
  for (let r = 0; r < MAP_ROWS; r++)
    for (let c = 0; c < MAP_COLS; c++)
      income += TILE_INCOME[grid[r][c]] || 0;
  if (income !== 0) {
    gold = Math.max(0, gold + income);
    updateUI();
  }
}, 1000);

// ── Init ──────────────────────────────────────────────────────────────────────

clampCamera();
initResourceMap();

civilResources.wood = 10;
civilResources.food = 100;

render();
updateUI();
