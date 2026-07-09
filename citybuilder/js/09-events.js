// ═══ citybuilder/js/09-events.js ══════════════════════════════════════
// Decay (abandoned towns crumble, hollow towns shed houses) and random events: fires, disease, bumper harvests, migrants.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Decay ─────────────────────────────────────────────────────────────────────
// Empires used to be immortal: a town whose people all died or emigrated kept
// its buildings forever, so a sprawling map slowly filled with lifeless stone.
// Now abandonment has consequences. A town with zero citizens crumbles tile by
// tile (buildings first, then walls, then roads, the hall last), and a living
// town rattling around in mostly-empty housing sheds its abandoned houses.

const DECAY_INTERVAL = 24;             // ticks between decay passes
const DECAY_GRACE    = DAY_LENGTH;     // a dead town stands one day before crumbling
const SPARSE_GRACE   = 2 * DAY_LENGTH; // near-empty towns shed houses after two days
const SPARSE_RATIO   = 0.3;            // "near-empty": residents fill under 30% of beds

// A few tiles of a dead town return to grass — buildings first, then walls,
// then roads. When nothing is left the hall itself falls and the town is gone.
function crumbleSome(th) {
  const buildings = [], walls = [], roads = [];
  for (let dr = -14; dr <= 14; dr++)
    for (let dc = -14; dc <= 14; dc++) {
      const r = th.r + dr, c = th.c + dc;
      if (!inBounds(r, c)) continue;
      const t = grid[r][c];
      if (t === GRASS || t === TOWN_HALL) continue;
      if (nearestTownHall(r, c) !== th) continue; // a neighbour's tiles are theirs
      (t === WALL ? walls : t === ROAD ? roads : buildings).push([r, c]);
    }
  const pool = buildings.length ? buildings : walls.length ? walls : roads;
  if (pool.length === 0) {
    addChronicle(townLabel(th) + ' crumbled to dust — no one was left to remember it');
    logEvent('🏚 ' + townLabel(th) + ' has crumbled to dust', 'info');
    addParticles(th.r, th.c, '#8d6e63', 12);
    demolishTile(th.r, th.c);
    return;
  }
  // Big ghost towns rot faster so a map-spanning ruin doesn't linger for weeks
  let n = 1 + Math.floor(pool.length / 25);
  while (n-- > 0 && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    const [r, c] = pool.splice(i, 1)[0];
    addParticles(r, c, '#8d6e63', 6);
    demolishTile(r, c);
  }
}

function decayTick() {
  if (simTick % DECAY_INTERVAL !== 7 || townHalls.length === 0) return;

  // Citizen counts and house occupancy per town, each in a single pass
  const counts = new Map();
  for (const p of people) {
    const th = townOf(p);
    if (th) counts.set(th.id, (counts.get(th.id) || 0) + 1);
  }
  const housing = new Map(); // townId → { beds, heads, houses: [] }
  for (const h of Object.values(houseRegistry)) {
    const th = nearestTownHall(h.r, h.c);
    if (!th) continue;
    let entry = housing.get(th.id);
    if (!entry) housing.set(th.id, entry = { beds: 0, heads: 0, houses: [] });
    entry.beds  += h.slots;
    entry.heads += h.residents.length;
    entry.houses.push(h);
  }

  for (const th of [...townHalls]) {
    const pop = counts.get(th.id) || 0;

    // Dead town: grace period, then tile-by-tile collapse
    if (pop === 0) {
      if (th.abandonedSince == null) { th.abandonedSince = simTick; continue; }
      if (simTick - th.abandonedSince > DECAY_GRACE) crumbleSome(th);
      continue;
    }
    th.abandonedSince = null;

    // Living but hollowed-out town: abandoned houses fall into ruin one at a
    // time. At least one empty house always survives so the town can still
    // take in newcomers and be born back into growth.
    const occ = housing.get(th.id);
    if (occ && occ.beds > 0 && occ.heads / occ.beds < SPARSE_RATIO) {
      if (th.sparseSince == null) { th.sparseSince = simTick; continue; }
      if (simTick - th.sparseSince <= SPARSE_GRACE) continue;
      const empty = occ.houses.filter(h => h.residents.length === 0);
      if (empty.length > 1) {
        const h = empty[Math.floor(Math.random() * empty.length)];
        addParticles(h.r, h.c, '#8d6e63', 6);
        logEvent('🏚 an abandoned ' + TILE_NAMES[grid[h.r][h.c]] + ' in ' + townLabel(th) + ' fell into ruin', 'info');
        demolishTile(h.r, h.c);
      }
    } else {
      th.sparseSince = null;
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

  // Migrants — drawn to happy towns with room to spare. Open borders draws
  // them in far more often, and even merely content towns will do.
  const openBorders = lawActive('open_borders');
  if (globalHappiness() >= (openBorders ? 60 : 75) && people.length >= 5 && people.length < globalPopCap()
      && Math.random() < 0.0006 * (openBorders ? 4 : 1)) {
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
