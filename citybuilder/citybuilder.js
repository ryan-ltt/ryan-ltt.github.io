const canvas = document.getElementById('gameCanvas');
let ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// Reference tile size all draw functions are authored at
const BASE = 32;

const MAP_COLS = 100;
const MAP_ROWS = 100;

const ZOOM_LEVELS = [8, 12, 16, 24, 32, 48, 64];
const ZOOM_LABELS  = ['25%', '37%', '50%', '75%', '100%', '150%', '200%'];

const GRASS = 0, ROAD = 1, HOUSE = 2, SHOP = 3, PARK = 4, FACTORY = 5, CHURCH = 6, TOWN_HALL = 7, TREE_FARM = 8, STONE_FARM = 9, FARM = 10, ROW_HOUSE = 11, APARTMENT = 12, WELL = 13, SCHOOL = 14;

// Flat colours used for LOD / minimap-like rendering at very small tile sizes
const TILE_COLORS = ['#4caf50', '#a1887f', '#1e88e5', '#ffe082', '#66bb6a', '#616161', '#9c27b0', '#ff6f00', '#388e3c', '#78909c', '#f9a825', '#e57373', '#7e57c2', '#4fc3f7', '#ff8a65'];
const TILE_NAMES  = ['grass', 'path', 'house', 'market', 'park', 'factory', 'church', 'town hall', 'tree farm', 'stone farm', 'farm', 'row house', 'apartment', 'well', 'school'];

// Income per second from structures built by the civilization
const TILE_INCOME = { [FACTORY]: 30 };

// Every resource kind that can appear on the map, be carried, and be stockpiled
const RES_KINDS  = ['wood', 'stone', 'food', 'clay', 'ore'];
const RES_COLORS = { wood: '#2e7d32', stone: '#78909c', food: '#f9a825', clay: '#d84315', ore: '#5c6bc0' };

// ── Simulation constants ───────────────────────────────────────────────────────

const SIM_INTERVAL        = 250;
const BASE_LIFESPAN       = 10 * 96;  // 10 days
const LIFESPAN_PER_LEVEL  = 96;        // 1 day per upgrade
const MAX_LIFESPAN_UPGRADES = 90;      // max 100 days
const CARRY_CAP           = 5;    // base — each personal level adds +1
const MAX_PEOPLE          = 1000;
const TH_BUILD_INTERVAL   = 12; // ticks between each TH autonomous build attempt
const SPAWN_COST          = 1;    // souls to spawn a person
const PERSON_COLORS = ['#e53935','#fb8c00','#43a047','#1e88e5','#8e24aa','#d81b60','#546e7a','#6d4c41'];

// ── Souls economy ─────────────────────────────────────────────────────────────
// Death is the harvest: a citizen releases souls scaled by their level and the
// happiness of their town. Souls buy new people and the four soul upgrades.
const STONE_LEVEL        = 1;   // personal level needed to carry stone
const ORE_LEVEL          = 2;   // personal level needed to carry ore
const FACTORY_LEVEL      = 2;   // personal level needed to work a factory
const MAX_PERSON_LEVEL   = 9;
const CHURCH_SOUL_MULT   = 1.5; // dying near a church releases more souls
const SCHOOL_XP_MULT     = 1.5; // learning near a school is faster

const MAX_SPEED_UPGRADES = 8;   // each level: +10% chance of a second step per tick
const MAX_SIGHT_UPGRADES = 8;   // each level: +3 tiles of resource-search radius
const BASE_SIGHT_RADIUS  = 10;

// ── Land ──────────────────────────────────────────────────────────────────────
// The known world starts as a small square in the map centre and is expanded
// with souls. Everything outside is impassable wilderness.
const LAND_CENTER    = 50;
const LAND_BASE_HALF = 12;  // half-size of the starting square (24×24)
const LAND_STEP      = 6;   // half-size added per land level
const MAX_LAND_LEVEL = 7;   // level 7 covers the whole 100×100 map

function landHalf(level) { return Math.min(50, LAND_BASE_HALF + level * LAND_STEP); }

function inLand(r, c) {
  const h = landHalf(landLevel);
  return r >= LAND_CENTER - h && r <= LAND_CENTER - 1 + h
      && c >= LAND_CENTER - h && c <= LAND_CENTER - 1 + h;
}

function xpForNext(level) { return 20 + level * 12; }
function carryCap(p) { return CARRY_CAP + (p.level || 0); }
function carriedTotal(p) { return RES_KINDS.reduce((s, k) => s + (p[k] || 0), 0); }

const DAY_LENGTH   = 96;  // ticks per in-game day (1 tick = 15 min)
const HOUR_DAWN    = 7;   // hour work starts
const HOUR_DUSK    = 21;  // hour workers leave buildings, evening begins
// midnight (hour 0) is when people sleep — derived from DAY_LENGTH wrap

// ── Seasons ───────────────────────────────────────────────────────────────────
const SEASONS       = ['spring', 'summer', 'autumn', 'winter'];
const SEASON_DAYS   = 3;                        // in-game days per season
const SEASON_LENGTH = SEASON_DAYS * DAY_LENGTH; // ticks per season
function currentSeason() { return SEASONS[Math.floor(simTick / SEASON_LENGTH) % 4]; }

// ── Eras ──────────────────────────────────────────────────────────────────────
// Era is gated on peak population (never regresses). Each era unlocks buildings.
const ERAS = [
  { name: 'hamlet',  pop: 0   },
  { name: 'village', pop: 15  }, // unlocks market, well, row house
  { name: 'town',    pop: 40  }, // unlocks school, apartment
  { name: 'city',    pop: 100 }, // win condition
];

// ── Research: the tree of trades ──────────────────────────────────────────────
// Souls buy knowledge. Each node teaches a trade, unlocking the building the
// citizens can then vote for and staff. Prereqs form a small tree.
const RESEARCH = {
  forestry:  { name: 'forestry',  emoji: '🌲', cost: 8,  req: [],                   desc: 'plant tree farms for a steady wood supply' },
  masonry:   { name: 'masonry',   emoji: '🪨', cost: 8,  req: [],                   desc: 'open stone farms (quarries)' },
  farming:   { name: 'farming',   emoji: '🌾', cost: 10, req: [],                   desc: 'plough farms that feed the town' },
  worship:   { name: 'worship',   emoji: '⛪', cost: 14, req: ['farming'],          desc: 'raise churches — the dying release more souls nearby' },
  trade:     { name: 'trade',     emoji: '⚖️', cost: 16, req: ['farming'],          desc: 'open markets that trade surplus food for gold' },
  industry:  { name: 'industry',  emoji: '🏭', cost: 24, req: ['masonry', 'trade'], desc: 'build factories (they need ore)' },
  education: { name: 'education', emoji: '🎓', cost: 30, req: ['worship', 'trade'], desc: 'build schools — faster learning nearby' },
};
const RESEARCH_TIERS = [['forestry', 'masonry', 'farming'], ['worship', 'trade'], ['industry', 'education']];
const RESEARCH_FOR_TYPE = {
  [TREE_FARM]: 'forestry', [STONE_FARM]: 'masonry', [FARM]: 'farming',
  [CHURCH]: 'worship', [SHOP]: 'trade', [FACTORY]: 'industry', [SCHOOL]: 'education',
};
let researched = new Set();

// ── Town-hall levels ──────────────────────────────────────────────────────────
// Halls upgrade themselves when the town prospers (era + happiness + stockpile);
// higher halls unlock higher-order buildings.
const TH_MAX_LEVEL = 3;
const TH_UPGRADE_COSTS = {
  2: { wood: 30, stone: 20, clay: 10 },
  3: { wood: 20, stone: 40, clay: 20, ore: 10 },
};
const BUILDING_TH_LEVEL = { [SHOP]: 2, [WELL]: 2, [FACTORY]: 2, [SCHOOL]: 3, [APARTMENT]: 3 };

// A full gatherer this far (Manhattan) from every hall founds a new town on the spot
const FOUND_DISTANCE = 20;

// Redevelopment: a voted building may raze a strictly lower-tier building
// when the town has no open site left. Walkable tiles (road, park) are never
// razed this way — replacing them could sever paths.
const BUILDING_TIER = {
  [ROAD]: 0,
  [HOUSE]: 1, [PARK]: 1, [TREE_FARM]: 1, [STONE_FARM]: 1, [FARM]: 1,
  [CHURCH]: 2, [SHOP]: 2, [WELL]: 2, [ROW_HOUSE]: 2,
  [FACTORY]: 3, [SCHOOL]: 3, [APARTMENT]: 3,
  [TOWN_HALL]: 9,
};

// ── Gold powers ───────────────────────────────────────────────────────────────
const POWER_COSTS = { road: 20, drop: 50, sway: 100, festival: 500, charter: 1000 };
const SWAY_VOTES      = 3;   // votes added per sway purchase
const DROP_AMOUNT     = 20;  // resource units per supply drop
const FESTIVAL_LENGTH = DAY_LENGTH; // festival lasts one day

const PERSON_NAMES = [
  'ada','arlo','beau','bram','cleo','cora','dot','edie','ezra','faye',
  'finn','flora','gus','hazel','ida','iris','jasper','juno','kit','lena',
  'mabel','milo','nell','oak','opal','otis','pearl','pip','quinn','remy',
  'rosa','rufus','sage','tess','theo','uma','vera','wren','york','zadie',
];
function randomName() { return PERSON_NAMES[Math.floor(Math.random() * PERSON_NAMES.length)]; }

const WORKER_JOBS = new Set([FACTORY, FARM, CHURCH, TREE_FARM, STONE_FARM, PARK, SHOP]);
const MAX_WORKERS_PER_BUILDING = 3;
const WORKER_OUTPUT = {
  [FARM]:       { food:  2 },  // staffed farms produce 2×; unstaffed still produce 1 via farmProduceFood
  [TREE_FARM]:  { wood:  1 },
  [STONE_FARM]: { stone: 1 },
  [FACTORY]:    { gold:  1 },
  [CHURCH]:     { food:  1 },
  [PARK]:       { food:  1 },
};

const WORKER_TITLES = {
  [FARM]: 'farmer', [TREE_FARM]: 'forester', [STONE_FARM]: 'mason',
  [FACTORY]: 'machinist', [CHURCH]: 'priest', [PARK]: 'groundskeeper', [SHOP]: 'merchant',
};

const HOUSE_POP     = 1;
const ROW_HOUSE_POP = 4;
const APARTMENT_POP = 10;

const BUILD_COSTS = {
  [ROAD]:       { wood: 1, stone: 0, food: 0 },
  [HOUSE]:      { wood: 5, stone: 0, food: 0 },
  [CHURCH]:     { wood: 2, stone: 4, food: 0 },
  [PARK]:       { wood: 0, stone: 0, food: 0 },
  [FACTORY]:    { wood: 5, stone: 5, food: 2, ore: 4 },
  [TOWN_HALL]:  { wood: 0, stone: 0, food: 0 }, // auto-placed, cost handled separately
  [TREE_FARM]:  { wood: 0, stone: 4, food: 0 }, // no wood cost — a wood-starved town must be able to build one
  [STONE_FARM]: { wood: 4, stone: 0, food: 0 }, // no stone cost — mirror of the tree farm
  [FARM]:       { wood: 4, stone: 1, food: 0 },
  [ROW_HOUSE]:  { wood: 8, stone: 4, food: 0 },
  [APARTMENT]:  { wood: 6, stone: 12, food: 0, clay: 6 },
  [SHOP]:       { wood: 4, stone: 2, food: 0 },
  [WELL]:       { wood: 0, stone: 6, food: 0 },
  [SCHOOL]:     { wood: 8, stone: 8, food: 0, clay: 4 },
};

const TOWN_HALL_TRIGGER = { houses: 6, wood: 20, stone: 15 };
const VOTE_THRESHOLD    = 10;

// ── Happiness thresholds ──────────────────────────────────────────────────────
// A thriving city keeps its people content: below UNHAPPY_BUILD_BELOW the vote
// swings hard toward parks and wells and the build engine lays free parks;
// below UNHAPPY_RAZE_BELOW the town starts tearing its factories down. New
// factories only go up while people are comfortably happy.
const UNHAPPY_RAZE_BELOW  = 50;
const UNHAPPY_BUILD_BELOW = 60;
const HAPPY_FACTORY_MIN   = 65;

// ── Game state ────────────────────────────────────────────────────────────────

const grid = [];
for (let r = 0; r < MAP_ROWS; r++) grid.push(new Array(MAP_COLS).fill(GRASS));

const resourceMap = [];
for (let r = 0; r < MAP_ROWS; r++) resourceMap.push(new Array(MAP_COLS).fill(null));

let gold         = 5;
let souls        = 10;  // the life-and-death currency: spawning and upgrades
let people       = [];
let nextPersonId = 0;
let townHalls    = []; // { r, c, resources:{wood,stone,food}, votes:{...}, popCap }
let houseRegistry = {}; // houseId → { r, c }
let nextHouseId  = 0;
let buildingRegistry = {}; // `${r},${c}` → { r, c, type, workers: [] }
let lifespanLevel   = 0;
let speedLevel      = 0;
let sightLevel      = 0;
let landLevel       = 0;
let simTick         = 0;
let selectedTHIndex = 0;    // which town hall is shown in stockpile/votes panels
let lastExploreTick = -200; // cooldown: minimum ticks between explorer dispatches

// ── Records, chronicle, era ───────────────────────────────────────────────────
let records = {
  peakPop: 0, oldestEver: 0, totalBirths: 0, totalDeaths: 0,
  townsFounded: 0, firesSurvived: 0, won: false, soulsHarvested: 0,
};
let chronicle = [];  // { day, text } — the town's history, shown in the records panel
let eraIndex  = 0;   // index into ERAS, derived from records.peakPop

// ── Live events & effects ─────────────────────────────────────────────────────
let burningTiles = {}; // "r,c" → { r, c, ticksLeft }
let fireActive   = false;
let particles    = []; // { x, y, vx, vy, life, maxLife, color } in tile coords

// ── Player interaction ────────────────────────────────────────────────────────
let clickMode = 'spawn'; // 'spawn' | 'demolish' | 'road' | 'drop-wood' | 'drop-stone' | 'drop-food'
let selectedPersonId = null;
let followSelected   = false;

// ── Trend history (sampled every 8 ticks) ─────────────────────────────────────
const HISTORY_MAX = 160;
let history = { pop: [], food: [], gold: [], souls: [] };

let muted = false;

// ── Discoveries ───────────────────────────────────────────────────────────────

