// ═══ citybuilder/js/12-sim.js ═════════════════════════════════════════
// simulationTick() — the master tick that sequences every system — and the speed slider control.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
    if (lawActive('eight_hour_day')) mult *= 0.75;
    if (lawActive('guild_charters')) mult *= 0.85;
    if (entry.type === FACTORY   && lawActive('clean_air_act')) mult *= 0.6;
    if (entry.type === TREE_FARM && lawActive('greenbelt'))     mult *= 0.75;

    // Working is how citizens learn a trade — guild charters teach twice as fast
    const xpMult = lawActive('guild_charters') ? 2 : 1;
    for (const pid of entry.workers) {
      const wp = byId.get(pid);
      if (wp) grantXP(wp, 0.25 * xpMult, nearSchool);
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
        if (p.job === 'worker' || p.job === 'soldier' || p.mode === 'explore' || p.mode === 'found') continue;
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
      if (p.job === 'soldier' && soldierOnCampaign(p)) continue; // wars don't pause at dusk
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
      if (p.job === 'soldier' && soldierOnCampaign(p)) continue; // sentries hold the night watch
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
  militaryTick(); // orders before movement — soldiers march on fresh targets
  movePeople();
  gatherResources();
  depositResources();
  for (const th of townHalls) {
    th.buildTimer = (th.buildTimer || 0) - 1;
    if (th.buildTimer <= 0) {
      thAutoBuild(th);
      thWallStep(th); // wall segments rise alongside the normal build cycle
      th.buildTimer = TH_BUILD_INTERVAL;
    }
  }
  tryUpgradeHousing();
  houseSpawnPeople();
  fireTick();
  eventsTick();
  decayTick();
  politicsTick();
  townMeasureTick();
  updateParticles();
  if (simTick % SEASON_LENGTH === 0 && townHalls.length > 0) {
    logEvent(SEASON_NOTES[currentSeason()], 'info');
    if (lawActive('public_feasts')) holdPublicFeasts();
  }
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
