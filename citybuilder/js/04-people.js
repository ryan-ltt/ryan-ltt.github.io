// ═══ citybuilder/js/04-people.js ══════════════════════════════════════
// People simulation: spawn/age/eat/modes, resource search, weighted-random movement, gather/deposit, housing and vacancy, building registry.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
  if (churchNear(r, c)) y *= lawActive('church_tithe') ? 2 : CHURCH_SOUL_MULT;
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
    mode: 'gather',     // 'gather' | 'explore' | 'found' | 'home' | 'social' | 'patrol' | 'war' | 'defend'
    job:  'gatherer',   // 'gatherer' | 'explorer' | 'founder' | 'worker' | 'soldier' | 'idle'
    townId: nearestTownHall(r, c)?.id ?? null, // civic home — politics is voted here
    warTarget: null,    // { r, c } destination while soldiering (patrol/war/defend)
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
  const eatChance = lawActive('rationing') ? 0.07 : 0.1;
  for (const p of people) {
    if (Math.random() >= eatChance) continue;
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
  if (p.job === 'worker') return;  // workers are managed by workerTick
  if (p.job === 'soldier') return; // soldiers are managed by militaryTick
  if (p.mode === 'found') return;  // founder manages their own mode
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

    } else if (p.mode === 'patrol' || p.mode === 'war' || p.mode === 'defend') {
      // Soldiers: march on the target militaryTick set, or walk the beat near home
      if (p.warTarget) {
        const td  = Math.abs(nr - p.warTarget.r) + Math.abs(nc - p.warTarget.c);
        const td0 = Math.abs(r  - p.warTarget.r) + Math.abs(c  - p.warTarget.c);
        if (td < td0)      w *= 40;
        else if (td > td0) w *= 0.05;
        if (t === ROAD) w *= 1.3;
      } else {
        // Patrol: loiter inside the town, drifting back when they stray
        const home = townOf(p);
        if (home) {
          const da = Math.max(Math.abs(nr - home.r), Math.abs(nc - home.c));
          w *= da <= PATROL_RADIUS ? 1.0 : 0.15;
        }
      }

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
    if (p.mode === 'explore') continue;  // explorers don't gather while en route
    if (p.job === 'soldier') continue;   // soldiers carry loot, not harvests
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
    // Soldiers deposit via militaryTick, and only at their own hall — the
    // generic "nearest hall" rule would hand a raider's loot straight back
    if (p.job === 'soldier') continue;
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


const HOUSING_TYPES = new Set([HOUSE, ROW_HOUSE, APARTMENT]);

// The homestead act halves the cost of housing
function buildCostFor(type) {
  const cost = BUILD_COSTS[type];
  if (!HOUSING_TYPES.has(type) || !lawActive('homestead_act')) return cost;
  const subsidised = {};
  for (const [k, v] of Object.entries(cost)) subsidised[k] = Math.ceil(v / 2);
  return subsidised;
}

function canAffordBuild(type, th) {
  if (!th) return false;
  const cost = buildCostFor(type);
  return Object.entries(cost).every(([k, v]) => (th.resources[k] || 0) >= v);
}

function spendBuildCost(type, th) {
  const cost = buildCostFor(type);
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
  // Moving house moves your citizenship: politics follows where you live
  const th = nearestTownHall(h.r, h.c);
  if (th) p.townId = th.id;
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
    // Soldiers on campaign are never billeted mid-war: moving house moves
    // citizenship (assignHouse), and an army rehoused into another town —
    // even the enemy's — silently routs itself
    if (p.job === 'soldier' && soldierOnCampaign(p)) continue;
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