const BUILDING_INFO = {
  [ROAD]:       { name: 'path',       desc: 'Dirt trail. People walk along paths. Required before most buildings can be placed.' },
  [HOUSE]:      { name: 'house',      desc: 'Shelter. Increases pop cap by 1.' },
  [PARK]:       { name: 'park',       desc: '+5% happiness. Generates food nodes nearby over time.' },
  [FACTORY]:    { name: 'factory',    desc: '+$30 gold/sec. -10% happiness. Only skilled workers (level 2+) may staff it. Needs industry research, a level 2 hall, and ore. An unhappy town will tear it down.' },
  [CHURCH]:     { name: 'church',     desc: 'Place of worship. Citizens who die nearby release 1.5× souls.' },
  [TOWN_HALL]:  { name: 'town hall',  desc: 'Civic centre. People deposit here and vote on new buildings. Upgrades itself with clay and ore, unlocking higher-order buildings.' },
  [TREE_FARM]:  { name: 'tree farm',  desc: 'Accumulates wood on its tile. People collect from adjacent tiles. Built when wood is scarce.' },
  [STONE_FARM]: { name: 'stone farm', desc: 'Accumulates stone on its tile. People collect from adjacent tiles. Built when stone is scarce.' },
  [FARM]:       { name: 'farm',       desc: 'Produces 1 food per tick directly into the nearest town hall. Built when food is low.' },
  [ROW_HOUSE]:  { name: 'row house',  desc: 'Denser housing. Holds 4 people. Upgraded automatically from a house when population is high.' },
  [APARTMENT]:  { name: 'apartment',  desc: 'Urban housing. Holds 10 people. Upgraded automatically from a row house when population is high.' },
  [SHOP]:       { name: 'market',     desc: 'Workers trade surplus food for gold. Needs trade research and a level 2 hall (village era).' },
  [WELL]:       { name: 'well',       desc: 'Fresh water. Reduces the chance of fires starting and spreading nearby. +3 happiness. Needs a level 2 hall.' },
  [SCHOOL]:     { name: 'school',     desc: 'Nearby workers produce 30% more and citizens learn 50% faster. Needs education research and a level 3 hall (town era).' },
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
    case TOWN_HALL:  drawTownHall(0, 0);  break;
    case TREE_FARM:  drawTreeFarm(0, 0);  break;
    case STONE_FARM: drawStoneFarm(0, 0); break;
    case FARM:       drawFarm(0, 0);       break;
    case ROW_HOUSE:  drawRowHouse(0, 0);  break;
    case APARTMENT:  drawApartment(0, 0); break;
    case SHOP:       drawShop(0, 0);      break;
    case WELL:       drawWell(0, 0);      break;
    case SCHOOL:     drawSchool(0, 0);    break;
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

function timeOfDay() {
  const tickInDay = simTick % DAY_LENGTH;
  const totalMins = tickInDay * 15;
  const hour      = Math.floor(totalMins / 60);
  const minute    = totalMins % 60;
  const isNight   = hour < HOUR_DAWN;                   // midnight–7am
  const isEvening = !isNight && hour >= HOUR_DUSK;      // 9pm–midnight
  const isDay     = !isNight && !isEvening;             // 7am–9pm
  return { hour, minute, tickInDay, isNight, isEvening, isDay };
}

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

function nearestTownHall(r, c) {
  let best = null, bestDist = Infinity;
  for (const th of townHalls) {
    const d = Math.abs(th.r - r) + Math.abs(th.c - c);
    if (d < bestDist) { bestDist = d; best = th; }
  }
  return best;
}

function globalPopCap() {
  return Math.min(MAX_PEOPLE, townHalls.reduce((s, th) => s + th.popCap, 0));
}

function emptyVotes() {
  return { [CHURCH]:0, [PARK]:0, [FACTORY]:0, [TREE_FARM]:0, [STONE_FARM]:0, [FARM]:0, [SHOP]:0, [WELL]:0, [SCHOOL]:0 };
}

function makeTownHall(r, c, resources) {
  return {
    r, c,
    resources: { wood: 0, stone: 0, food: 0, clay: 0, ore: 0, ...(resources || {}) },
    level: 1,
    votes: emptyVotes(),
    popCap: 5, // the hall itself shelters a few settlers — spawning works from day one
    buildTimer: TH_BUILD_INTERVAL,
    happiness: 70,
    festivalUntil: 0,
  };
}

function woodWeight(th) {
  const w = th.resources.wood, s = th.resources.stone;
  if (w + s === 0) return 15;
  const ratio = w / (w + s + 1);
  return ratio < 0.3 ? 40 : ratio < 0.5 ? 15 : 3;
}

function stoneWeight(th) {
  const w = th.resources.wood, s = th.resources.stone;
  if (w + s === 0) return 15;
  const ratio = s / (w + s + 1);
  return ratio < 0.3 ? 40 : ratio < 0.5 ? 15 : 3;
}

function foodWeight(th) {
  // Weight for voting to build a park, based on food scarcity
  // food per person: how many ticks the current supply will last
  const ticksLeft = people.length > 0 ? th.resources.food / people.length : th.resources.food;
  if (ticksLeft < 5)  return 80; // critical — almost out
  if (ticksLeft < 15) return 50; // low
  if (ticksLeft < 30) return 20; // moderate
  return 3;                      // plenty
}

function wouldBlockPath(r, c) {
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];

  // Collect walkable cardinal neighbours of the tile being placed
  const neighbours = [];
  for (const [dr, dc] of cardinals) {
    const nr = r+dr, nc = c+dc;
    if (!inBounds(nr, nc) || !inLand(nr, nc)) continue;
    const t = grid[nr][nc];
    if (t === GRASS || t === ROAD || t === PARK) neighbours.push([nr, nc]);
  }

  // 0 or 1 walkable neighbours — can never enclose anything
  if (neighbours.length <= 1) return false;

  // BFS flood-fill from the first neighbour, treating (r,c) as impassable.
  // If any other neighbour is not reached, the placement splits the open area.
  const isWalkable = (tr, tc) => {
    if (tr === r && tc === c) return false; // hypothetically filled
    if (!inBounds(tr, tc) || !inLand(tr, tc)) return false;
    const t = grid[tr][tc];
    return t === GRASS || t === ROAD || t === PARK;
  };

  const visited = new Set();
  const key = (tr, tc) => tr * 1000 + tc;
  const queue = [neighbours[0]];
  visited.add(key(...neighbours[0]));

  let head = 0;
  while (head < queue.length) {
    const [cr, cc] = queue[head++];
    for (const [dr, dc] of cardinals) {
      const nr = cr+dr, nc = cc+dc;
      if (!isWalkable(nr, nc) || visited.has(key(nr, nc))) continue;
      visited.add(key(nr, nc));
      queue.push([nr, nc]);
    }
  }

  // If any neighbour wasn't reached, placing here would isolate it
  for (let i = 1; i < neighbours.length; i++) {
    if (!visited.has(key(...neighbours[i]))) return true;
  }
  return false;
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
  const types = ['wood', 'stone', 'food', 'clay', 'ore'];
  const counts = [120, 60, 80, 45, 30];
  const amounts = [[15, 10], [20, 15], [10, 10], [12, 8], [10, 6]]; // [base, spread]
  for (let t = 0; t < types.length; t++) {
    for (let i = 0; i < counts[t]; i++) {
      const r = Math.floor(Math.random() * MAP_ROWS);
      const c = Math.floor(Math.random() * MAP_COLS);
      // Ore only forms beyond the starting land — a reason to expand
      if (types[t] === 'ore'
          && Math.abs(r - LAND_CENTER) <= landHalf(1) && Math.abs(c - LAND_CENTER) <= landHalf(1)) continue;
      if (!resourceMap[r][c]) {
        resourceMap[r][c] = {
          type: types[t],
          amount: amounts[t][0] + Math.floor(Math.random() * amounts[t][1]),
        };
      }
    }
  }
  // Concentrate extra nodes inside the starting land so a fresh world isn't barren
  const h = landHalf(0);
  const startTypes = ['wood', 'wood', 'food', 'food', 'stone', 'clay'];
  for (let i = 0; i < 18; i++) {
    const r = LAND_CENTER - h + Math.floor(Math.random() * h * 2);
    const c = LAND_CENTER - h + Math.floor(Math.random() * h * 2);
    if (inBounds(r, c) && !resourceMap[r][c]) {
      const type = startTypes[Math.floor(Math.random() * startTypes.length)];
      resourceMap[r][c] = { type, amount: 10 + Math.floor(Math.random() * 10) };
    }
  }
}

function regenerateResources() {
  const winter = currentSeason() === 'winter';
  const types = ['wood', 'stone', 'food', 'clay']; // ore is finite — mines deplete
  for (let i = 0; i < 3; i++) {
    const r = Math.floor(Math.random() * MAP_ROWS);
    const c = Math.floor(Math.random() * MAP_COLS);
    if (grid[r][c] === GRASS && !resourceMap[r][c]) {
      const type = types[Math.floor(Math.random() * types.length)];
      if (winter && type === 'food') continue; // nothing grows in winter
      resourceMap[r][c] = { type, amount: 5 + Math.floor(Math.random() * 6) };
    }
  }
  for (let r = 0; r < MAP_ROWS; r++) {
    for (let c = 0; c < MAP_COLS; c++) {
      const t = grid[r][c];
      if (t === PARK && !winter && Math.random() < 0.4) {
        const site = findGrassSiteNear(r, c, 1, 3);
        if (site && !resourceMap[site.r][site.c])
          resourceMap[site.r][site.c] = { type: 'food', amount: 5 + Math.floor(Math.random() * 8) };
      }
      if (t === TREE_FARM) {
        // Accumulate wood on the farm tile itself (capped); people pick up from
        // adjacent tiles. A drained node of another type (e.g. the stone the
        // farm was built over) makes way for the farm's own produce.
        if (!resourceMap[r][c] || resourceMap[r][c].amount <= 0) resourceMap[r][c] = { type: 'wood', amount: 0 };
        if (resourceMap[r][c].type === 'wood' && resourceMap[r][c].amount < 40 && Math.random() < 0.6)
          resourceMap[r][c].amount += 2 + Math.floor(Math.random() * 4);
      }
      if (t === STONE_FARM) {
        // Accumulate stone on the farm tile itself (capped); people pick up from adjacent tiles
        if (!resourceMap[r][c] || resourceMap[r][c].amount <= 0) resourceMap[r][c] = { type: 'stone', amount: 0 };
        if (resourceMap[r][c].type === 'stone' && resourceMap[r][c].amount < 40 && Math.random() < 0.6)
          resourceMap[r][c].amount += 2 + Math.floor(Math.random() * 4);
      }
    }
  }
}

function findGrassSiteNear(r, c, minR, maxR) {
  for (let radius = minR; radius <= maxR; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        if (inBounds(r+dr, c+dc) && inLand(r+dr, c+dc) && grid[r+dr][c+dc] === GRASS)
          return { r: r+dr, c: c+dc };
      }
    }
  }
  return null;
}

// ── People simulation ─────────────────────────────────────────────────────────

// Soul upgrade costs — linear, so buying one every generation feels natural
function lifespanUpgradeCost() { return 4  + lifespanLevel * 2;  }
function speedUpgradeCost()    { return 10 + speedLevel    * 10; }
function sightUpgradeCost()    { return 8  + sightLevel    * 6;  }
function landUpgradeCost()     { return 15 + landLevel     * 15; }

function churchNear(r, c) {
  for (let dr = -6; dr <= 6; dr++)
    for (let dc = -6; dc <= 6; dc++) {
      if (inBounds(r+dr, c+dc) && grid[r+dr][c+dc] === CHURCH) return true;
    }
  return false;
}

// Souls released at death: level and town happiness are the multipliers —
// nurture citizens so their deaths are worth more, then reinvest.
function soulYield(p) {
  const r = Math.round(p.y), c = Math.round(p.x);
  const th = nearestTownHall(r, c);
  const happy = th ? (th.happiness ?? 70) : 50;
  let y = (1 + (p.level || 0)) * (happy / 70);
  if (churchNear(r, c)) y *= CHURCH_SOUL_MULT;
  return Math.max(1, Math.round(y));
}

// Grant xp and handle level-ups. Schools make learning faster.
function grantXP(p, amount, nearSchool = false) {
  if ((p.level || 0) >= MAX_PERSON_LEVEL) return;
  p.xp = (p.xp || 0) + amount * (nearSchool ? SCHOOL_XP_MULT : 1);
  while (p.level < MAX_PERSON_LEVEL && p.xp >= xpForNext(p.level)) {
    p.xp -= xpForNext(p.level);
    p.level++;
    addParticles(Math.round(p.y), Math.round(p.x), '#ffd54f', 4);
  }
}

function currentMaxAge() {
  return BASE_LIFESPAN + lifespanLevel * LIFESPAN_PER_LEVEL;
}

function spawnPersonFree(r, c, houseId = null, force = false) {
  if (!inBounds(r, c) || !inLand(r, c) || (!force && people.length >= globalPopCap())) return null;
  const id = nextPersonId++;
  const p = {
    id,
    name: randomName(),
    x: c, y: r,
    age: 0,
    maxAge: currentMaxAge(),
    level: 0, xp: 0,
    wood: 0, stone: 0, food: 0, clay: 0, ore: 0,
    sick: false, sickTicks: 0, hungry: false,
    color: PERSON_COLORS[id % PERSON_COLORS.length],
    mode: 'gather',     // 'gather' | 'explore' | 'found' | 'home' | 'social'
    job:  'gatherer',   // 'gatherer' | 'explorer' | 'founder' | 'worker' | 'idle'
    assignedBuildingKey: null, // "${r},${c}" of assigned building, or null
    insideBuilding: false,     // true when worker is hidden inside a building
    sleeping:      false,      // true from midnight until dawn
    socialTarget:  null,       // { r, c } destination during evening social phase
    gatherPref: null,   // resource type to seek ('food'|'wood'|'stone') when the town runs short
    homeR: r, homeC: c,
    houseId: null,
    gatherTarget:  null, // { r, c } directed gather destination
    foundTarget:   null, // { r, c } destination when founding a new TH
    exploreWood:   0,    // founding resources carried while exploring
    exploreStone:  0,
    exploreTick:   0,    // ticks spent in explore mode (for timeout)
  };
  people.push(p);
  if (houseId != null && houseRegistry[houseId]) {
    assignHouse(p, houseId, houseRegistry[houseId]);
  }
  return p;
}

function removePerson(p) {
  unassignWorker(p);
  unassignHouse(p);
  const i = people.indexOf(p);
  if (i !== -1) people.splice(i, 1);
  if (selectedPersonId === p.id) { selectedPersonId = null; followSelected = false; }
}

function spawnPerson(r, c, quiet = false) {
  if (!inBounds(r, c)) return null;
  if (!inLand(r, c)) {
    if (!quiet) showMessage('that is beyond the known world — expand your land with souls');
    return null;
  }

  // First ever spawn: place the starting town hall on the clicked tile
  if (townHalls.length === 0) {
    if (souls < SPAWN_COST) {
      showMessage('need ' + SPAWN_COST + ' soul to spawn!');
      return null;
    }
    grid[r][c] = TOWN_HALL;
    clearBuriedResource(r, c);
    townHalls.push(makeTownHall(r, c, { wood: 10, stone: 0, food: 100 }));
    recordDiscovery(TOWN_HALL);
    souls -= SPAWN_COST;
    records.townsFounded = Math.max(records.townsFounded, 1);
    addChronicle('the first settlers arrived at ' + c + ', ' + r);
    sfx('build');
    // Spawn founder on an adjacent grass tile — force=true bypasses popCap (starts at 0)
    const site = findGrassSiteNear(r, c, 1, 3);
    if (site) spawnPersonFree(site.r, site.c, null, true);
    updateUI();
    render();
    return null;
  }

  const cap = globalPopCap();
  if (people.length >= cap) {
    if (!quiet) showMessage('population cap reached! build more houses.');
    return null;
  }
  if (souls < SPAWN_COST) {
    if (!quiet) showMessage('need ' + SPAWN_COST + ' soul to spawn!');
    return null;
  }
  const p = spawnPersonFree(r, c);
  if (!p) return null;
  souls -= SPAWN_COST;
  sfx('spawn');
  if (quiet) updateUIThrottled(); else updateUI();
  return p;
}

function consumeFood() {
  for (const p of people) {
    if (Math.random() >= 0.1) continue;
    const th = nearestTownHall(Math.round(p.y), Math.round(p.x));
    if (th && th.resources.food >= 1) {
      th.resources.food--;
      p.hungry = false;
    } else {
      // No food — age faster (starvation: +2 age per tick instead of 1)
      p.age++;
      p.hungry = true; // rendered pale so trouble is visible before deaths start
    }
  }
}

function agePeople() {
  people = people.filter(p => {
    p.age++;
    if (p.sick) {
      p.age++; // illness ages people twice as fast
      p.sickTicks = (p.sickTicks || 0) - 1;
      if (p.sickTicks <= 0) p.sick = false;
    }
    if (p.age >= p.maxAge) {
      // The harvest: souls scale with the life lived
      const r = Math.round(p.y), c = Math.round(p.x);
      const yield_ = soulYield(p);
      souls += yield_;
      records.soulsHarvested += yield_;
      addSoulWisp(r, c, Math.min(yield_, 8));
      sfx('soul');
      // Drop carried resources at death site
      const total = carriedTotal(p);
      const lv = p.level ? ' (lv ' + p.level + ')' : '';
      if (total > 0 && inBounds(r, c) && !resourceMap[r][c]) {
        const dominant = RES_KINDS.reduce((a, b) => ((p[a] || 0) >= (p[b] || 0) ? a : b));
        resourceMap[r][c] = { type: dominant, amount: total };
        logEvent('💀 ' + p.name + lv + ' died, leaving ' + total + ' ' + dominant + ' — ✨ +' + yield_ + ' souls', 'info');
      } else {
        logEvent('💀 ' + p.name + lv + ' died at ' + Math.floor(p.age / DAY_LENGTH) + 'd — ✨ +' + yield_ + ' souls', 'info');
      }
      records.totalDeaths++;
      const days = p.age / DAY_LENGTH;
      if (days > records.oldestEver) records.oldestEver = Math.round(days * 10) / 10;
      unassignWorker(p);
      unassignHouse(p);
      if (selectedPersonId === p.id) { selectedPersonId = null; followSelected = false; }
      return false;
    }
    return true;
  });
}

