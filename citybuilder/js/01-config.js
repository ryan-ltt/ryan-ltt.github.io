// ═══ citybuilder/js/01-config.js ══════════════════════════════════════
// Canvas bootstrap and every tunable: map size, tile enums, sim/land/era/research/gold-power constants, POLICIES (laws), war constants and TOWN_MEASURES.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

const canvas = document.getElementById('gameCanvas');
let ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;

// Reference tile size all draw functions are authored at
const BASE = 32;

const MAP_COLS = 160;
const MAP_ROWS = 160;

const ZOOM_LEVELS = [8, 12, 16, 24, 32, 48, 64];
const ZOOM_LABELS  = ['25%', '37%', '50%', '75%', '100%', '150%', '200%'];

const GRASS = 0, ROAD = 1, HOUSE = 2, SHOP = 3, PARK = 4, FACTORY = 5, CHURCH = 6, TOWN_HALL = 7, TREE_FARM = 8, STONE_FARM = 9, FARM = 10, ROW_HOUSE = 11, APARTMENT = 12, WELL = 13, SCHOOL = 14, WALL = 15;

// Flat colours used for LOD / minimap-like rendering at very small tile sizes
const TILE_COLORS = ['#4caf50', '#a1887f', '#1e88e5', '#ffe082', '#66bb6a', '#616161', '#9c27b0', '#ff6f00', '#388e3c', '#78909c', '#f9a825', '#e57373', '#7e57c2', '#4fc3f7', '#ff8a65', '#8a939c'];
const TILE_NAMES  = ['grass', 'path', 'house', 'market', 'park', 'factory', 'church', 'town hall', 'tree farm', 'stone farm', 'farm', 'row house', 'apartment', 'well', 'school', 'wall'];

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
const MAX_PEOPLE          = 2500;
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
const LAND_CENTER    = Math.floor(MAP_COLS / 2);
const LAND_BASE_HALF = 12;  // half-size of the starting square (24×24)
const LAND_STEP      = 6;   // half-size added per land level
// Enough levels to cover whatever size the map is
const MAX_LAND_LEVEL = Math.ceil((MAP_COLS / 2 - LAND_BASE_HALF) / LAND_STEP);

function landHalf(level) { return Math.min(MAP_COLS / 2, LAND_BASE_HALF + level * LAND_STEP); }

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
  [TOWN_HALL]: 9, [WALL]: 9, // never redeveloped — walls come down by war or demolition only
};

// ── Gold powers ───────────────────────────────────────────────────────────────
const POWER_COSTS = { road: 20, drop: 50, sway: 100, campaign: 150, festival: 500, charter: 1000 };
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

// ── Politics: direct democracy ────────────────────────────────────────────────
// Once the settlement is big enough, the people hold referendums: every two
// days one measure goes to the ballot — a new law, or the repeal of one that
// has soured. Every citizen votes their own interest, so the law of the land
// drifts with the town's fortunes: rationing passes in a famine and is thrown
// out again once bellies are full. The player can't dictate outcomes, only
// spend gold on campaigns that sway the undecided.
const POLITICS_MIN_POP    = 10;
const REFERENDUM_INTERVAL = 2 * DAY_LENGTH; // one measure every two days
const BALLOT_NOTICE       = DAY_LENGTH;     // announced a day ahead — time to campaign
const CAMPAIGN_SWING      = 0.12;           // support shift per campaign purchase
const CAMPAIGN_MAX        = 3;              // purchases per side per ballot
const VOTE_NOISE          = 0.25;           // private wobble in every voter's mind
const FEAST_FOOD_COST     = 15;             // food a town spends per public feast

