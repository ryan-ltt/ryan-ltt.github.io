// ═══ citybuilder/js/03-world.js ═══════════════════════════════════════
// World helpers: inBounds/nearestTownHall, citizenship (townOf/citizensOf), makeTownHall, vote weights, resource map init and seasonal regeneration.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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

// ── Citizenship ───────────────────────────────────────────────────────────────
// Every citizen belongs to one town for life's civic matters: assigned at
// birth/spawn to the nearest hall, updated when they move house, inherited
// from the hall a founder raises. Politics — laws, town measures, wars — is
// always judged from the citizen's own town, never whichever hall they happen
// to be walking past.

function townById(id) {
  if (id == null) return null;
  for (const th of townHalls) if (th.id === id) return th;
  return null;
}

function townOf(p) {
  let th = townById(p.townId);
  if (!th) { // orphaned (hall demolished, old save) — adopt the nearest hall
    th = nearestTownHall(Math.round(p.y), Math.round(p.x));
    p.townId = th ? th.id : null;
  }
  return th;
}

function citizensOf(th) {
  return people.filter(p => townOf(p) === th);
}

function soldiersOf(th) {
  return people.filter(p => p.job === 'soldier' && townOf(p) === th);
}

function isAtWar(th) {
  return wars.some(w => w.attackerId === th.id || w.defenderId === th.id);
}

function soldierOnCampaign(p) {
  const th = townOf(p);
  return !!(th && isAtWar(th));
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
    id: nextTownId++,
    resources: { wood: 0, stone: 0, food: 0, clay: 0, ore: 0, ...(resources || {}) },
    level: 1,
    votes: emptyVotes(),
    popCap: 5, // the hall itself shelters a few settlers — spawning works from day one
    buildTimer: TH_BUILD_INTERVAL,
    happiness: 70,
    festivalUntil: 0,
    // War & politics: town meetings, walls, militia, grudges
    nextMeasureTick: 0,   // 0 = the town meeting hasn't formed yet
    militia: false,
    wallPlan: null,       // { cells, idx, built, done, radius } — set by a walls vote
    lastRaidedTick: -99999,
    lastWarEndTick: -99999, // wars need a cooldown or towns raid in perpetuity
    grudgeAgainst: null,  // id of the town that last raided this one
    grudgeTick: -99999,   // when the grudge was seeded — grudges fade
    abandonedSince: null, // simTick when the town was last seen with zero citizens
    sparseSince: null,    // simTick when the town's houses were last seen mostly empty
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

// Node counts were tuned on a 100×100 map — keep the same density on any size
const MAP_AREA_SCALE = (MAP_COLS * MAP_ROWS) / 10000;

function initResourceMap() {
  const types = ['wood', 'stone', 'food', 'clay', 'ore'];
  const counts = [120, 60, 80, 45, 30].map(n => Math.round(n * MAP_AREA_SCALE));
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
  for (let i = 0; i < Math.round(3 * MAP_AREA_SCALE); i++) {
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
        // The greenbelt protects the woods — tree farms replenish more slowly
        if (resourceMap[r][c].type === 'wood' && resourceMap[r][c].amount < 40
            && Math.random() < (lawActive('greenbelt') ? 0.45 : 0.6))
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