function updatePersonMode(p) {
  if (p.job === 'worker') return; // workers are managed by workerTick
  if (p.mode === 'found') return; // founder manages their own mode
  if (p.sleeping || p.mode === 'home' || p.mode === 'social') return; // time-of-day modes
  const r = Math.round(p.y), c = Math.round(p.x);

  // --- Explore mode: check termination; bypass all other logic ---
  if (p.mode === 'explore') {
    p.exploreTick++;
    let minDist = Infinity;
    for (const th of townHalls) {
      const d = Math.abs(r - th.r) + Math.abs(c - th.c);
      if (d < minDist) minDist = d;
    }
    if (minDist >= 25 || p.exploreTick > 200) {
      dropExplorerCache(p, r, c);
      if (p.houseId == null) { p.homeR = r; p.homeC = c; }
      p.exploreWood = 0; p.exploreStone = 0; p.exploreTick = 0;
      p.mode = 'gather';
      showMessage('explorer settled at ' + c + ', ' + r);
    }
    return;
  }

  // --- Explore trigger ---
  const cap = globalPopCap();
  const th0 = nearestTownHall(r, c);
  if (p.mode === 'gather'
      && simTick - lastExploreTick >= 200
      && cap > 0 && people.length / cap >= 0.80
      && townHalls.length === 1
      && !people.some(q => q.mode === 'explore' || q.mode === 'found')
      && th0 && th0.resources.wood  >= TOWN_HALL_TRIGGER.wood
             && th0.resources.stone >= TOWN_HALL_TRIGGER.stone
      && Math.random() < 0.0002) {
    lastExploreTick = simTick;
    th0.resources.wood  -= TOWN_HALL_TRIGGER.wood;
    th0.resources.stone -= TOWN_HALL_TRIGGER.stone;
    p.exploreWood  = TOWN_HALL_TRIGGER.wood;
    p.exploreStone = TOWN_HALL_TRIGGER.stone;
    p.exploreTick  = 0;
    p.gatherTarget = null;
    p.mode = 'explore';
    showMessage('explorer departed from ' + c + ', ' + r);
    return;
  }

  // Default: everyone who is not a worker, explorer, or founder is a gatherer.
  p.mode = 'gather';

  // Full pack but too far from every hall to deposit? Found a new town here.
  if (carriedTotal(p) >= carryCap(p) && simTick >= (p.foundCooldownUntil || 0)) {
    let minTHDist = Infinity;
    for (const th2 of townHalls) {
      const d = Math.abs(r - th2.r) + Math.abs(c - th2.c);
      if (d < minTHDist) minTHDist = d;
    }
    if (minTHDist >= FOUND_DISTANCE && !tryFoundHere(p, r, c))
      p.foundCooldownUntil = simTick + 60; // don't retry the site search every tick
  }

  // Seek whichever resource the town is short of: food when nearly out,
  // otherwise the scarcer of wood/stone when the stockpile is badly lopsided.
  const th = nearestTownHall(r, c);
  const foodTicksLeft = (th && people.length > 0) ? th.resources.food / people.length : 999;
  const prev = p.gatherPref;
  if (foodTicksLeft < 5) p.gatherPref = 'food';
  else if (th && th.resources.wood  < 30 && th.resources.wood  * 3 < th.resources.stone) p.gatherPref = 'wood';
  else if (th && th.resources.stone < 30 && th.resources.stone * 3 < th.resources.wood)  p.gatherPref = 'stone';
  else p.gatherPref = null;
  if (p.gatherPref !== prev) p.gatherTarget = null; // re-target when the need changes
}

// Construction over a resource node buries it where no one can stand — remove
// it so gatherers stop chasing it. Walkable placements (road, park) keep their
// nodes, and tree/stone farm tiles are legitimately gathered from adjacent.
function clearBuriedResource(r, c) {
  const t = grid[r][c];
  if (t === GRASS || t === ROAD || t === PARK) return;
  if (t === TREE_FARM || t === STONE_FARM) return;
  resourceMap[r][c] = null;
}

function hasFarmResourceAdjacentTo(r, c) {
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const ar = r+dr, ac = c+dc;
    if (!inBounds(ar, ac)) continue;
    const ft = grid[ar][ac];
    if ((ft === TREE_FARM || ft === STONE_FARM) && resourceMap[ar][ac]?.amount > 0) return true;
  }
  return false;
}

// prefType: 'food' | 'wood' | 'stone' | null. A matching node wins outright;
// non-matching nodes are remembered as a fallback if nothing preferred is near.
// Search radius grows with the Sight upgrade. Low-level people can't carry
// stone or ore, so those nodes are invisible to them (returning one would strand them).
function findNearestResource(r, c, prefType, personLevel = MAX_PERSON_LEVEL) {
  let fallback = null;
  const maxRadius = BASE_SIGHT_RADIUS + sightLevel * 3;
  const canCarry = (type) =>
    (type !== 'stone' || personLevel >= STONE_LEVEL) && (type !== 'ore' || personLevel >= ORE_LEVEL);
  for (let radius = 1; radius <= maxRadius; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const nr = r+dr, nc = c+dc;
        if (!inBounds(nr, nc) || !inLand(nr, nc)) continue;
        const t = grid[nr][nc];
        const res = resourceMap[nr][nc];
        // Walkable resource node
        if (res && res.amount > 0 && canCarry(res.type) && (t === GRASS || t === ROAD || t === PARK)) {
          if (!prefType || res.type === prefType) return { r: nr, c: nc };
          if (!fallback) fallback = { r: nr, c: nc };
        }
        // Farm tile: return an adjacent walkable cell
        if ((t === TREE_FARM || t === STONE_FARM) && res?.amount > 0 && canCarry(res.type)) {
          for (const [er, ec] of [[-1,0],[1,0],[0,-1],[0,1]]) {
            const ar = nr+er, ac = nc+ec;
            if (!inBounds(ar, ac) || !inLand(ar, ac)) continue;
            const at = grid[ar][ac];
            if (at === GRASS || at === ROAD || at === PARK) {
              if (!prefType || res.type === prefType) return { r: ar, c: ac };
              if (!fallback) fallback = { r: ar, c: ac };
            }
          }
        }
      }
    }
    if (prefType && radius >= Math.floor(maxRadius * 0.6) && fallback) return fallback;
  }
  return fallback;
}

function dropExplorerCache(p, r, c) {
  for (const { type, total } of [
    { type: 'wood',  total: p.exploreWood  },
    { type: 'stone', total: p.exploreStone },
  ]) {
    if (total <= 0) continue;
    let found = false;
    outer: for (let radius = 0; radius <= 3; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (radius > 0 && Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
          const nr = r+dr, nc = c+dc;
          if (!inBounds(nr, nc) || !inLand(nr, nc) || grid[nr][nc] !== GRASS || resourceMap[nr][nc]) continue;
          resourceMap[nr][nc] = { type, amount: total };
          found = true;
          break outer;
        }
      }
    }
    if (!found && inBounds(r, c)) resourceMap[r][c] = { type, amount: total };
  }
}

function movePerson(p) {
  const dirs = [
    { dr: -1, dc:  0 },
    { dr:  1, dc:  0 },
    { dr:  0, dc: -1 },
    { dr:  0, dc:  1 },
  ];

  if (p.insideBuilding) return; // workers are inside their building — skip movement
  const r = Math.round(p.y), c = Math.round(p.x);
  // Sleeping and already at home tile — go inside and hide
  if (p.sleeping && r === p.homeR && c === p.homeC) {
    p.insideBuilding = true;
    return;
  }
  const carried = carriedTotal(p);
  updatePersonMode(p);

  const cardinalOffsets = [[-1,0],[1,0],[0,-1],[0,1]];

  // When full, navigate directly toward the nearest town hall
  // (direction-independent — computed once, not per candidate direction)
  const homeTH = carried >= carryCap(p) ? nearestTownHall(r, c) : null;
  const thDistBefore = homeTH ? Math.abs(r - homeTH.r) + Math.abs(c - homeTH.c) : Infinity;

  const weights = dirs.map(d => {
    const nr = Math.round(p.y) + d.dr;
    const nc = Math.round(p.x) + d.dc;
    if (!inBounds(nr, nc) || !inLand(nr, nc)) return 0;

    const t = grid[nr][nc];
    // Buildings are impassable walls — only GRASS, ROAD, and PARK are walkable
    if (t !== GRASS && t !== ROAD && t !== PARK) return 0;

    let w = 1.0;

    // Check if moving to (nr,nc) puts us adjacent to a town hall (deposit point)
    const adjTownHall = cardinalOffsets.some(([er, ec]) => {
      const ar = nr+er, ac = nc+ec;
      return inBounds(ar, ac) && grid[ar][ac] === TOWN_HALL;
    });

    // Check if moving to (nr,nc) puts us adjacent to a farm tile with resources
    const adjFarmRes = cardinalOffsets.some(([er, ec]) => {
      const ar = nr+er, ac = nc+ec;
      if (!inBounds(ar, ac)) return false;
      const ft = grid[ar][ac];
      if (ft !== TREE_FARM && ft !== STONE_FARM) return false;
      const fres = resourceMap[ar][ac];
      return fres && fres.amount > 0;
    });

    const th = homeTH;
    const thDistAfter = th ? Math.abs(nr - th.r) + Math.abs(nc - th.c) : Infinity;

    if (p.mode === 'explore') {
      // Move away from all town halls
      let minDistAfter = Infinity, minDistBefore = Infinity;
      for (const eth of townHalls) {
        const da = Math.abs(nr - eth.r) + Math.abs(nc - eth.c);
        const db = Math.abs(Math.round(p.y) - eth.r) + Math.abs(Math.round(p.x) - eth.c);
        if (da < minDistAfter)  minDistAfter  = da;
        if (db < minDistBefore) minDistBefore = db;
      }
      if (minDistAfter > minDistBefore)        w *= 20;
      else if (minDistAfter === minDistBefore)  w *= 2;
      else                                      w *= 0.1;
      if (t === ROAD) w *= 0.4; // avoid roads leading back to settlement

    } else if (p.mode === 'home') {
      // Walk straight home to sleep
      const distAfter  = Math.abs(nr - p.homeR) + Math.abs(nc - p.homeC);
      const distBefore = Math.abs(r  - p.homeR)  + Math.abs(c  - p.homeC);
      if (distAfter < distBefore) w *= 40;
      else if (distAfter > distBefore) w *= 0.01;
      if (t === ROAD) w *= 1.5;

    } else if (p.mode === 'social') {
      // Evening: wander to nearest park/church/town-hall area
      if (!p.socialTarget) p.socialTarget = findSocialTarget(r, c);
      if (p.socialTarget) {
        const td  = Math.abs(nr - p.socialTarget.r) + Math.abs(nc - p.socialTarget.c);
        const td0 = Math.abs(r  - p.socialTarget.r) + Math.abs(c  - p.socialTarget.c);
        if (td < td0) w *= 10;
        else if (td > td0) w *= 0.2;
      } else {
        // No venue — loiter near home
        const distAfter = Math.abs(nr - p.homeR) + Math.abs(nc - p.homeC);
        w *= 1.0 + Math.max(0, 6 - distAfter) * 0.3;
      }
      if (t === ROAD) w *= 2.0;
      if (t === PARK) w *= 3.0;

    } else if (p.mode === 'found') {
      // Walk directly toward the founding target
      if (p.foundTarget) {
        const td  = Math.abs(nr - p.foundTarget.r) + Math.abs(nc - p.foundTarget.c);
        const td0 = Math.abs(r  - p.foundTarget.r) + Math.abs(c  - p.foundTarget.c);
        if (td < td0)      w *= 40;
        else if (td > td0) w *= 0.05;
      }
      if (t === ROAD) w *= 1.5;

    } else {
      // Gather mode: directed to nearest resource, then return to TH
      if (carried < carryCap(p)) {
        // Phase 1: navigate to nearest resource
        if (!p.gatherTarget && simTick >= (p.searchCooldownUntil || 0)) {
          p.gatherTarget = findNearestResource(r, c, p.gatherPref, p.level || 0);
          // A failed search scans ~2600 tiles — don't repeat it every tick
          if (!p.gatherTarget) p.searchCooldownUntil = simTick + 8;
        }
        // Validate target still has resources on a tile you can stand on —
        // a building raised over a node must not leave people circling it
        if (p.gatherTarget) {
          const tr = p.gatherTarget.r, tc = p.gatherTarget.c;
          const tt = grid[tr][tc];
          const standable = tt === GRASS || tt === ROAD || tt === PARK;
          if (!(standable && resourceMap[tr][tc]?.amount > 0) && !hasFarmResourceAdjacentTo(tr, tc))
            p.gatherTarget = null;
        }
        if (p.gatherTarget) {
          const td  = Math.abs(nr - p.gatherTarget.r) + Math.abs(nc - p.gatherTarget.c);
          const td0 = Math.abs(r  - p.gatherTarget.r) + Math.abs(c  - p.gatherTarget.c);
          if (td < td0)        w *= 50;
          else if (td === td0) w *= 1;
          else                 w *= 0.05;
          if (nr === p.gatherTarget.r && nc === p.gatherTarget.c) w *= 3;
        } else {
          // Fallback: wander away from home
          const distAfter = Math.abs(nr - p.homeR) + Math.abs(nc - p.homeC);
          w *= 1.0 + distAfter * 0.08;
        }
        if (adjFarmRes) w *= 2.0;
        if (t === ROAD) w *= 1.2;
      } else {
        // Phase 2: full — return to TH; clear target for next trip
        p.gatherTarget = null;
        if (th) {
          if (thDistAfter < thDistBefore) w *= 8.0;
          if (adjTownHall) w *= 10.0;
        }
        if (t === ROAD) w *= 1.2;
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
  }

  // Founding arrival: when close enough to target, place the new town hall
  if (p.mode === 'found' && p.foundTarget) {
    const ar = Math.round(p.y), ac = Math.round(p.x);
    if (Math.abs(ar - p.foundTarget.r) + Math.abs(ac - p.foundTarget.c) <= 1)
      placeFoundedTH(p);
  }
}

function movePeople() {
  for (const p of people) {
    movePerson(p);
    // Speed upgrade: chance of a second step each tick
    if (speedLevel > 0 && !p.insideBuilding && Math.random() < speedLevel * 0.1)
      movePerson(p);
  }
}

function canPersonCarry(p, type) {
  if (type === 'stone') return (p.level || 0) >= STONE_LEVEL;
  if (type === 'ore')   return (p.level || 0) >= ORE_LEVEL;
  return true;
}

function gatherResources() {
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const p of people) {
    if (p.mode === 'explore') continue; // explorers don't gather while en route
    const r = Math.round(p.y), c = Math.round(p.x);
    const carried = carriedTotal(p);
    if (carried >= carryCap(p)) continue;

    // Pick up from the tile you're standing on (grass nodes)
    const res = resourceMap[r][c];
    if (res && res.amount > 0 && canPersonCarry(p, res.type)) {
      res.amount--;
      p[res.type]++;
      gold++;
      grantXP(p, 1, schoolNear(r, c));
      if (res.amount <= 0) resourceMap[r][c] = null;
      continue;
    }

    // Pick up from an adjacent farm tile (tree farm / stone farm)
    for (const [dr, dc] of cardinals) {
      const ar = r+dr, ac = c+dc;
      if (!inBounds(ar, ac)) continue;
      const ft = grid[ar][ac];
      if (ft !== TREE_FARM && ft !== STONE_FARM) continue;
      const fres = resourceMap[ar][ac];
      if (fres && fres.amount > 0 && canPersonCarry(p, fres.type)) {
        fres.amount--;
        p[fres.type]++;
        gold++;
        grantXP(p, 1, schoolNear(r, c));
        // Clear a drained node so the farm's own accumulation can restart —
        // a leftover empty node of the wrong type kept farms barren forever
        if (fres.amount <= 0) resourceMap[ar][ac] = null;
        break;
      }
    }
  }
}

function depositResources() {
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const p of people) {
    const r = Math.round(p.y), c = Math.round(p.x);
    const carried = carriedTotal(p);
    if (carried === 0) continue;
    for (const [dr, dc] of cardinals) {
      const nr = r+dr, nc = c+dc;
      if (!inBounds(nr, nc)) continue;
      if (grid[nr][nc] !== TOWN_HALL) continue;
      const th = nearestTownHall(nr, nc);
      if (!th) break;
      const dominant = RES_KINDS.reduce((a, b) => ((p[a] || 0) >= (p[b] || 0) ? a : b));
      for (const k of RES_KINDS) {
        th.resources[k] = (th.resources[k] || 0) + (p[k] || 0);
        p[k] = 0;
      }
      addParticles(Math.round(p.y), Math.round(p.x), RES_COLORS[dominant], 4);
      grantXP(p, 2, schoolNear(r, c));
      p.gatherTarget = null;
      castVote(th);
      break;
    }
  }
}


function canAffordBuild(type, th) {
  if (!th) return false;
  const cost = BUILD_COSTS[type];
  return Object.entries(cost).every(([k, v]) => (th.resources[k] || 0) >= v);
}

function spendBuildCost(type, th) {
  const cost = BUILD_COSTS[type];
  for (const [k, v] of Object.entries(cost)) th.resources[k] = (th.resources[k] || 0) - v;
}

function findHouseRegistryEntry(r, c) {
  for (const [, h] of Object.entries(houseRegistry)) {
    if (h.r === r && h.c === c) return h;
  }
  return null;
}

function registerHouse(r, c, th, slots) {
  const id = nextHouseId++;
  houseRegistry[id] = { r, c, slots, residents: [] };
  const h = houseRegistry[id];
  th.popCap += slots;
  // Assign any homeless people into vacant slots immediately
  for (const p of people) {
    if (h.residents.length >= slots) break;
    if (p.houseId != null) continue;
    assignHouse(p, id, h);
  }
}

function findHouseWithVacancy() {
  for (const [id, h] of Object.entries(houseRegistry)) {
    if (h.residents.length < h.slots) return [Number(id), h];
  }
  return null;
}

function assignHouse(p, id, h) {
  p.houseId = id;
  // Point homeR/homeC at a walkable tile adjacent to the house so people
  // can actually reach their "home" position (the house tile itself is impassable).
  let homeR = h.r, homeC = h.c;
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const nr = h.r + dr, nc = h.c + dc;
    if (!inBounds(nr, nc)) continue;
    const t = grid[nr][nc];
    if (t === GRASS || t === ROAD || t === PARK) { homeR = nr; homeC = nc; break; }
  }
  p.homeR = homeR;
  p.homeC = homeC;
  if (!h.residents.includes(p.id)) h.residents.push(p.id);
}