// Each policy: what it does to the sim (wired into the relevant tick
// functions via lawActive), when it can appear on a ballot, and how a single
// citizen leans on it given their own circumstances (roughly -1 … 1).
const POLICIES = {
  eight_hour_day: {
    name: 'eight-hour day', emoji: '⏳', cat: 'labor',
    desc: 'workers down tools earlier: +6 happiness everywhere, but staffed buildings produce 25% less',
    unlocked: () => eraIndex >= 1,
    support(p, th) {
      let s = 0.1;
      if (p.job === 'worker') s += 0.5;
      if (foodTicksFor(th) < 15) s -= 0.5;      // a hungry town can't afford short shifts
      if ((th.happiness ?? 70) < 55) s += 0.2;
      return s;
    },
  },
  guild_charters: {
    name: 'guild charters', emoji: '📜', cat: 'labor',
    desc: 'formal apprenticeships: workers learn twice as fast on the job, but output falls 15%',
    unlocked: () => eraIndex >= 1,
    support(p, th) {
      let s = 0;
      if ((p.level || 0) < 3) s += 0.4;         // the unskilled want a way up
      if ((p.level || 0) >= 5) s -= 0.2;        // masters see nothing in it for them
      if (p.job === 'worker') s += 0.3;
      if (foodTicksFor(th) < 15) s -= 0.3;
      return s;
    },
  },
  open_borders: {
    name: 'open borders', emoji: '🚶', cat: 'growth',
    desc: 'the town welcomes outsiders: migrants arrive far more often and births rise',
    unlocked: () => eraIndex >= 1,
    support(p, th) {
      let s = 0.05 + housingVacancy().ratio * 0.7; // empty beds want neighbours
      if (p.houseId == null) s -= 0.7;             // the homeless fear more competition
      if ((th.happiness ?? 70) < 50) s -= 0.3;
      return s;
    },
  },
  homestead_act: {
    name: 'homestead act', emoji: '🏠', cat: 'growth',
    desc: 'housing is subsidised: houses cost half and town halls build them sooner',
    unlocked: () => true,
    support(p, th) {
      let s = 0;
      if (p.houseId == null) s += 0.9;
      if (housingVacancy().empty === 0) s += 0.4;
      if ((th.resources.wood || 0) < 20) s -= 0.25; // subsidies drain a lean woodpile
      return s;
    },
  },
  public_feasts: {
    name: 'public feasts', emoji: '🎪', cat: 'culture',
    desc: 'every new season each town spends ' + FEAST_FOOD_COST + ' food on a free festival',
    unlocked: () => eraIndex >= 1,
    support(p, th) {
      let s = 0.4;
      if (p.hungry) s -= 0.8;
      if (foodTicksFor(th) < 20) s -= 0.5;
      if ((th.happiness ?? 70) < 60) s += 0.2;
      return s;
    },
  },
  church_tithe: {
    name: 'church tithe', emoji: '⛪', cat: 'culture',
    desc: 'the faithful give more: deaths near a church release 2× souls, but the obligation costs −3 happiness',
    unlocked: () => researched.has('worship'),
    support(p, th) {
      let s = -0.1;
      if (p.age > p.maxAge * 0.7) s += 0.6;  // the old think of their legacy
      if (p.age < p.maxAge * 0.3) s -= 0.25; // the young resent the collection plate
      if (jobTitle(p) === 'priest') s += 0.7;
      return s;
    },
  },
  rationing: {
    name: 'rationing', emoji: '🍞', cat: 'welfare',
    desc: 'meals are stretched: citizens eat 30% less food, at −6 happiness',
    unlocked: () => true,
    support(p, th) {
      let s = -0.25;
      if (p.hungry) s += 0.9;
      const ft = foodTicksFor(th);
      if (ft < 10) s += 0.7;
      else if (ft > 30) s -= 0.4;
      return s;
    },
  },
  clean_air_act: {
    name: 'clean air act', emoji: '🌫', cat: 'environment',
    desc: 'scrubbers on every stack: factories drag happiness down far less, but earn 40% less gold',
    unlocked: () => researched.has('industry'),
    support(p, th) {
      if (jobTitle(p) === 'machinist') return -0.6;   // fears for the payroll
      const factories = th.nearFactories || 0;
      if (factories === 0) return -0.05;              // someone else's problem
      return Math.min(0.7, 0.2 + factories * 0.15);   // the smoke is personal
    },
  },
  greenbelt: {
    name: 'greenbelt', emoji: '🌳', cat: 'environment',
    desc: 'the woods are protected: parks give +8 happiness, but tree farms yield 25% less wood',
    unlocked: () => eraIndex >= 1,
    support(p, th) {
      let s = 0.1;
      const job = jobTitle(p);
      if (job === 'groundskeeper') s += 0.5;
      if (job === 'forester') s -= 0.6;
      if ((th.happiness ?? 70) < 65) s += 0.25;
      if ((th.resources.wood || 0) < 30) s -= 0.35;
      return s;
    },
  },
};

let politics = {
  enacted: [],            // keys of laws in force
  ballot: null,           // { key, kind: 'enact'|'repeal', for: 0, against: 0 }
  nextReferendumTick: 0,  // 0 = the assembly hasn't formed yet
  announcedFor: -1,       // referendum tick whose ballot has been drawn (or skipped)
};

function lawActive(key) { return politics.enacted.includes(key); }

function foodTicksFor(th) {
  return people.length > 0 ? (th.resources.food || 0) / people.length : 99;
}

// ── War & military: town measures ─────────────────────────────────────────────
// Every citizen belongs to a town (their townId points at a hall). Alongside
// the civilization-wide laws above, each town of 8+ holds its own vote every
// two days on matters of walls and war: raise a wall ring, muster a militia,
// march on a neighbouring town to steal its stockpile, or sue for peace.
// The player never orders a war — towns talk themselves into them.
const TOWN_MIN_POP          = 8;               // citizens needed for a town meeting
const TOWN_MEASURE_INTERVAL = 2 * DAY_LENGTH;  // one town measure every two days
const WAR_LENGTH            = 2 * DAY_LENGTH;  // wars burn out after two days
const WAR_COOLDOWN          = 4 * DAY_LENGTH;  // a town that fought won't march again for a while
const RAID_MAX_DIST         = 60;              // towns won't march on halls further than this (Manhattan)
const SOLDIER_RATIO         = 5;               // 1 soldier per 5 citizens…
const MAX_SOLDIERS          = 6;               // …capped per town
const WALL_STONE_COST       = 1;               // stone per wall segment
const WALL_GAP              = 3;               // walls trace the town footprint at this distance
const PATROL_RADIUS         = 8;               // peacetime soldiers loiter this close to their hall
const GRUDGE_MEMORY         = 6 * DAY_LENGTH;  // how long a raided town resents its attacker
// Per-tick chances that a raider adjacent to an enemy structure damages it
const RAZE_CHANCE_WALL      = 0.10;            // breaching the walls is the raiders' first job
const RAZE_CHANCE_TORCH     = 0.05;            // flammable buildings get torched (fire spreads)
const RAZE_CHANCE_STONE     = 0.03;            // stone buildings are pulled down slowly

