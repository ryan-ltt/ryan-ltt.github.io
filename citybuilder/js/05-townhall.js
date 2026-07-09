// ═══ citybuilder/js/05-townhall.js ════════════════════════════════════
// Town-hall autonomous build engine: roads, houses, founding new towns, hall upgrades, happiness relief, citizen voting and vote-threshold builds.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
    const nth = makeTownHall(fr, fc);
    townHalls.push(nth);
    p.townId = nth.id; // the founder is the new town's first citizen
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
  p.townId = nth.id; // the founder settles in the town they raised
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
  if (space > 0 && (homelessCount() > 0 || fillRatio > (lawActive('homestead_act') ? 0.3 : 0.5))) {
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