function unassignHouse(p) {
  if (p.houseId == null) return;
  const h = houseRegistry[p.houseId];
  if (h) {
    const idx = h.residents.indexOf(p.id);
    if (idx !== -1) h.residents.splice(idx, 1);
  }
  p.houseId = null;
}

// ── Housing pressure & vacancy ────────────────────────────────────────────────
// Homeless citizens are a loud demand for housing: they depress happiness and
// push the build engine to raise homes first. Empty beds are the opposite
// signal: they draw in births, and a big surplus lets voted buildings convert
// an empty house instead of taking open ground.

function homelessCount() {
  let n = 0;
  for (const p of people) {
    if (p.houseId == null && p.mode !== 'explore' && p.mode !== 'found') n++;
  }
  return n;
}

function housingVacancy() {
  let unfilled = 0, slots = 0;
  for (const h of Object.values(houseRegistry)) {
    slots += h.slots;
    unfilled += Math.max(0, h.slots - h.residents.length);
  }
  // Two views of an unfilled bed. `empty` is what can still be moved into —
  // beds beyond the world population ceiling can never be filled, so they
  // don't count (display, birth boost). `surplus` is the physical unfilled
  // count — beds past the ceiling are exactly the ones the town should feel
  // free to raze and repurpose (voted-building conversion).
  const empty = Math.min(unfilled, Math.max(0, MAX_PEOPLE - people.length));
  return {
    empty, slots,
    ratio: slots > 0 ? empty / slots : 0,
    surplus: unfilled,
    surplusRatio: slots > 0 ? unfilled / slots : 0,
  };
}

// Every few ticks the homeless move into the nearest vacant bed (within a
// reasonable walk — nobody relocates across the map for a room)
function rehouseHomeless() {
  const vacant = Object.entries(houseRegistry).filter(([, h]) => h.residents.length < h.slots);
  if (vacant.length === 0) return;
  for (const p of people) {
    if (p.houseId != null || p.mode === 'explore' || p.mode === 'found') continue;
    let bestId = null, bestH = null, bestD = Infinity;
    for (const [id, h] of vacant) {
      if (h.residents.length >= h.slots) continue;
      const d = Math.abs(Math.round(p.y) - h.r) + Math.abs(Math.round(p.x) - h.c);
      if (d < bestD) { bestD = d; bestId = Number(id); bestH = h; }
    }
    if (!bestH) return; // every bed taken
    if (bestD > 30) continue;
    assignHouse(p, bestId, bestH);
  }
}

// ── Building registry helpers ─────────────────────────────────────────────────

function registerBuilding(r, c, type) {
  buildingRegistry[r + ',' + c] = { r, c, type, workers: [] };
}

function unregisterBuilding(r, c) {
  const entry = buildingRegistry[r + ',' + c];
  if (!entry) return;
  for (const pid of [...entry.workers]) {
    const p = people.find(q => q.id === pid);
    if (p) unassignWorker(p);
  }
  delete buildingRegistry[r + ',' + c];
}

function assignWorker(p, br, bc) {
  const key = br + ',' + bc;
  const entry = buildingRegistry[key];
  if (!entry || entry.workers.includes(p.id)) return;
  if (entry.workers.length >= MAX_WORKERS_PER_BUILDING) return;
  if (p.assignedBuildingKey) unassignWorker(p);
  entry.workers.push(p.id);
  p.job = 'worker';
  p.assignedBuildingKey = key;
  p.insideBuilding = true;
  p.gatherTarget = null;
}

function unassignWorker(p) {
  if (!p.assignedBuildingKey) return;
  const entry = buildingRegistry[p.assignedBuildingKey];
  if (entry) {
    const idx = entry.workers.indexOf(p.id);
    if (idx !== -1) entry.workers.splice(idx, 1);
  }
  p.job = 'gatherer';
  p.assignedBuildingKey = null;
  p.insideBuilding = false;
  p.mode = 'gather';
}

// Returns true if placing a non-road building at (r,c) would sit on the direct corridor
// between this tile and the nearest town hall — reserving that line for road access.
function wouldBlockCorridor(r, c, th) {
  const dr = th.r - r, dc = th.c - c;
  // Only applies when the tile is axis-aligned with the TH
  if (dr !== 0 && dc !== 0) return false;
  // The corridor direction
  const [fdr, fdc] = dr !== 0 ? [Math.sign(dr), 0] : [0, Math.sign(dc)];
  // Check that the immediate step toward the TH is also open (walkable or TH itself)
  // — if something is already blocking between us and the TH, we're not the corridor tile
  const nr = r + fdr, nc = c + fdc;
  if (!inBounds(nr, nc)) return false;
  const nt = grid[nr][nc];
  return nt === GRASS || nt === ROAD || nt === PARK || nt === TOWN_HALL;
}

// ── Town-hall autonomous build engine ─────────────────────────────────────────

// BFS from tiles adjacent to th. Treats (r,c) as hypothetically impassable.
// Returns true if any cardinal neighbour of (r,c) is reachable from the TH —
// guaranteeing the placed building has walkable access connected to the TH.
function isTHReachable(r, c, th) {
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  const seeds = [];
  for (const [dr, dc] of cardinals) {
    const sr = th.r+dr, sc = th.c+dc;
    if (sr === r && sc === c) continue; // the candidate tile is hypothetically impassable — never a seed
    if (!inBounds(sr,sc) || !inLand(sr,sc)) continue;
    const t = grid[sr][sc];
    if (t === GRASS || t === ROAD || t === PARK) seeds.push([sr,sc]);
  }
  if (seeds.length === 0) return false;
  const key = (tr, tc) => tr * 1000 + tc;
  const visited = new Set();
  const queue = [];
  for (const s of seeds) {
    const k = key(...s);
    if (!visited.has(k)) { visited.add(k); queue.push(s); }
  }
  const walkable = (tr, tc) => {
    if (tr === r && tc === c) return false;
    if (!inBounds(tr,tc) || !inLand(tr,tc)) return false;
    const t = grid[tr][tc];
    return t === GRASS || t === ROAD || t === PARK;
  };
  let head = 0;
  while (head < queue.length) {
    const [cr, cc] = queue[head++];
    for (const [dr, dc] of cardinals) {
      const nr = cr+dr, nc = cc+dc;
      if (!walkable(nr,nc) || visited.has(key(nr,nc))) continue;
      visited.add(key(nr,nc));
      queue.push([nr,nc]);
    }
  }
  for (const [dr, dc] of cardinals) {
    const nr = r+dr, nc = c+dc;
    if (inBounds(nr,nc) && visited.has(key(nr,nc))) return true;
  }
  return false;
}

// Score for extending a road to (r,c): mild preference for continuing a line,
// turns are welcome, dense junctions and crowding are discouraged. Kept gentle
// on purpose — selection is weighted-random, so these are tendencies, not rules.
function roadScore(r, c) {
  const N = inBounds(r-1,c) && grid[r-1][c] === ROAD;
  const S = inBounds(r+1,c) && grid[r+1][c] === ROAD;
  const W = inBounds(r,c-1) && grid[r][c-1] === ROAD;
  const E = inBounds(r,c+1) && grid[r][c+1] === ROAD;
  const cardinalPaths = (N?1:0)+(S?1:0)+(W?1:0)+(E?1:0);
  const continuesStraight = (N&&S)||(E&&W);
  const branchPenalty = cardinalPaths >= 3 ? 0.25
                      : (cardinalPaths === 2 && !continuesStraight) ? 0.7 : 1.0;
  let neighbourPaths = 0;
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (dr===0&&dc===0) continue;
      if (inBounds(r+dr,c+dc) && grid[r+dr][c+dc] === ROAD) neighbourPaths++;
    }
  const crowdPenalty = Math.pow(0.5, Math.max(0, neighbourPaths - 2));
  const base = continuesStraight ? 39 : cardinalPaths > 0 ? 30 : 20;
  return base * branchPenalty * crowdPenalty;
}

// Attempt to grow the road network by one tile. Returns true if a road was placed.
// The next tile is drawn weighted-random from every possible extension, with
// weights decaying by distance from the hall — so the network creeps outward on
// several fronts at once instead of racing down one straight spur.
function thRoadStep(th) {
  if (!canAffordBuild(ROAD, th)) return false;
  const candidates = [];
  const seen = new Set();
  const consider = (r, c) => {
    const k = r * 1000 + c;
    if (seen.has(k)) return;
    seen.add(k);
    const dist = Math.abs(r - th.r) + Math.abs(c - th.c);
    candidates.push({ r, c, weight: roadScore(r, c) / (1 + dist * 0.08) });
  };
  for (let dr = -20; dr <= 20; dr++) {
    for (let dc = -20; dc <= 20; dc++) {
      const r = th.r+dr, c = th.c+dc;
      if (!inBounds(r,c) || Math.abs(dr)+Math.abs(dc) > 20) continue;
      if (grid[r][c] !== ROAD) continue;
      for (const [er,ec] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = r+er, nc = c+ec;
        if (!inBounds(nr,nc) || !inLand(nr,nc) || grid[nr][nc] !== GRASS) continue;
        consider(nr, nc);
      }
    }
  }
  // The TH's own grass neighbours are always in the pool — the network can
  // sprout a fresh arm from the hall at any time, not only when boxed in.
  for (const [dr,dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const nr = th.r+dr, nc = th.c+dc;
    if (inBounds(nr,nc) && inLand(nr,nc) && grid[nr][nc] === GRASS)
      consider(nr, nc);
  }
  if (candidates.length === 0) return false;
  // No wouldBlockPath check here: roads are walkable, so paving grass can
  // never sever a path. (Checking it froze road growth whenever the frontier
  // tile backed onto a road cul-de-sac — the check saw a "sealed pocket".)
  const total = candidates.reduce((s, cand) => s + cand.weight, 0);
  if (total <= 0) return false;
  let rand = Math.random() * total;
  let pick = candidates[candidates.length - 1];
  for (const cand of candidates) {
    rand -= cand.weight;
    if (rand <= 0) { pick = cand; break; }
  }
  spendBuildCost(ROAD, th);
  grid[pick.r][pick.c] = ROAD;
  recordDiscovery(ROAD);
  return true;
}

// Score for placing a house at (r,c): prefers road-fronted, terrace-bonus, penalises density.
function houseScore(r, c) {
  const N = inBounds(r-1,c) && grid[r-1][c] === ROAD;
  const S = inBounds(r+1,c) && grid[r+1][c] === ROAD;
  const E = inBounds(r,c+1) && grid[r][c+1] === ROAD;
  const W = inBounds(r,c-1) && grid[r][c-1] === ROAD;
  const cardinalPaths = (N?1:0)+(S?1:0)+(E?1:0)+(W?1:0);
  if (cardinalPaths === 0 || cardinalPaths >= 3) return 0;
  let localHouses = 0;
  for (let dr = -5; dr <= 5; dr++)
    for (let dc = -5; dc <= 5; dc++) {
      if (!inBounds(r+dr,c+dc)) continue;
      const t = grid[r+dr][c+dc];
      if (t === HOUSE || t === ROW_HOUSE || t === APARTMENT) localHouses++;
    }
  const isBldg = (tr, tc) => {
    if (!inBounds(tr,tc)) return false;
    const t = grid[tr][tc];
    return t !== GRASS && t !== ROAD && t !== PARK && t !== TOWN_HALL;
  };
  let terraceBonus = 1.0;
  if (N||S) { if (isBldg(r,c-1)||isBldg(r,c+1)) terraceBonus = 2.5; }
  if (E||W) { if (isBldg(r-1,c)||isBldg(r+1,c)) terraceBonus = 2.5; }
  const base = Math.max(0, 40 - localHouses * 6);
  return Math.round(base * terraceBonus);
}

// Attempt to place one house near the TH. Returns true if placed.
// Cheap scoring filters first; the expensive flood-fill checks run lazily,
// best-first, on at most a dozen candidates (same pattern as thRoadStep).
function thHouseStep(th) {
  if (!canAffordBuild(HOUSE, th)) return false;
  const candidates = [];
  for (let dr = -15; dr <= 15; dr++) {
    for (let dc = -15; dc <= 15; dc++) {
      const r = th.r+dr, c = th.c+dc;
      if (!inBounds(r,c) || !inLand(r,c)) continue;
      const t = grid[r][c];
      if (t !== GRASS && t !== ROAD) continue;
      let score = houseScore(r,c);
      if (score === 0) continue;
      // Citizens may demolish a path to build on it, but only as a fallback —
      // and the wouldBlockPath check below guarantees movement is never cut off
      if (t === ROAD) score *= 0.4;
      if (wouldBlockCorridor(r,c,th)) continue;
      candidates.push({ r, c, score });
    }
  }
  candidates.sort((a,b) => b.score - a.score);
  for (const { r, c } of candidates.slice(0, 12)) {
    if (wouldBlockPath(r,c)) continue;
    if (!isTHReachable(r,c,th)) continue;
    const onRoad = grid[r][c] === ROAD;
    spendBuildCost(HOUSE, th);
    grid[r][c] = HOUSE;
    clearBuriedResource(r, c);
    registerHouse(r, c, th, HOUSE_POP);
    recordDiscovery(HOUSE);
    showMessage(onRoad ? 'a path was cleared for a house at ' + c + ', ' + r
                       : 'house built at ' + c + ', ' + r);
    return true;
  }
  return false;
}

// Count how many valid building sites remain within the TH's radius.
// Used to decide between building houses and roads. One flood-fill from the TH
// replaces the two per-candidate flood-fills this used to run (it dominated the
// whole sim at ~1s per call in a built-up town). Counting stops at 12.
function thAvailableSpace(th) {
  const LIMIT = 12;
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  const key = (r, c) => r * 1000 + c;
  const visited = new Set();
  const queue = [];
  for (const [dr, dc] of cardinals) {
    const r = th.r + dr, c = th.c + dc;
    if (!inBounds(r, c) || !inLand(r, c)) continue;
    const t = grid[r][c];
    if (t !== GRASS && t !== ROAD && t !== PARK) continue;
    if (visited.has(key(r, c))) continue;
    visited.add(key(r, c));
    queue.push([r, c]);
  }
  let count = 0, head = 0;
  while (head < queue.length) {
    const [r, c] = queue[head++];
    if (grid[r][c] === GRASS
        && Math.abs(r - th.r) <= 20 && Math.abs(c - th.c) <= 20) {
      const hasRoad = cardinals.some(([er, ec]) =>
        inBounds(r+er, c+ec) && grid[r+er][c+ec] === ROAD);
      if (hasRoad && ++count >= LIMIT) return count;
    }
    for (const [dr, dc] of cardinals) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc) || !inLand(nr, nc) || visited.has(key(nr, nc))) continue;
      // Keep the fill inside the TH's neighbourhood (+1 ring so edges connect)
      if (Math.abs(nr - th.r) > 21 || Math.abs(nc - th.c) > 21) continue;
      const t = grid[nr][nc];
      if (t !== GRASS && t !== ROAD && t !== PARK) continue;
      visited.add(key(nr, nc));
      queue.push([nr, nc]);
    }
  }
  return count;
}

// Find a GRASS tile at least 30 tiles (Manhattan) from every existing TH.
function findFoundingSite() {
  for (let attempt = 0; attempt < 200; attempt++) {
    const r = Math.floor(Math.random() * MAP_ROWS);
    const c = Math.floor(Math.random() * MAP_COLS);
    if (!inLand(r, c) || grid[r][c] !== GRASS) continue;
    let farEnough = true;
    for (const eth of townHalls) {
      if (Math.abs(r-eth.r) + Math.abs(c-eth.c) < 30) { farEnough = false; break; }
    }
    if (farEnough) return { r, c };
  }
  return null;
}

