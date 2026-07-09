// ═══ citybuilder/js/02-state.js ═══════════════════════════════════════
// Global game state: grid, resourceMap, people, townHalls, registries, records, chronicle, live effects, camera and interaction vars, discoveries panel.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
let nextTownId      = 0;    // stable town-hall ids — citizenship survives hall removal
let wars            = [];   // { attackerId, defenderId, startTick, endTick, loot, attackerLosses, defenderLosses }

// ── Records, chronicle, era ───────────────────────────────────────────────────
let records = {
  peakPop: 0, oldestEver: 0, totalBirths: 0, totalDeaths: 0,
  townsFounded: 0, firesSurvived: 0, won: false, soulsHarvested: 0,
  warsWaged: 0, battleDeaths: 0,
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
  [WALL]:       { name: 'wall',       desc: 'Stone town wall, voted in at a town meeting and built a segment at a time. Roads through it become gates. Defenders fight harder inside their own walls.' },
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
    case WALL:       drawWall(0, 0);      break;
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