function raidedRecently(th) { return simTick - (th.lastRaidedTick ?? -99999) < 3 * DAY_LENGTH; }
function foughtRecently(th) { return simTick - (th.lastWarEndTick ?? -99999) < WAR_COOLDOWN; }
function holdsGrudge(th, target) {
  return th.grudgeAgainst === target.id
      && simTick - (th.grudgeTick ?? -99999) < GRUDGE_MEMORY;
}

// Each measure: when a town may consider it, and how one citizen leans (-1 … 1)
const TOWN_MEASURES = {
  walls: {
    name: 'raise the walls', emoji: '🧱',
    desc: 'wall in the town along its edge — roads become gates, raiders must funnel through them. A town that outgrows or loses its walls can vote to rebuild them',
    available: (th) => eraIndex >= 1
      && (!th.wallPlan ? true : (th.wallPlan.done && wallWorkNeeded(th))),
    support(p, th) {
      let s = 0.15;
      if (raidedRecently(th)) s += 0.6;               // once bitten
      if (wars.length > 0)    s += 0.25;              // war is in the air
      if (th.wallPlan)        s += 0.1;               // the town knows what its walls were worth
      if ((th.resources.stone || 0) < 30) s -= 0.45;  // can't spare the stone
      if (foodTicksFor(th) < 10) s -= 0.3;
      return s;
    },
  },
  militia: {
    name: 'muster a militia', emoji: '🛡',
    desc: 'the town drafts its ablest into soldiers — they patrol in peace and fight in war, but gather nothing',
    available: (th) => eraIndex >= 1 && !th.militia,
    support(p, th) {
      let s = 0.05;
      if (raidedRecently(th)) s += 0.55;
      if (wars.length > 0)    s += 0.25;
      if (townHalls.some(o => o !== th && o.militia)) s += 0.2; // the neighbours are arming
      if (foodTicksFor(th) < 15) s -= 0.5;            // idle mouths in a famine
      if ((p.level || 0) >= 3) s += 0.15;             // the able fancy a rank
      return s;
    },
  },
  disband: {
    name: 'disband the militia', emoji: '🕊',
    desc: 'the soldiers hang up their spears and go back to gathering',
    available: (th) => th.militia && !isAtWar(th),
    support(p, th) {
      let s = simTick - (th.lastRaidedTick ?? -99999) > GRUDGE_MEMORY ? 0.15 : -0.6;
      if (foodTicksFor(th) < 10) s += 0.45;           // hungry towns want hands, not spears
      if (wars.length > 0) s -= 0.35;
      if (p.job === 'soldier') s -= 0.4;              // no one votes away their own post
      return s;
    },
  },
  raid: {
    name: 'march to war', emoji: '⚔️',
    desc: 'the militia marches on a neighbouring town to raid its stockpile and burn what it can',
    available: (th) => th.militia && soldiersOf(th).length > 0 && !isAtWar(th)
      && !foughtRecently(th) && townHalls.length > 1,
    support(p, th, target) {
      if (!target) return -1;
      let s = -0.25; // war is frightening
      const loot = RES_KINDS.reduce((sum, k) => sum + (target.resources[k] || 0), 0);
      const dist = Math.abs(target.r - th.r) + Math.abs(target.c - th.c);
      s += Math.min(0.7, loot / 400);                  // greed scales with their piles
      s -= Math.min(0.3, dist / 150);                  // a long march cools hot heads
      if (holdsGrudge(th, target)) s += 0.6;           // they raided us first
      if (foodTicksFor(th) < 8) s += 0.45;             // desperation
      if ((th.happiness ?? 70) < 45) s += 0.15;
      const mine = soldiersOf(th).length, theirs = soldiersOf(target).length;
      if (mine >= theirs + 2)      s += 0.2;           // easy pickings
      else if (theirs > mine)      s -= 0.35;          // we'd be outmatched
      if (p.job === 'soldier') s += 0.2;               // glory
      return s;
    },
  },
  peace: {
    name: 'sue for peace', emoji: '🏳',
    desc: 'the town calls its soldiers home and ends the war',
    available: (th) => wars.some(w => w.attackerId === th.id),
    support(p, th) {
      const war = wars.find(w => w.attackerId === th.id);
      if (!war) return 0;
      let s = 0.1;
      s += (war.attackerLosses || 0) * 0.12;           // every funeral weighs
      if (simTick - war.startTick > DAY_LENGTH) s += 0.2;
      if (foodTicksFor(th) < 10) s += 0.35;
      if ((war.loot || 0) >= 30) s -= 0.3;             // the raids are paying
      return s;
    },
  },
};