// Dispatch a gatherer from th to found a new TH at a remote site. Now only
// used by the player's chartered expeditions — autonomous founding happens in
// the field via tryFoundHere. When chartered=true the resource cost is skipped
// (the player paid gold instead). Returns true if a founder was dispatched.
function tryFoundNewTH(th, chartered = false) {
  if (people.some(p => p.mode === 'found')) return false; // one expedition at a time
  if (!chartered) {
    // A young settlement must not bleed its few citizens into expeditions —
    // auto-founding only kicks in once the town can spare a settler
    if (people.length < 8) return false;
    if (th.resources.wood  < TOWN_HALL_TRIGGER.wood)  return false;
    if (th.resources.stone < TOWN_HALL_TRIGGER.stone) return false;
  }
  const site = findFoundingSite();
  if (!site) return false;
  let best = null, bestDist = Infinity;
  for (const p of people) {
    if (p.job === 'worker' || p.mode === 'explore' || p.mode === 'found') continue;
    const myTH = nearestTownHall(Math.round(p.y), Math.round(p.x));
    if (!myTH || myTH.r !== th.r || myTH.c !== th.c) continue;
    const d = Math.abs(Math.round(p.y)-th.r) + Math.abs(Math.round(p.x)-th.c);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  if (!best) return false;
  if (!chartered) {
    th.resources.wood  -= TOWN_HALL_TRIGGER.wood;
    th.resources.stone -= TOWN_HALL_TRIGGER.stone;
  }
  best.mode        = 'found';
  best.job         = 'founder';
  best.foundTarget = { r: site.r, c: site.c };
  best.gatherTarget = null;
  logEvent('🧭 ' + best.name + ' dispatched to found a town at ' + site.c + ', ' + site.r, 'info');
  return true;
}

// Called when a founding person arrives at their target. Places the new TH.
function placeFoundedTH(p) {
  const fr = p.foundTarget.r, fc = p.foundTarget.c;
  if (inBounds(fr,fc) && grid[fr][fc] === GRASS) {
    grid[fr][fc] = TOWN_HALL;
    clearBuriedResource(fr, fc);
    townHalls.push(makeTownHall(fr, fc));
    recordDiscovery(TOWN_HALL);
    records.townsFounded++;
    addChronicle(p.name + ' founded a new town at ' + fc + ', ' + fr);
    logEvent('🏛 new town hall founded at ' + fc + ', ' + fr, 'good');
    sfx('era');
    updateUI();
  }
  p.mode = 'gather'; p.job = 'gatherer';
  p.foundTarget = null; p.gatherTarget = null;
}

// A gatherer with a full pack, stranded too far from every hall, founds a new
// town on the spot — the frontier settles itself. The home town funds the
// hall (same cost as an expedition); the founder's pack becomes its first stock.
function foundingSiteNear(r, c) {
  for (let radius = 1; radius <= 3; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const nr = r+dr, nc = c+dc;
        if (!inBounds(nr, nc) || !inLand(nr, nc) || grid[nr][nc] !== GRASS) continue;
        if (wouldBlockPath(nr, nc)) continue;
        return { r: nr, c: nc };
      }
    }
  }
  return null;
}

function tryFoundHere(p, r, c) {
  if (people.length < 8) return false; // a young settlement can't split
  const th = nearestTownHall(r, c);
  if (!th) return false;
  if (th.resources.wood  < TOWN_HALL_TRIGGER.wood
   || th.resources.stone < TOWN_HALL_TRIGGER.stone) return false;
  const site = foundingSiteNear(r, c);
  if (!site) return false;
  th.resources.wood  -= TOWN_HALL_TRIGGER.wood;
  th.resources.stone -= TOWN_HALL_TRIGGER.stone;
  grid[site.r][site.c] = TOWN_HALL;
  clearBuriedResource(site.r, site.c);
  const nth = makeTownHall(site.r, site.c);
  for (const k of RES_KINDS) { nth.resources[k] += p[k] || 0; p[k] = 0; }
  townHalls.push(nth);
  recordDiscovery(TOWN_HALL);
  records.townsFounded++;
  grantXP(p, 10);
  p.gatherTarget = null;
  if (p.houseId == null) { p.homeR = r; p.homeC = c; }
  addChronicle(p.name + ' founded a new town at ' + site.c + ', ' + site.r);
  logEvent('🏛 ' + p.name + ' was too far from home to deposit — a new town hall rises at '
    + site.c + ', ' + site.r, 'good');
  sfx('era');
  updateUI();
  return true;
}

// ── Town-hall upgrades ────────────────────────────────────────────────────────
// Halls invest in themselves once the town prospers: era advanced, people
// content, and clay/ore stockpiled. Each level unlocks higher-order buildings.
function tryUpgradeTownHall(th) {
  const lvl = th.level || 1;
  if (lvl >= TH_MAX_LEVEL) return false;
  if (eraIndex < lvl) return false;            // village era → lv2, town era → lv3
  if ((th.happiness ?? 70) < 55) return false; // only thriving towns invest
  const cost = TH_UPGRADE_COSTS[lvl + 1];
  if (!Object.entries(cost).every(([k, v]) => (th.resources[k] || 0) >= v)) return false;
  for (const [k, v] of Object.entries(cost)) th.resources[k] -= v;
  th.level = lvl + 1;
  th.popCap += 5; // a grander hall shelters more settlers
  addChronicle('the town hall at ' + th.c + ', ' + th.r + ' was raised to level ' + th.level);
  logEvent('🏛 the town hall at ' + th.c + ', ' + th.r + ' is now level ' + th.level
    + ' — higher-order buildings unlocked', 'good');
  showBanner('🏛 hall level ' + th.level + ' 🏛');
  sfx('era');
  return true;
}

// ── Happiness relief ──────────────────────────────────────────────────────────
// An unhappy town acts before it empties out: it tears down the factories
// dragging it below contentment (farthest from the hall first), then lays
// parks — which cost nothing — until spirits recover. One act per build cycle.
function thHappinessRelief(th) {
  const happy = th.happiness ?? 70;
  if (happy >= UNHAPPY_BUILD_BELOW) return false;

  // Below the raze threshold, factories (−10 happiness each) come down first
  if (happy < UNHAPPY_RAZE_BELOW) {
    let target = null, targetDist = -1;
    for (let dr = -10; dr <= 10; dr++)
      for (let dc = -10; dc <= 10; dc++) {
        const r = th.r+dr, c = th.c+dc;
        if (!inBounds(r, c) || grid[r][c] !== FACTORY) continue;
        const d = Math.abs(dr) + Math.abs(dc);
        if (d > targetDist) { targetDist = d; target = { r, c }; }
      }
    if (target) {
      demolishTile(target.r, target.c);
      th.votes[FACTORY] = 0;
      addParticles(target.r, target.c, '#616161', 8);
      addChronicle('the unhappy town razed its factory at ' + target.c + ', ' + target.r);
      logEvent('🏭 the town razed its factory at ' + target.c + ', ' + target.r
        + ' — the people demanded relief', 'info');
      sfx('build');
      return true;
    }
  }

  // Parks are free — an unhappy town plants them without waiting for a vote
  let parks = 0;
  for (let dr = -10; dr <= 10; dr++)
    for (let dc = -10; dc <= 10; dc++) {
      if (inBounds(th.r+dr, th.c+dc) && grid[th.r+dr][th.c+dc] === PARK) parks++;
    }
  if (parks >= 6) return false;
  const site = findVotedSiteNear(th, 2, 10);
  if (!site) return false;
  grid[site.r][site.c] = PARK;
  registerBuilding(site.r, site.c, PARK);
  autoAssignWorkers(th);
  recordDiscovery(PARK);
  addParticles(site.r, site.c, '#66bb6a', 6);
  logEvent('🌳 a park was laid at ' + site.c + ', ' + site.r + " to lift the town's spirits", 'good');
  sfx('build');
  return true;
}

// Per-TH autonomous build tick: hall upgrades first, then roads and houses.
// (Founding is no longer dispatched from here — new towns are founded in the
// field, when a full gatherer ends up too far from every hall to deposit.)
function thAutoBuild(th) {
  tryUpgradeTownHall(th);
  // Contentment comes before growth: an unhappy town spends its build cycle
  // on relief — razing factories, laying parks — not on roads and houses.
  if (thHappinessRelief(th)) return;
  const space = thAvailableSpace(th);
  // If there are valid house sites available, prefer houses when population pressure is high,
  // otherwise build roads to open up more sites. Homeless citizens jump the
  // queue: any homelessness means housing comes before everything else.
  const fillRatio = th.popCap > 0 ? people.length / th.popCap : 1;
  if (space > 0 && (homelessCount() > 0 || fillRatio > 0.5)) {
    if (!thHouseStep(th)) {
      // Only fall back to a road when the house failed for lack of a site.
      // If it failed on cost, skip the road — a 1-wood road every cycle
      // would forever eat the 5 wood being saved for the house.
      if (canAffordBuild(HOUSE, th)) thRoadStep(th);
    }
  } else {
    // Low population pressure: only pave when open building sites are actually
    // scarce. (Paving unconditionally here drained every log the town saved
    // into an ever-growing road web — 8 wood a day for a town of three.)
    if (space >= 12) return;
    if (!thRoadStep(th)) thHouseStep(th);
  }
}


function tryUpgradeHousing() {
  // Upgrade threshold drops with housing density: dense areas upgrade sooner.
  // Homeless citizens override the ratios entirely — visible need beats math.
  const cap = globalPopCap();
  if (cap === 0) return;
  const pressureRatio = homelessCount() > 0 ? 1 : people.length / cap;
  const totalHousing = Object.values(houseRegistry).length;
  const upgradeThreshold = totalHousing >= 10 ? 0.50
                         : totalHousing >= 5  ? 0.60
                         : 0.70;
  if (pressureRatio < upgradeThreshold) return;

  for (const th of townHalls) {
    // Scan 21×21 area around each town hall for upgrade candidates
    let localHousing = 0;
    for (let dr = -10; dr <= 10; dr++)
      for (let dc = -10; dc <= 10; dc++) {
        if (!inBounds(th.r+dr, th.c+dc)) continue;
        const t = grid[th.r+dr][th.c+dc];
        if (t === HOUSE || t === ROW_HOUSE || t === APARTMENT) localHousing++;
      }

    // Collect candidates sorted closest to TH first
    const candidates = [];
    for (let dr = -10; dr <= 10; dr++)
      for (let dc = -10; dc <= 10; dc++) {
        const nr = th.r+dr, nc = th.c+dc;
        if (!inBounds(nr, nc)) continue;
        const t = grid[nr][nc];
        if (t === HOUSE || t === ROW_HOUSE)
          candidates.push({ nr, nc, t, dist: Math.abs(dr) + Math.abs(dc) });
      }
    candidates.sort((a, b) => a.dist - b.dist);

    for (const { nr, nc, t } of candidates) {
      if (t === HOUSE && eraIndex >= 1 && localHousing >= 2 && canAffordBuild(ROW_HOUSE, th)) {
        const h = findHouseRegistryEntry(nr, nc);
        if (!h) continue;
        spendBuildCost(ROW_HOUSE, th);
        grid[nr][nc] = ROW_HOUSE;
        th.popCap += (ROW_HOUSE_POP - HOUSE_POP); // net +3
        h.slots = ROW_HOUSE_POP;
        recordDiscovery(ROW_HOUSE);
        showMessage('row house built at ' + nc + ', ' + nr);
        return;
      }

      if (t === ROW_HOUSE && eraIndex >= 2 && (th.level || 1) >= BUILDING_TH_LEVEL[APARTMENT]
          && localHousing >= 3 && canAffordBuild(APARTMENT, th)) {
        const h = findHouseRegistryEntry(nr, nc);
        if (!h) continue;
        spendBuildCost(APARTMENT, th);
        grid[nr][nc] = APARTMENT;
        th.popCap += (APARTMENT_POP - ROW_HOUSE_POP); // net +6
        h.slots = APARTMENT_POP;
        recordDiscovery(APARTMENT);
        showMessage('apartment built at ' + nc + ', ' + nr);
        return;
      }
    }
  }
}


// A building can only be voted for once its trade is researched and the hall
// is grand enough to oversee it.
function canVoteFor(th, type) {
  const rkey = RESEARCH_FOR_TYPE[type];
  if (rkey && !researched.has(rkey)) return false;
  if ((BUILDING_TH_LEVEL[type] || 1) > (th.level || 1)) return false;
  return true;
}

function castVote(th) {
  let localChurches = 0, localParks = 0, localFactories = 0, localHouses = 0, localFarms = 0;
  let localShops = 0, localWells = 0, localSchools = 0, localTreeFarms = 0, localStoneFarms = 0;
  // Happiness-relevant buildings are counted over their full range: votes place
  // up to 12 tiles out and happiness scans ±10. Counting factories only within
  // ±5 let a town vote in factory after factory it couldn't "see" — each one a
  // permanent −10 happiness the vote never accounted for.
  for (let dr = -12; dr <= 12; dr++)
    for (let dc = -12; dc <= 12; dc++) {
      if (!inBounds(th.r+dr, th.c+dc)) continue;
      const t = grid[th.r+dr][th.c+dc];
      if (t === FACTORY) localFactories++;
      if (t === TREE_FARM)  localTreeFarms++;
      if (t === STONE_FARM) localStoneFarms++;
      if (Math.abs(dr) <= 10 && Math.abs(dc) <= 10) {
        if (t === PARK) localParks++;
        if (t === WELL) localWells++;
      }
      if (Math.abs(dr) > 5 || Math.abs(dc) > 5) continue;
      if (t === CHURCH)  localChurches++;
      if (t === HOUSE || t === ROW_HOUSE || t === APARTMENT) localHouses++;
      if (t === FARM)    localFarms++;
      if (t === SHOP)    localShops++;
      if (t === SCHOOL)  localSchools++;
    }

  // People vote for a market when food is plentiful (surplus worth trading)
  const foodTicks = people.length > 0 ? th.resources.food / people.length : 999;

  // Unhappy people vote for relief: parks and wells surge (and their caps
  // rise), while factories get no votes at all until contentment returns.
  const happy   = th.happiness ?? 70;
  const unhappy = happy < UNHAPPY_BUILD_BELOW;
  const parkCap = unhappy ? 6 : 3;
  const wellCap = unhappy ? 2 : 1;

  const w = {
    [CHURCH]:     localChurches >= 2 ? 0 : (localChurches === 0 ? 40 : Math.max(3, 40 - localChurches * 12)),
    [PARK]:       localParks >= parkCap ? 0 : Math.max(foodWeight(th), unhappy ? 60 : 0),
    [FACTORY]:    happy < HAPPY_FACTORY_MIN ? 0
                : localHouses >= 8 && localFactories < 3 ? 30 : localHouses >= 4 ? 2 : 0,
    [TREE_FARM]:  localTreeFarms  < 2 ? woodWeight(th)  : 0,
    [STONE_FARM]: localStoneFarms < 2 ? stoneWeight(th) : 0,
    [FARM]:       localFarms < 3 ? foodWeight(th) : 0,
    [SHOP]:       eraIndex >= 1 && localShops   < 2 && foodTicks > 40  ? 25 : 0,
    [WELL]:       eraIndex >= 1 && localWells < wellCap && localHouses >= 4 ? (unhappy ? 45 : 20) : 0,
    [SCHOOL]:     eraIndex >= 2 && localSchools < 1 && localHouses >= 6 ? 18 : 0,
  };

  // Unresearched trades and buildings above the hall's level get no votes
  for (const key of Object.keys(w)) {
    if (!canVoteFor(th, parseInt(key))) w[key] = 0;
  }

  const total = Object.values(w).reduce((a, b) => a + b, 0);
  if (total === 0) return;
  let rand = Math.random() * total;
  for (const [type, weight] of Object.entries(w)) {
    rand -= weight;
    if (rand <= 0) {
      const intType = parseInt(type);
      th.votes[intType] = (th.votes[intType] || 0) + 1;
      checkVoteThreshold(th);
      return;
    }
  }
}

// Find a site for a voted building near the TH: the nearest grass tile that
// keeps the walkable area connected. If the town is packed solid, fall back to
// repurposing a path tile — citizens will demolish a path to make room, so long
// as everyone can still get around (same connectivity checks apply).
function findVotedSiteNear(th, minR, maxR) {
  for (const allowType of [GRASS, ROAD]) {
    for (let radius = minR; radius <= maxR; radius++) {
      for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
          const r = th.r+dr, c = th.c+dc;
          if (!inBounds(r, c) || !inLand(r, c) || grid[r][c] !== allowType) continue;
          if (wouldBlockPath(r, c) || !isTHReachable(r, c, th)) continue;
          return { r, c, onRoad: allowType === ROAD };
        }
      }
    }
  }
  return null;
}

// When the town has no open site left, the winning vote may redevelop: raze a
// strictly lower-tier building and put the new one in its place. Walkable
// tiles (road/park) are never taken this way — that could sever paths.
function findRedevelopSiteNear(th, newType, minR, maxR) {
  const newTier = BUILDING_TIER[newType] ?? 1;
  for (let radius = minR; radius <= maxR; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const r = th.r+dr, c = th.c+dc;
        if (!inBounds(r, c) || !inLand(r, c)) continue;
        const t = grid[r][c];
        if (t === GRASS || t === ROAD || t === PARK || t === TOWN_HALL) continue;
        if ((BUILDING_TIER[t] ?? 9) >= newTier) continue;
        if (burningTiles[r + ',' + c]) continue;
        return { r, c, oldType: t };
      }
    }
  }
  return null;
}

// With a big housing surplus, an entirely-empty house (no residents) may be
// converted into a voted building of the same or higher tier — the town
// repurposes what it doesn't need instead of sprawling onto open ground.
function findEmptyHouseNear(th, minR, maxR, newType) {
  const newTier = BUILDING_TIER[newType] ?? 1;
  for (let radius = minR; radius <= maxR; radius++) {
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.abs(dr) !== radius && Math.abs(dc) !== radius) continue;
        const r = th.r+dr, c = th.c+dc;
        if (!inBounds(r, c)) continue;
        const t = grid[r][c];
        if (t !== HOUSE && t !== ROW_HOUSE) continue;
        if ((BUILDING_TIER[t] ?? 9) > newTier) continue;
        if (burningTiles[r + ',' + c]) continue;
        const h = findHouseRegistryEntry(r, c);
        if (!h || h.residents.length > 0) continue;
        return { r, c, oldType: t };
      }
    }
  }
  return null;
}

function checkVoteThreshold(th) {
  for (const type of [CHURCH, PARK, FACTORY, TREE_FARM, STONE_FARM, FARM, SHOP, WELL, SCHOOL]) {
    if (!canVoteFor(th, type)) continue;
    // Held factory votes don't fire while the town is unhappy — the relief
    // step would just tear the new factory straight back down.
    if (type === FACTORY && (th.happiness ?? 70) < HAPPY_FACTORY_MIN) continue;
    if ((th.votes[type] || 0) >= VOTE_THRESHOLD) {
      if (canAffordBuild(type, th)) {
        let site = null;
        let razed = null;
        // Housing surplus: ≥30% of beds unfilled (and at least 6) — prefer
        // converting an empty house over taking fresh ground. Uses the
        // physical count: beds unfillable under the population ceiling are
        // still surplus housing worth repurposing.
        const vac = housingVacancy();
        if (vac.surplusRatio >= 0.3 && vac.surplus >= 6) {
          const emptyHome = findEmptyHouseNear(th, 2, 10, type);
          if (emptyHome) {
            razed = 'empty ' + TILE_NAMES[emptyHome.oldType];
            demolishTile(emptyHome.r, emptyHome.c);
            site = { r: emptyHome.r, c: emptyHome.c, onRoad: false };
          }
        }
        if (!site) site = findVotedSiteNear(th, 2, 12);
        if (!site) {
          const redev = findRedevelopSiteNear(th, type, 2, 10);
          if (redev) {
            razed = TILE_NAMES[redev.oldType];
            demolishTile(redev.r, redev.c);
            site = { r: redev.r, c: redev.c, onRoad: false };
          }
        }
        if (site) {
          spendBuildCost(type, th);
          grid[site.r][site.c] = type;
          clearBuriedResource(site.r, site.c);
          if (WORKER_JOBS.has(type)) {
            registerBuilding(site.r, site.c, type);
            autoAssignWorkers(th);
          }
          recordDiscovery(type);
          th.votes[type] = 0;
          logEvent('🔨 ' + TILE_NAMES[type] + ' built at ' + site.c + ', ' + site.r
            + (razed ? ' — the old ' + razed + ' was razed for it (voted)'
             : site.onRoad ? ' — a path was cleared for it (voted)' : ' (voted)'), 'good');
          addParticles(site.r, site.c, '#bcaaa4', 6);
          sfx('build');
        }
      } else {
        // Can't afford it yet — hold the votes at the threshold so the building
        // goes up as soon as resources arrive. (Resetting them deadlocked wood:
        // a tree farm could never win a vote in a wood-starved town.)
        th.votes[type] = VOTE_THRESHOLD;
      }
    }
  }
}

// ── The four soul upgrades: Life · Speed · Sight · Land ───────────────────────

function spendSouls(cost) {
  if (souls < cost) { showMessage('need ' + cost + ' souls!'); return false; }
  souls -= cost;
  sfx('coin');
  return true;
}

function upgradeLifespan() {
  if (lifespanLevel >= MAX_LIFESPAN_UPGRADES) { showMessage('max lifespan reached!'); return; }
  if (!spendSouls(lifespanUpgradeCost())) return;
  lifespanLevel++;
  const newMax = currentMaxAge();
  for (const p of people) p.maxAge = newMax;
  updateUI();
  showMessage('❤️ lifespan increased to ' + Math.round(newMax / DAY_LENGTH) + ' days!');
}

function upgradeSpeed() {
  if (speedLevel >= MAX_SPEED_UPGRADES) { showMessage('max speed reached!'); return; }
  if (!spendSouls(speedUpgradeCost())) return;
  speedLevel++;
  updateUI();
  showMessage('👟 your people walk faster (speed ' + speedLevel + ')');
}

function upgradeSight() {
  if (sightLevel >= MAX_SIGHT_UPGRADES) { showMessage('max sight reached!'); return; }
  if (!spendSouls(sightUpgradeCost())) return;
  sightLevel++;
  updateUI();
  showMessage('👁 your people spot resources ' + (BASE_SIGHT_RADIUS + sightLevel * 3) + ' tiles away');
}

function upgradeLand() {
  if (landLevel >= MAX_LAND_LEVEL) { showMessage('the whole world is already yours!'); return; }
  if (!spendSouls(landUpgradeCost())) return;
  landLevel++;
  const size = landHalf(landLevel) * 2;
  addChronicle('the known world grew to ' + size + '×' + size);
  logEvent('🗺 the known world grows! new land and resources await', 'good');
  showBanner('🗺 the world grows 🗺');
  sfx('era');
  updateUI();
  render();
}

// ── Research (the tree of trades) ─────────────────────────────────────────────

function canResearch(key) { return RESEARCH[key].req.every(r => researched.has(r)); }

function doResearch(key) {
  const node = RESEARCH[key];
  if (!node || researched.has(key)) return;
  if (!canResearch(key)) {
    showMessage('requires ' + node.req.filter(r => !researched.has(r)).join(' + '));
    return;
  }
  if (!spendSouls(node.cost)) return;
  researched.add(key);
  addChronicle('the people learned ' + node.name);
  logEvent('🔬 ' + node.name + ' researched — ' + node.desc, 'good');
  sfx('era');
  updateUI();
}

// Builds the research buttons once, then refreshes their state on every call
function renderResearch() {
  const list = document.getElementById('research-list');
  if (!list) return;
  if (!list.dataset.built) {
    list.dataset.built = '1';
    for (const tier of RESEARCH_TIERS) {
      const row = document.createElement('div');
      row.className = 'research-tier';
      for (const key of tier) {
        const btn = document.createElement('button');
        btn.className = 'action-btn research-btn';
        btn.dataset.key = key;
        btn.title = RESEARCH[key].desc;
        btn.addEventListener('click', () => doResearch(key));
        row.appendChild(btn);
      }
      list.appendChild(row);
    }
  }
  for (const btn of list.querySelectorAll('.research-btn')) {
    const key = btn.dataset.key;
    const node = RESEARCH[key];
    btn.classList.toggle('done', researched.has(key));
    if (researched.has(key)) {
      btn.textContent = node.emoji + ' ' + node.name + ' ✓';
      btn.disabled = true;
    } else if (!canResearch(key)) {
      btn.textContent = node.emoji + ' ' + node.name + ' 🔒 '
        + node.req.filter(r => !researched.has(r)).join(' + ');
      btn.disabled = true;
    } else {
      btn.textContent = node.emoji + ' ' + node.name + ' (✨' + node.cost + ')';
      btn.disabled = souls < node.cost;
    }
  }
}

function houseSpawnPeople() {
  const cap = globalPopCap();
  if (people.length >= cap) return;
  // Empty homes attract families: births scale up to 3× when beds are plentiful
  const vacancyBoost = 1 + 2 * housingVacancy().ratio;
  for (const [id, h] of Object.entries(houseRegistry)) {
    if (people.length >= cap) return;
    if (h.residents.length >= h.slots) continue; // house full
    const th = nearestTownHall(h.r, h.c);
    // Birth rate scales with local happiness; festivals triple it.
    // Kept modest so the player's spawn waves stay the main population lever.
    let spawnChance = 0.0015 * ((th ? th.happiness ?? 70 : 70) / 50) * vacancyBoost;
    if (th && (th.festivalUntil || 0) > simTick) spawnChance *= 3;
    if (Math.random() > spawnChance) continue;
    const site = findGrassSiteNear(h.r, h.c, 1, 2);
    if (site) {
      const p = spawnPersonFree(site.r, site.c, Number(id));
      if (p) {
        records.totalBirths++;
        logEvent('👶 ' + p.name + ' was born', 'good');
        sfx('birth');
      }
    }
  }
}

// ── Happiness ─────────────────────────────────────────────────────────────────

function computeTHHappiness(th) {
  let parks = 0, factories = 0, wells = 0;
  for (let dr = -10; dr <= 10; dr++)
    for (let dc = -10; dc <= 10; dc++) {
      if (!inBounds(th.r+dr, th.c+dc)) continue;
      const t = grid[th.r+dr][th.c+dc];
      if (t === PARK)         parks++;
      else if (t === FACTORY) factories++;
      else if (t === WELL)    wells++;
    }
  let h = 70 + parks * 5 + wells * 3 - factories * 10;
  // Homelessness weighs on the whole town
  let homelessHere = 0;
  for (const p of people) {
    if (p.houseId != null || p.mode === 'explore' || p.mode === 'found') continue;
    if (nearestTownHall(Math.round(p.y), Math.round(p.x)) === th) homelessHere++;
  }
  h -= Math.min(20, homelessHere * 2);
  const ticksLeft = people.length > 0 ? th.resources.food / people.length : 99;
  if      (ticksLeft < 5)  h -= 30; // hungry town
  else if (ticksLeft < 15) h -= 10;
  else if (ticksLeft > 30) h += 15; // well fed
  if ((th.festivalUntil || 0) > simTick) h += 20;
  return clamp(Math.round(h), 0, 100);
}

function refreshHappiness() {
  for (const th of townHalls) th.happiness = computeTHHappiness(th);
}

function globalHappiness() {
  if (townHalls.length === 0) return 100;
  let sum = 0, weight = 0;
  for (const th of townHalls) {
    const w = th.popCap + 1;
    sum += (th.happiness ?? 70) * w;
    weight += w;
  }
  return Math.round(sum / weight);
}

// Unhappy towns (below 40%) slowly lose citizens
function emigrationTick() {
  if (people.length <= 3) return;
  for (const p of [...people]) {
    if (p.mode === 'found' || p.mode === 'explore') continue;
    const th = nearestTownHall(Math.round(p.y), Math.round(p.x));
    if (!th || (th.happiness ?? 70) >= 40) continue;
    if (Math.random() < 0.004) {
      removePerson(p);
      logEvent('🧳 ' + p.name + ' left town in search of a better life', 'bad');
    }
  }
}

// ── Random events ─────────────────────────────────────────────────────────────

function wellNear(r, c) {
  for (let dr = -6; dr <= 6; dr++)
    for (let dc = -6; dc <= 6; dc++) {
      if (inBounds(r+dr, c+dc) && grid[r+dr][c+dc] === WELL) return true;
    }
  return false;
}

const FLAMMABLE = new Set([HOUSE, ROW_HOUSE, APARTMENT, FARM, TREE_FARM]);

function igniteTile(r, c) {
  const key = r + ',' + c;
  if (burningTiles[key]) return false;
  burningTiles[key] = { r, c, ticksLeft: 20 };
  return true;
}

function fireTick() {
  const keys = Object.keys(burningTiles);
  if (keys.length === 0) {
    if (fireActive) {
      fireActive = false;
      records.firesSurvived++;
      logEvent('🔥 the fire has burned out', 'info');
    }
    return;
  }
  fireActive = true;
  for (const key of keys) {
    const b = burningTiles[key];
    if (!b) continue;
    b.ticksLeft--;
    // Spread to adjacent flammable tiles every few ticks
    if (b.ticksLeft % 5 === 0) {
      for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nr = b.r+dr, nc = b.c+dc;
        if (!inBounds(nr, nc) || !FLAMMABLE.has(grid[nr][nc])) continue;
        let chance = 0.35;
        if (wellNear(nr, nc)) chance *= 0.3;
        if (Math.random() < chance) igniteTile(nr, nc);
      }
    }
    if (b.ticksLeft <= 0) {
      addParticles(b.r, b.c, '#616161', 8); // smoke
      demolishTile(b.r, b.c);               // burns to the ground
      delete burningTiles[key];
      logEvent('🔥 building at ' + b.c + ', ' + b.r + ' burned down', 'bad');
    }
  }
}

function eventsTick() {
  const season = currentSeason();

  // House fires — more likely in summer, rarer near wells
  const houseList = Object.values(houseRegistry);
  if (houseList.length > 0 && Object.keys(burningTiles).length === 0) {
    let chance = 0.00005 * Math.min(houseList.length, 60);
    if (season === 'summer') chance *= 2;
    if (season === 'winter') chance *= 0.5;
    if (Math.random() < chance) {
      const h = houseList[Math.floor(Math.random() * houseList.length)];
      if (!(wellNear(h.r, h.c) && Math.random() < 0.75)) {
        if (igniteTile(h.r, h.c)) {
          addChronicle('fire broke out at ' + h.c + ', ' + h.r);
          logEvent('🔥 FIRE at ' + h.c + ', ' + h.r + '! demolish around it to stop the spread', 'bad');
          sfx('fire');
        }
      }
    }
  }

  // Disease — strikes crowded, unhappy towns
  if (people.length >= 20 && globalHappiness() < 55 && !people.some(p => p.sick)
      && Math.random() < 0.0004) {
    let n = 0;
    for (const p of people) {
      if (Math.random() < 0.25) { p.sick = true; p.sickTicks = DAY_LENGTH; n++; }
    }
    if (n > 0) {
      addChronicle('sickness swept through the town (' + n + ' fell ill)');
      logEvent('🤒 sickness is spreading — ' + n + ' people fell ill', 'bad');
      sfx('bad');
    }
  }

  // Bumper harvest — autumn only
  if (season === 'autumn' && Math.random() < 0.001) {
    let placed = 0;
    for (let r = 0; r < MAP_ROWS && placed < 6; r++) {
      for (let c = 0; c < MAP_COLS && placed < 6; c++) {
        if ((grid[r][c] === FARM || grid[r][c] === PARK) && Math.random() < 0.5) {
          const site = findGrassSiteNear(r, c, 1, 3);
          if (site && !resourceMap[site.r][site.c]) {
            resourceMap[site.r][site.c] = { type: 'food', amount: 10 + Math.floor(Math.random() * 8) };
            placed++;
          }
        }
      }
    }
    if (placed > 0) logEvent('🌾 bumper harvest! ' + placed + ' food caches appeared', 'good');
  }

  // Migrants — drawn to happy towns with room to spare
  if (globalHappiness() >= 75 && people.length >= 5 && people.length < globalPopCap()
      && Math.random() < 0.0006) {
    const th = townHalls[Math.floor(Math.random() * townHalls.length)];
    const n = 2 + Math.floor(Math.random() * 2);
    let arrived = 0;
    for (let i = 0; i < n; i++) {
      const site = findGrassSiteNear(th.r, th.c, 3, 8);
      if (site && spawnPersonFree(site.r, site.c)) arrived++;
    }
    if (arrived > 0) {
      logEvent('🚶 ' + arrived + ' migrants arrived, drawn by your happy town', 'good');
      sfx('birth');
    }
  }
}

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

// ── Gold powers ───────────────────────────────────────────────────────────────

function payRoad(r, c) {
  if (!inLand(r, c))                 { logEvent('cannot pave the wilderness — expand your land first'); return; }
  if (grid[r][c] !== GRASS)          { logEvent('can only pave over grass'); return; }
  if (gold < POWER_COSTS.road)       { logEvent('need $' + POWER_COSTS.road + ' to pave'); return; }
  // Roads are walkable — paving can never block a path, so no check needed
  gold -= POWER_COSTS.road;
  grid[r][c] = ROAD;
  recordDiscovery(ROAD);
  sfx('build');
  updateUI();
}

function dropSupplies(r, c, type) {
  if (!inLand(r, c))           { logEvent('supplies cannot land in the wilderness'); return; }
  if (grid[r][c] !== GRASS)    { logEvent('supplies must land on grass'); return; }
  if (resourceMap[r][c])       { logEvent('there is already something here'); return; }
  if (gold < POWER_COSTS.drop) { logEvent('need $' + POWER_COSTS.drop + ' for a supply drop'); return; }
  gold -= POWER_COSTS.drop;
  resourceMap[r][c] = { type, amount: DROP_AMOUNT };
  addParticles(r, c, RES_COLORS[type] || '#ffee58', 6);
  logEvent('📦 ' + DROP_AMOUNT + ' ' + type + ' dropped at ' + c + ', ' + r, 'info');
  sfx('coin');
  updateUI();
}

function startFestival() {
  const th = townHalls[selectedTHIndex];
  if (!th)                              { logEvent('no town hall yet'); return; }
  if ((th.festivalUntil || 0) > simTick) { logEvent('a festival is already underway!'); return; }
  if (gold < POWER_COSTS.festival)      { logEvent('need $' + POWER_COSTS.festival + ' for a festival'); return; }
  gold -= POWER_COSTS.festival;
  th.festivalUntil = simTick + FESTIVAL_LENGTH;
  addChronicle('a festival was held at ' + th.c + ', ' + th.r);
  logEvent('🎪 festival! +happiness and births near this town hall for one day', 'good');
  sfx('era');
  updateUI();
}

function charterExpedition() {
  const th = townHalls[selectedTHIndex];
  if (!th)                          { logEvent('no town hall yet'); return; }
  if (gold < POWER_COSTS.charter)   { logEvent('need $' + POWER_COSTS.charter + ' to charter an expedition'); return; }
  if (tryFoundNewTH(th, true)) {
    gold -= POWER_COSTS.charter;
    sfx('coin');
  } else {
    logEvent('no settler or founding site available (expedition already out?)');
  }
  updateUI();
}

function swayVote(type) {
  const th = townHalls[selectedTHIndex];
  if (!th)                       { logEvent('no town hall yet'); return; }
  if (gold < POWER_COSTS.sway)   { logEvent('need $' + POWER_COSTS.sway + ' to sway votes'); return; }
  if ((type === SHOP || type === WELL) && eraIndex < 1) { logEvent('unlocks in the village era'); return; }
  if (type === SCHOOL && eraIndex < 2)                  { logEvent('unlocks in the town era'); return; }
  const rkey = RESEARCH_FOR_TYPE[type];
  if (rkey && !researched.has(rkey)) { logEvent('requires ' + RESEARCH[rkey].name + ' research'); return; }
  if ((BUILDING_TH_LEVEL[type] || 1) > (th.level || 1)) {
    logEvent('requires a level ' + BUILDING_TH_LEVEL[type] + ' town hall'); return;
  }
  gold -= POWER_COSTS.sway;
  th.votes[type] = (th.votes[type] || 0) + SWAY_VOTES;
  logEvent('🗳 +' + SWAY_VOTES + ' votes for ' + TILE_NAMES[type], 'info');
  sfx('coin');
  checkVoteThreshold(th);
  updateUI();
}

// ── Simulation tick ───────────────────────────────────────────────────────────

function schoolNear(r, c) {
  for (let dr = -8; dr <= 8; dr++)
    for (let dc = -8; dc <= 8; dc++) {
      if (inBounds(r+dr, c+dc) && grid[r+dr][c+dc] === SCHOOL) return true;
    }
  return false;
}

function workerTick() {
  const winter = currentSeason() === 'winter';
  const byId = new Map(people.map(p => [p.id, p]));
  for (const [, entry] of Object.entries(buildingRegistry)) {
    if (entry.workers.length === 0) continue;
    const th = nearestTownHall(entry.r, entry.c);
    if (!th) continue;
    // Happy citizens work harder (0.5×–1.5×); schools add 30%
    const nearSchool = schoolNear(entry.r, entry.c);
    let mult = 0.5 + (th.happiness ?? 70) / 100;
    if (nearSchool) mult *= 1.3;

    // Working is how citizens learn a trade
    for (const pid of entry.workers) {
      const wp = byId.get(pid);
      if (wp) grantXP(wp, 0.25, nearSchool);
    }

    if (entry.type === SHOP) {
      // Market: each worker trades 1 food for $2
      const trades = Math.min(entry.workers.length, Math.floor(th.resources.food));
      if (trades > 0) {
        th.resources.food -= trades;
        gold += trades * 2 * mult;
      }
      continue;
    }
    if (entry.type === FARM && winter) continue; // fields are frozen

    const out = WORKER_OUTPUT[entry.type];
    if (!out) continue;
    for (const [resource, amount] of Object.entries(out)) {
      const total = amount * entry.workers.length * mult;
      if (resource === 'gold') gold += total;
      else th.resources[resource] = (th.resources[resource] || 0) + total;
    }
  }
}

// Dynamic staffing caps: production buildings wind down as their stockpile
// grows, freeing citizens to gather whatever the town actually needs.
function neededWorkerCap(th, type) {
  if (type === FARM) {
    // How many ticks of food remain per person in this TH?
    const ticksLeft = (th.resources.food || 0) / (people.length || 1);
    if (ticksLeft >= 30) return 0;
    if (ticksLeft >= 20) return 1;
    if (ticksLeft >= 10) return 2;
    return MAX_WORKERS_PER_BUILDING;
  }
  if (type === TREE_FARM || type === STONE_FARM) {
    const res   = type === TREE_FARM ? 'wood' : 'stone';
    const other = type === TREE_FARM ? 'stone' : 'wood';
    const amt = th.resources[res] || 0;
    // A large pile, or a big lead over the sister resource → stop staffing
    if (amt >= 200 || amt > (th.resources[other] || 0) * 3 + 60) return 0;
    if (amt >= 100) return 1;
    if (amt >= 40)  return 2;
    return MAX_WORKERS_PER_BUILDING;
  }
  return MAX_WORKERS_PER_BUILDING;
}

function autoAssignWorkers(th) {
  // Workers keep day hours: dusk releases everyone, and no one is conscripted
  // back (or pulled out of bed) until the dawn assignment.
  if (!timeOfDay().isDay) return;
  for (const [, entry] of Object.entries(buildingRegistry)) {
    if (!WORKER_JOBS.has(entry.type)) continue;
    const closestTH = nearestTownHall(entry.r, entry.c);
    if (!closestTH || closestTH.r !== th.r || closestTH.c !== th.c) continue;
    const cap = neededWorkerCap(th, entry.type);
    // Release excess workers once the need has passed
    while (entry.workers.length > cap) {
      const pid = entry.workers[entry.workers.length - 1];
      const p = people.find(q => q.id === pid);
      if (p) unassignWorker(p);
      else entry.workers.pop();
    }
    while (entry.workers.length < cap) {
      let best = null, bestDist = Infinity, free = 0;
      for (const p of people) {
        if (p.job === 'worker' || p.mode === 'explore' || p.mode === 'found') continue;
        // Factories need skilled hands
        if (entry.type === FACTORY && (p.level || 0) < FACTORY_LEVEL) continue;
        const pr = Math.round(p.y), pc = Math.round(p.x);
        const myTH = nearestTownHall(pr, pc);
        if (!myTH || myTH.r !== th.r || myTH.c !== th.c) continue;
        free++;
        const d = Math.abs(pr - entry.r) + Math.abs(pc - entry.c);
        if (d < bestDist) { bestDist = d; best = p; }
      }
      // Never conscript the last free citizens — someone must gather and haul
      if (!best || free <= 2) break;
      assignWorker(best, entry.r, entry.c);
    }
  }
}

function findSocialTarget(r, c) {
  const SOCIAL_TILES = new Set([PARK, CHURCH, TOWN_HALL]);
  let best = null, bestDist = Infinity;
  for (let dr = -20; dr <= 20; dr++) {
    for (let dc = -20; dc <= 20; dc++) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc) || !SOCIAL_TILES.has(grid[nr][nc])) continue;
      for (const [er, ec] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const ar = nr + er, ac = nc + ec;
        if (!inBounds(ar, ac) || !inLand(ar, ac)) continue;
        const at = grid[ar][ac];
        if (at !== GRASS && at !== ROAD && at !== PARK) continue;
        const d = Math.abs(dr) + Math.abs(dc);
        if (d < bestDist) { bestDist = d; best = { r: ar, c: ac }; }
        break;
      }
    }
  }
  return best;
}

function applyTimeOfDay() {
  const { tickInDay } = timeOfDay();

  // Dusk (9pm): workers leave buildings, everyone enters evening social mode
  if (tickInDay === HOUR_DUSK * 4) {
    for (const p of [...people]) {
      if (p.job === 'worker') unassignWorker(p);
    }
    for (const p of people) {
      if (p.sleeping) continue;
      if (p.mode === 'found' || p.mode === 'explore') continue; // missions travel through the night
      p.mode = 'social';
      p.socialTarget = null; // will be recomputed in movePerson
      p.gatherTarget = null;
    }
  }

  // Midnight (tick 0 of each day): everyone goes home to sleep
  if (tickInDay === 0 && simTick > 0) {
    for (const p of people) {
      if (p.sleeping) continue;
      if (p.mode === 'found' || p.mode === 'explore') continue;
      p.sleeping = true;
      p.mode = 'home';
      p.gatherTarget = null;
    }
  }

  // Dawn (7am): everyone wakes, workers are reassigned for the day
  if (tickInDay === HOUR_DAWN * 4) {
    for (const p of people) {
      p.sleeping = false;
      p.insideBuilding = false; // emerge from house at dawn
      if (p.mode === 'home' || p.mode === 'social') p.mode = 'gather';
    }
    for (const th of townHalls) autoAssignWorkers(th);
  }
}

function farmProduceFood() {
  if (currentSeason() === 'winter') return; // fields are frozen — stockpile ahead!
  // Every farm has a registry entry (built via votes; reconciled on load),
  // so iterate the registry instead of scanning all 10,000 tiles each tick.
  for (const entry of Object.values(buildingRegistry)) {
    if (entry.type !== FARM) continue;
    if (entry.workers.length > 0) continue; // workerTick() handles staffed farms
    const th = nearestTownHall(entry.r, entry.c);
    if (th) th.resources.food++;
  }
}

const SEASON_NOTES = {
  spring: '🌱 spring — the land grows green again',
  summer: '☀️ summer — beware of fires',
  autumn: '🍂 autumn — harvest season',
  winter: '❄️ winter — the farms freeze over',
};

function simulationTick() {
  simTick++;
  agePeople();
  consumeFood();
  applyTimeOfDay();
  workerTick();
  farmProduceFood();
  movePeople();
  gatherResources();
  depositResources();
  for (const th of townHalls) {
    th.buildTimer = (th.buildTimer || 0) - 1;
    if (th.buildTimer <= 0) {
      thAutoBuild(th);
      th.buildTimer = TH_BUILD_INTERVAL;
    }
  }
  tryUpgradeHousing();
  houseSpawnPeople();
  fireTick();
  eventsTick();
  updateParticles();
  if (simTick % SEASON_LENGTH === 0 && townHalls.length > 0)
    logEvent(SEASON_NOTES[currentSeason()], 'info');
  if (simTick % 8 === 0) {
    rehouseHomeless();
    refreshHappiness();
    emigrationTick();
    recordHistory();
  }
  if (simTick % 50  === 0) for (const th of townHalls) autoAssignWorkers(th);
  if (simTick % 100 === 0) regenerateResources();
  updateRecordsAndEra();
  if (followSelected) followCamera();
  updateUIThrottled();
  render();
}

// ── Simulation speed control ───────────────────────────────────────────────
let simIntervalId = setInterval(simulationTick, SIM_INTERVAL);

function setSimSpeed(value) {
  // value: 0 = paused, 1–10 = multiplier (1× = 250ms, 10× = 25ms)
  clearInterval(simIntervalId);
  simIntervalId = null;
  if (value > 0) {
    simIntervalId = setInterval(simulationTick, Math.round(SIM_INTERVAL / value));
  }
  const label = document.getElementById('speed-label');
  if (label) label.textContent = value === 0 ? 'paused' : value + '×';
}

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
  const jobCounts = { founder: 0, gatherer: 0, explorer: 0, worker: 0, idle: 0 };
  for (const p of people) jobCounts[p.job] = (jobCounts[p.job] || 0) + 1;
  document.getElementById('job-founder').textContent  = jobCounts.founder;
  document.getElementById('job-gatherer').textContent = jobCounts.gatherer;
  document.getElementById('job-explorer').textContent = jobCounts.explorer;
  document.getElementById('job-worker').textContent   = jobCounts.worker;
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

  // Minimap & trend graphs (throttled — they redraw whole canvases)
  if (uiTickCounter % 4 === 1) drawMinimap();
  if (uiTickCounter % 8 === 1) drawTrends();
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

// ── Pixel-art draw functions (all authored at 32×32, origin at top-left) ──────

// Grass shifts colour with the seasons: [base, light tufts, dark tufts]
const GRASS_PALETTES = {
  spring: ['#4caf50', '#66bb6a', '#388e3c'],
  summer: ['#66a94c', '#85c162', '#4a8a38'],
  autumn: ['#94964a', '#adaf62', '#6e7136'],
  winter: ['#cfd8dc', '#eceff1', '#a7bcc4'],
};

function grassPalette() { return GRASS_PALETTES[currentSeason()]; }

function drawGrass(x, y) {
  const pal = grassPalette();
  ctx.fillStyle = pal[0]; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = pal[1];
  ctx.fillRect(x+4,  y+6,  4, 4);
  ctx.fillRect(x+20, y+14, 4, 4);
  ctx.fillRect(x+10, y+22, 4, 4);
  ctx.fillStyle = pal[2];
  ctx.fillRect(x+14, y+4,  2, 2);
  ctx.fillRect(x+26, y+18, 2, 2);
  ctx.fillRect(x+6,  y+27, 2, 2);
}

function drawWell(x, y) {
  const pal = grassPalette();
  ctx.fillStyle = pal[0]; ctx.fillRect(x, y, BASE, BASE);
  // Stone ring
  ctx.fillStyle = '#90a4ae';
  ctx.fillRect(x+8,  y+14, 16, 12);
  ctx.fillStyle = '#78909c';
  ctx.fillRect(x+8,  y+24, 16, 2);
  // Water
  ctx.fillStyle = '#4fc3f7';
  ctx.fillRect(x+11, y+16, 10, 7);
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+12, y+17, 4, 2);
  // Posts and little roof
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+8,  y+6, 2, 10);
  ctx.fillRect(x+22, y+6, 2, 10);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+6,  y+4, 20, 3);
  ctx.fillStyle = '#6d4c41';
  ctx.fillRect(x+10, y+7, 12, 1); // crossbar
  // Bucket rope
  ctx.fillStyle = '#3e2723';
  ctx.fillRect(x+15, y+7, 1, 6);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+13, y+12, 5, 3);
}

function drawSchool(x, y) {
  // Red schoolhouse with a bell tower
  ctx.fillStyle = '#c62828'; ctx.fillRect(x+2, y+12, 28, 18);
  // Roof
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+4,  y+8,  24, 4);
  ctx.fillRect(x+8,  y+6,  16, 2);
  // Bell tower
  ctx.fillStyle = '#efebe9';
  ctx.fillRect(x+13, y+0,  6, 8);
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+12, y+0,  8, 2);
  ctx.fillStyle = '#ff8f00'; // bell
  ctx.fillRect(x+15, y+3,  2, 3);
  // Windows
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+5,  y+16, 6, 6);
  ctx.fillRect(x+21, y+16, 6, 6);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+16, 2, 6);
  ctx.fillRect(x+23, y+16, 2, 6);
  // Door
  ctx.fillStyle = '#4e342e'; ctx.fillRect(x+13, y+22, 6, 8);
  // Chalkboard sign
  ctx.fillStyle = '#fff'; ctx.fillRect(x+13, y+14, 6, 4);
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

function drawRowHouse(x, y) {
  // Terracotta two-unit terrace
  ctx.fillStyle = '#e57373'; ctx.fillRect(x+2, y+14, 28, 16); // walls
  // Left unit roof
  ctx.fillStyle = '#b71c1c';
  ctx.fillRect(x+2,  y+8,  2,  6);
  ctx.fillRect(x+4,  y+6,  10, 2);
  ctx.fillRect(x+4,  y+8,  10, 6);
  ctx.fillRect(x+14, y+10, 2,  4);
  // Right unit roof
  ctx.fillRect(x+16, y+8,  2,  6);
  ctx.fillRect(x+18, y+6,  10, 2);
  ctx.fillRect(x+18, y+8,  10, 6);
  // Party wall line
  ctx.fillStyle = '#c62828'; ctx.fillRect(x+15, y+8, 2, 22);
  // Windows
  ctx.fillStyle = '#b3e5fc';
  ctx.fillRect(x+4,  y+18, 6, 5);
  ctx.fillRect(x+22, y+18, 6, 5);
  ctx.fillStyle = '#1565c0';
  ctx.fillRect(x+7,  y+18, 1, 5);
  ctx.fillRect(x+25, y+18, 1, 5);
  // Doors
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+6,  y+24, 4, 6);
  ctx.fillRect(x+22, y+24, 4, 6);
}

function drawApartment(x, y) {
  // Grey multi-storey block with window grid
  ctx.fillStyle = '#7e57c2'; ctx.fillRect(x+2, y+4, 28, 26); // main block
  ctx.fillStyle = '#512da8'; ctx.fillRect(x+2, y+2, 28, 4);  // parapet
  // Roof details
  ctx.fillStyle = '#9575cd';
  ctx.fillRect(x+4,  y+0, 4, 4);
  ctx.fillRect(x+14, y+0, 4, 4);
  ctx.fillRect(x+24, y+0, 4, 4);
  // Window grid — 3 columns × 3 rows
  ctx.fillStyle = '#e1f5fe';
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      ctx.fillRect(x+4 + col*9, y+7 + row*7, 6, 4);
    }
  }
  // Window dividers
  ctx.fillStyle = '#4527a0';
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      ctx.fillRect(x+7 + col*9, y+7 + row*7, 1, 4);
    }
  }
  // Door
  ctx.fillStyle = '#4a148c'; ctx.fillRect(x+13, y+24, 6, 6);
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

function drawTreeFarm(x, y) {
  // Brown soil base
  ctx.fillStyle = '#795548'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#6d4c41';
  ctx.fillRect(x+1, y+20, 30, 12);
  // Row lines in soil
  ctx.fillStyle = '#5d4037';
  ctx.fillRect(x+2, y+24, 28, 1);
  ctx.fillRect(x+2, y+28, 28, 1);
  // Three small trees
  // Tree trunks
  ctx.fillStyle = '#4e342e';
  ctx.fillRect(x+4,  y+14, 2, 7);
  ctx.fillRect(x+15, y+12, 2, 9);
  ctx.fillRect(x+26, y+14, 2, 7);
  // Tree canopies
  ctx.fillStyle = '#2e7d32';
  ctx.fillRect(x+1,  y+6,  8, 9);
  ctx.fillRect(x+12, y+4,  8, 9);
  ctx.fillRect(x+23, y+6,  8, 9);
  ctx.fillStyle = '#43a047';
  ctx.fillRect(x+2,  y+7,  6, 6);
  ctx.fillRect(x+13, y+5,  6, 6);
  ctx.fillRect(x+24, y+7,  6, 6);
}

function drawStoneFarm(x, y) {
  // Dark ground base
  ctx.fillStyle = '#546e7a'; ctx.fillRect(x, y, BASE, BASE);
  ctx.fillStyle = '#455a64';
  ctx.fillRect(x+1, y+18, 30, 13);
  // Quarry lines
  ctx.fillStyle = '#37474f';
  ctx.fillRect(x+2, y+22, 28, 1);
  ctx.fillRect(x+2, y+26, 28, 1);
  // Stone blocks arranged in cluster
  ctx.fillStyle = '#90a4ae';
  ctx.fillRect(x+3,  y+5,  10, 10);
  ctx.fillRect(x+19, y+7,  10, 10);
  ctx.fillRect(x+11, y+10, 8,  8);
  ctx.fillStyle = '#b0bec5';
  ctx.fillRect(x+4,  y+6,  5, 5);
  ctx.fillRect(x+20, y+8,  5, 5);
  ctx.fillRect(x+12, y+11, 4, 4);
  // Chisel marks
  ctx.fillStyle = '#78909c';
  ctx.fillRect(x+6,  y+8,  2, 1);
  ctx.fillRect(x+21, y+10, 2, 1);
}

function drawFarm(x, y) {
  // Golden field base
  ctx.fillStyle = '#f9a825'; ctx.fillRect(x, y, BASE, BASE);
  // Ploughed soil rows
  ctx.fillStyle = '#8d6e63';
  ctx.fillRect(x+1, y+18, 30, 13);
  ctx.fillStyle = '#795548';
  ctx.fillRect(x+2, y+21, 28, 1);
  ctx.fillRect(x+2, y+24, 28, 1);
  ctx.fillRect(x+2, y+27, 28, 1);
  // Wheat stalks (3 clusters)
  ctx.fillStyle = '#f57f17';
  ctx.fillRect(x+4,  y+10, 2, 9);
  ctx.fillRect(x+15, y+8,  2, 11);
  ctx.fillRect(x+26, y+10, 2, 9);
  // Wheat heads
  ctx.fillStyle = '#ffee58';
  ctx.fillRect(x+3,  y+6,  4, 5);
  ctx.fillRect(x+14, y+4,  4, 5);
  ctx.fillRect(x+25, y+6,  4, 5);
  ctx.fillStyle = '#fff9c4';
  ctx.fillRect(x+4,  y+7,  2, 3);
  ctx.fillRect(x+15, y+5,  2, 3);
  ctx.fillRect(x+26, y+7,  2, 3);
}

// ── Tile & entity renderers ────────────────────────────────────────────────────

function drawTile(r, c, x, y, ts) {
  // Locked wilderness: dark forest, no grid stroke — a wall of unknown
  if (!inLand(r, c)) {
    ctx.fillStyle = '#22321f';
    ctx.fillRect(x, y, ts, ts);
    if (ts > 12) {
      const h = ((r * 2654435761) ^ (c * 40503)) >>> 0;
      ctx.fillStyle = '#1b2a19';
      const s = Math.max(2, Math.floor(ts / 5));
      ctx.fillRect(x + (h % 5) * ts / 8,        y + ((h >> 3) % 5) * ts / 8,        s, s);
      ctx.fillRect(x + ((h >> 6) % 5) * ts / 8, y + ((h >> 9) % 5) * ts / 8,        s, s);
      ctx.fillStyle = '#2a3d26';
      ctx.fillRect(x + ((h >> 12) % 6) * ts / 8, y + ((h >> 15) % 6) * ts / 8, Math.max(1, s - 1), Math.max(1, s - 1));
    }
    return;
  }
  if (ts <= 12) {
    const t = grid[r][c];
    ctx.fillStyle = t === GRASS ? grassPalette()[0] : (TILE_COLORS[t] || TILE_COLORS[0]);
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
      case TOWN_HALL:  drawTownHall(0, 0);  break;
      case TREE_FARM:  drawTreeFarm(0, 0);  break;
      case STONE_FARM: drawStoneFarm(0, 0); break;
      case FARM:       drawFarm(0, 0);       break;
      case ROW_HOUSE:  drawRowHouse(0, 0);  break;
      case APARTMENT:  drawApartment(0, 0); break;
      case WELL:       drawWell(0, 0);      break;
      case SCHOOL:     drawSchool(0, 0);    break;
    }
    ctx.restore();
    // Level pips on upgraded town halls
    if (grid[r][c] === TOWN_HALL) {
      const th = townHalls.find(t2 => t2.r === r && t2.c === c);
      const lvl = th ? (th.level || 1) : 1;
      if (lvl > 1) {
        ctx.fillStyle = '#ffd54f';
        const s = Math.max(2, Math.floor(ts / 10));
        for (let i = 0; i < lvl; i++) ctx.fillRect(x + 2 + i * (s + 2), y + 2, s, s);
      }
    }
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
      if (!inBounds(r, c) || !inLand(r, c)) continue; // wilderness hides its riches
      const res = resourceMap[r][c];
      if (!res) continue;
      const { x, y } = tileToCanvas(r, c);
      const iconS = Math.max(3, Math.floor(tileSize * 0.25));
      const iconX = x + tileSize - iconS - 1;
      const iconY = y + tileSize - iconS - 1;
      ctx.fillStyle = RES_COLORS[res.type] || '#f9a825';
      ctx.fillRect(iconX, iconY, iconS, iconS);
    }
  }
}

function drawPeople() {
  for (const p of people) {
    if (p.insideBuilding) continue; // workers are hidden inside their building
    const { x: px, y: py } = tileToCanvas(p.y, p.x);
    if (px < -tileSize || px > canvas.width  + tileSize) continue;
    if (py < -tileSize || py > canvas.height + tileSize) continue;

    const carried = carriedTotal(p);

    // Selection ring around the inspected citizen
    if (p.id === selectedPersonId) {
      ctx.strokeStyle = '#ffee58';
      ctx.lineWidth = 2;
      ctx.strokeRect(px + 1, py + 1, tileSize - 2, tileSize - 2);
    }

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

      // Head — pale when hungry, green-tinged when sick, so trouble is visible
      ctx.fillStyle = p.sick ? '#c5e1a5' : p.hungry ? '#e8e0d8' : '#ffcc80';
      px_(-3, -19, 6, 6);

      // Level headband: bronze → silver → gold as citizens master their craft
      const lv = p.level || 0;
      if (lv >= 1) {
        ctx.fillStyle = lv >= 5 ? '#ffd54f' : lv >= 3 ? '#cfd8dc' : '#a1887f';
        px_(-4, -20, 8, 1);
      }

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
        const packColor = RES_COLORS[RES_KINDS.reduce((a, b) => ((p[a] || 0) >= (p[b] || 0) ? a : b))];
        // Pack strapped to back (top-right of body)
        ctx.fillStyle = packColor;
        px_(3, -14, 4, 5);
        // Small highlight on pack
        ctx.fillStyle = 'rgba(255,255,255,0.4)';
        px_(3, -14, 2, 2);
        // Fullness indicator: outline turns white when at carry cap
        if (carried >= carryCap(p)) {
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

function nightOverlayAlpha() {
  const { hour, minute } = timeOfDay();
  const h    = hour + minute / 60;
  const fade = 1; // one in-game hour to fade in or out
  if (h >= HOUR_DAWN && h < HOUR_DAWN + fade)
    return 0.55 * (1 - (h - HOUR_DAWN) / fade);        // dawn: fade out
  if (h >= HOUR_DUSK - fade && h < HOUR_DUSK)
    return 0.55 * ((h - (HOUR_DUSK - fade)) / fade);   // pre-dusk: fade in
  if (h < HOUR_DAWN || h >= HOUR_DUSK) return 0.55;    // full night / evening
  return 0;
}

function drawDayNight() {
  const alpha = nightOverlayAlpha();
  if (alpha > 0) {
    ctx.fillStyle = `rgba(10,20,60,${alpha.toFixed(2)})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  // Clock: top-right corner of canvas
  const { hour, minute } = timeOfDay();
  const h12  = hour % 12 || 12;
  const ampm = hour < 12 ? 'am' : 'pm';
  const mm   = String(minute).padStart(2, '0');
  const label = `${h12}:${mm}${ampm}`;
  ctx.font = 'bold 13px Monaco,monospace';
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  ctx.fillText(label, canvas.width - 7, 19);
  ctx.fillStyle = alpha > 0.15 ? '#c8d8ff' : '#ffffff';
  ctx.fillText(label, canvas.width - 8, 18);
  ctx.textAlign = 'left';
}

// render() only marks the frame dirty; the actual draw happens at most once
// per display frame in the rAF loop below. At 10× sim speed this stops the
// canvas from being redrawn synchronously inside every 25ms sim tick, and
// coalesces the flood of render() calls from mousemove/drag handlers.
let renderDirty = true;

function render() { renderDirty = true; }

function frameLoop() {
  if (renderDirty) {
    renderDirty = false;
    renderNow();
  }
  requestAnimationFrame(frameLoop);
}
requestAnimationFrame(frameLoop);

function renderNow() {
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
  drawFires();
  drawPeople();
  drawParticles();
  drawDayNight();
  drawLanterns();
}

function drawFires() {
  for (const key of Object.keys(burningTiles)) {
    const b = burningTiles[key];
    const { x, y } = tileToCanvas(b.r, b.c);
    if (x < -tileSize || x > canvas.width || y < -tileSize || y > canvas.height) continue;
    // Flickering flame overlay
    const flick = (simTick + b.r + b.c) % 3;
    ctx.fillStyle = flick === 0 ? 'rgba(255,111,0,0.55)' : flick === 1 ? 'rgba(255,152,0,0.55)' : 'rgba(255,193,7,0.5)';
    ctx.fillRect(x, y, tileSize, tileSize);
    // Flame tongues
    ctx.fillStyle = flick === 0 ? '#ffee58' : '#ff9800';
    const s = Math.max(2, Math.floor(tileSize / 5));
    ctx.fillRect(x + tileSize * 0.2, y + tileSize * 0.15 + flick, s, s * 2);
    ctx.fillRect(x + tileSize * 0.6, y + tileSize * 0.35 - flick, s, s * 2);
  }
}

function drawParticles() {
  for (const pt of particles) {
    const { x, y } = tileToCanvas(pt.y, pt.x);
    if (x < -tileSize || x > canvas.width || y < -tileSize || y > canvas.height) continue;
    ctx.globalAlpha = Math.max(0, pt.life / pt.maxLife);
    ctx.fillStyle = pt.color;
    const s = Math.max(2, Math.floor(tileSize / 10));
    ctx.fillRect(Math.round(x), Math.round(y), s, s);
  }
  ctx.globalAlpha = 1;
}

// Warm lantern glows on people out after dark — drawn above the night overlay
function drawLanterns() {
  if (nightOverlayAlpha() < 0.3) return;
  for (const p of people) {
    if (p.insideBuilding) continue;
    const { x: px, y: py } = tileToCanvas(p.y, p.x);
    if (px < -tileSize || px > canvas.width || py < -tileSize || py > canvas.height) continue;
    const cx = px + tileSize / 2, cy = py + tileSize / 2;
    const rad = Math.max(3, tileSize * 0.45);
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, rad);
    grad.addColorStop(0, 'rgba(255,200,90,0.35)');
    grad.addColorStop(1, 'rgba(255,200,90,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(cx - rad, cy - rad, rad * 2, rad * 2);
    ctx.fillStyle = '#ffd54f';
    const s = Math.max(1, Math.floor(tileSize / 12));
    ctx.fillRect(Math.round(cx), Math.round(cy - s), s, s);
  }
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
  tooltip.style.display = 'none';
}

// ── Income tick ───────────────────────────────────────────────────────────────

setInterval(() => {
  // Factory count comes from the cached tile counts (refreshed by updateUI)
  // instead of scanning all 10,000 tiles every second
  if (!cachedCounts) recomputeTileCounts();
  const income = (TILE_INCOME[FACTORY] || 0) * cachedCounts.factories;
  if (income !== 0) {
    gold = Math.max(0, gold + income);
    updateUI();
  }
}, 1000);

// ── Save / Load ───────────────────────────────────────────────────────────────

const SAVE_KEY = 'citybuilder_save';

function saveGame() {
  const data = {
    v: 7,
    gold, souls, lifespanLevel, speedLevel, sightLevel, landLevel,
    simTick, nextPersonId, nextHouseId, lastExploreTick,
    researched: [...researched],
    grid:        grid.map(row => [...row]),
    resourceMap: resourceMap.map(row => row.map(cell => cell ? { ...cell } : null)),
    townHalls:   townHalls.map(th => ({
      r: th.r, c: th.c,
      resources: { ...th.resources },
      level: th.level ?? 1,
      votes: { ...th.votes },
      popCap: th.popCap,
      buildTimer: th.buildTimer ?? TH_BUILD_INTERVAL,
      happiness: th.happiness ?? 70,
      festivalUntil: th.festivalUntil ?? 0,
    })),
    houseRegistry: JSON.parse(JSON.stringify(houseRegistry)),
    buildingRegistry: JSON.parse(JSON.stringify(buildingRegistry)),
    people: people.map(p => ({ ...p })),
    discovered: [...discovered],
    records: { ...records },
    chronicle: chronicle.map(e => ({ ...e })),
    burningTiles: JSON.parse(JSON.stringify(burningTiles)),
  };
  localStorage.setItem(SAVE_KEY, JSON.stringify(data));
  showMessage('game saved!');
}

function loadGame() {
  const raw = localStorage.getItem(SAVE_KEY);
  if (!raw) { showMessage('no save found.'); return false; }
  try {
    const data = JSON.parse(raw);
    if (!(data.v >= 1 && data.v <= 7)) { showMessage('save version mismatch.'); return false; }

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
      soulsHarvested: 0,
      ...(data.records || {}),
    };
    chronicle    = data.chronicle || [];
    burningTiles = data.burningTiles || {};
    fireActive   = Object.keys(burningTiles).length > 0;
    particles    = [];
    history      = { pop: [], food: [], gold: [], souls: [] };
    selectedPersonId = null;
    followSelected   = false;

    for (let r = 0; r < MAP_ROWS; r++)
      for (let c = 0; c < MAP_COLS; c++) {
        grid[r][c]        = data.grid[r][c];
        resourceMap[r][c] = data.resourceMap[r][c];
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
          if (data.grid[r][c] !== GRASS) need = Math.max(need, coverHalf(r, c));
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
    }));
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
      // Migrate old job/mode values
      if (p.job  === 'builder') p.job  = 'gatherer';
      if (p.job  === undefined) p.job  = 'gatherer';
      if (p.mode === 'build')   p.mode = 'gather';
      if (p.mode === undefined) p.mode = 'gather';
      delete p.buildCooldown;
      // Reset non-standard modes that can't safely resume across loads
      if (p.mode === 'explore' || p.mode === 'social' || p.mode === 'home' || p.mode === 'found') {
        p.mode = 'gather';
        p.foundTarget = null;
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

// ── Init ──────────────────────────────────────────────────────────────────────

clampCamera();
initResourceMap();

// Auto-load save if one exists
if (!loadGame()) {
  render();
  updateUI();
}

// Open the camera on the known world (or the first town if one exists)
{
  const focus = townHalls[0] || { r: LAND_CENTER, c: LAND_CENTER };
  camX = focus.c + 0.5 - (canvas.width  / tileSize) / 2;
  camY = focus.r + 0.5 - (canvas.height / tileSize) / 2;
  clampCamera();
  render();
}
