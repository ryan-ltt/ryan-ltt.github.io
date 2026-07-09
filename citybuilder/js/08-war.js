// ═══ citybuilder/js/08-war.js ═════════════════════════════════════════
// Per-town measures (walls/militia/disband/raid/peace), organic wall plans and building, soldiers, wars, raiding, sacking, skirmishes.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Town measures: walls, militia & war ───────────────────────────────────────
// Per-town direct democracy. Every two days each town of 8+ picks the measure
// its citizens want most (walls / militia / disband / raid / peace) and votes
// it up or down on the spot. Passed measures act immediately.

function townMeasureAvg(key, th, citizens, target) {
  if (citizens.length === 0) return 0;
  let sum = 0;
  for (const p of citizens) sum += clamp(TOWN_MEASURES[key].support(p, th, target), -1, 1);
  return sum / citizens.length;
}

// Which neighbour to raid: rich AND close. Loot is discounted by marching
// distance so far-flung towns pick different victims instead of everyone
// piling onto the single richest hall, towns already in a war are off the
// table entirely, and a fresh grudge doubles the appeal of revenge.
function pickRaidTarget(th) {
  let best = null, bestScore = 0;
  for (const other of townHalls) {
    if (other === th) continue;
    if (isAtWar(other)) continue; // no pile-ons — one war per town at a time
    const dist = Math.abs(other.r - th.r) + Math.abs(other.c - th.c);
    if (dist > RAID_MAX_DIST) continue;
    const loot = RES_KINDS.reduce((s, k) => s + (other.resources[k] || 0), 0);
    let score = loot / (1 + dist / 12);
    if (holdsGrudge(th, other)) score *= 2;
    if (score > bestScore) { bestScore = score; best = other; }
  }
  return best;
}

function townLabel(th) {
  const idx = townHalls.indexOf(th);
  return 'the town at ' + th.c + ', ' + th.r + (townHalls.length > 1 ? ' (TH ' + (idx + 1) + ')' : '');
}

function townMeasureTick() {
  if (simTick % 8 !== 3) return; // cheap: off-beat from the other 8-tick jobs
  for (const th of townHalls) {
    const pop = citizensOf(th).length;
    if (th.nextMeasureTick === 0) {
      if (pop < TOWN_MIN_POP) continue;
      // Stagger the first meeting so towns don't all vote on the same tick
      th.nextMeasureTick = simTick + TOWN_MEASURE_INTERVAL + Math.floor(Math.random() * DAY_LENGTH);
      logEvent('🏛 ' + townLabel(th) + ' now holds town meetings — walls and war are on the table', 'info');
      continue;
    }
    if (simTick < th.nextMeasureTick) continue;
    th.nextMeasureTick = simTick + TOWN_MEASURE_INTERVAL;
    if (pop < TOWN_MIN_POP) continue;

    // The measure the town most wants goes to an immediate show of hands
    const citizens = citizensOf(th);
    let bestKey = null, bestAvg = 0.05, bestTarget = null;
    for (const [key, m] of Object.entries(TOWN_MEASURES)) {
      if (!m.available(th)) continue;
      const target = key === 'raid' ? pickRaidTarget(th) : null;
      if (key === 'raid' && !target) continue;
      const a = townMeasureAvg(key, th, citizens, target);
      if (a > bestAvg) { bestAvg = a; bestKey = key; bestTarget = target; }
    }
    if (!bestKey) continue;

    let yes = 0, no = 0;
    for (const p of citizens) {
      const s = clamp(TOWN_MEASURES[bestKey].support(p, th, bestTarget), -1, 1)
              + (Math.random() * 2 - 1) * VOTE_NOISE;
      if (s > 0) yes++; else no++;
    }
    const m = TOWN_MEASURES[bestKey];
    const tally = yes + '–' + no;
    if (yes <= no) {
      logEvent(m.emoji + ' ' + townLabel(th) + ' voted down "' + m.name + '", ' + tally, 'info');
      continue;
    }
    logEvent(m.emoji + ' ' + townLabel(th) + ' voted to ' + m.name + ', ' + tally, 'info');
    enactTownMeasure(bestKey, th, bestTarget);
  }
}

function enactTownMeasure(key, th, target) {
  switch (key) {
    case 'walls': {
      const rebuild = !!th.wallPlan;
      const plan = makeWallPlan(th);
      if (rebuild && th.wallPlan.cells) {
        // The new contour follows the town as it stands today. Standing
        // segments still on it carry over as built; segments the town has
        // outgrown are quarried — their stone comes back for the new ring.
        for (const [r, c] of th.wallPlan.cells) {
          if (!inBounds(r, c) || grid[r][c] !== WALL) continue;
          if (plan.distAt(r, c) === WALL_GAP) plan.built++;
          else { grid[r][c] = GRASS; th.resources.stone += WALL_STONE_COST; }
        }
      }
      delete plan.distAt;
      th.wallPlan = plan;
      addChronicle(townLabel(th) + (rebuild ? ' voted to rebuild its walls' : ' voted to raise walls'));
      sfx('build');
      break;
    }
    case 'militia':
      th.militia = true;
      addChronicle(townLabel(th) + ' mustered a militia');
      draftSoldiers(th);
      sfx('era');
      break;
    case 'disband':
      th.militia = false;
      draftSoldiers(th); // target drops to 0 — everyone stands down
      addChronicle(townLabel(th) + ' disbanded its militia');
      break;
    case 'raid':
      startWar(th, target);
      break;
    case 'peace': {
      const war = wars.find(w => w.attackerId === th.id);
      if (war) endWar(war, 'peace');
      break;
    }
  }
}

// ── Walls ─────────────────────────────────────────────────────────────────────
// A walls vote traces the town's actual footprint instead of drawing a square:
// BFS dilates outward from every structure of the town core, and the cells
// exactly WALL_GAP steps out form an organic contour. Cells that sit as close
// to a neighbouring hall as to this one are left out, so two towns' walls
// never overlap or fence in each other's ground. The build engine lays a few
// segments per cycle (1 stone each). Roads crossing the contour are skipped —
// they become the gates — and any segment that would sever the walkable world
// is skipped too, so a wall can never seal anyone in.

function makeWallPlan(th) {
  const CORE_R = 12;               // how far from the hall the town core reaches
  const W      = CORE_R + WALL_GAP + 1; // window half-size around the hall
  const size   = W * 2 + 1;
  const dist   = new Int8Array(size * size).fill(-1);
  const di     = (r, c) => (r - th.r + W) * size + (c - th.c + W);
  const queue  = [];
  // Seeds: every structure of this town's core (the hall included)
  for (let dr = -CORE_R; dr <= CORE_R; dr++)
    for (let dc = -CORE_R; dc <= CORE_R; dc++) {
      const r = th.r + dr, c = th.c + dc;
      if (!inBounds(r, c)) continue;
      const t = grid[r][c];
      if (t === GRASS || t === ROAD || t === WALL) continue;
      if (t === TOWN_HALL) { if (r !== th.r || c !== th.c) continue; }
      else if (nearestTownHall(r, c) !== th) continue; // another town's buildings
      dist[di(r, c)] = 0;
      queue.push([r, c]);
    }
  // BFS dilation — pure shape, deliberately ignores walkability
  for (let qi = 0; qi < queue.length; qi++) {
    const [r, c] = queue[qi];
    const d = dist[di(r, c)];
    if (d >= WALL_GAP) continue;
    for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
      const nr = r + dr, nc = c + dc;
      if (!inBounds(nr, nc) || Math.abs(nr - th.r) > W || Math.abs(nc - th.c) > W) continue;
      if (dist[di(nr, nc)] !== -1) continue;
      dist[di(nr, nc)] = d + 1;
      queue.push([nr, nc]);
    }
  }
  // The contour: exactly WALL_GAP out, buildable, and unambiguously ours
  const cells = [];
  let radius = 3;
  for (const [r, c] of queue) {
    if (dist[di(r, c)] !== WALL_GAP) continue;
    if (grid[r][c] !== GRASS || !inLand(r, c)) continue; // roads stay gates, standing walls stay
    const dHome = Math.abs(r - th.r) + Math.abs(c - th.c);
    let claimed = false;
    for (const other of townHalls) {
      if (other === th) continue;
      if (Math.abs(r - other.r) + Math.abs(c - other.c) <= dHome) { claimed = true; break; }
    }
    if (claimed) continue;
    cells.push([r, c]);
    radius = Math.max(radius, Math.max(Math.abs(r - th.r), Math.abs(c - th.c)));
  }
  // Build in walking order around the hall so the ring rises clockwise
  cells.sort((a, b) => Math.atan2(a[0] - th.r, a[1] - th.c) - Math.atan2(b[0] - th.r, b[1] - th.c));
  const plan = { cells, idx: 0, built: 0, done: false, radius };
  // Closure helper for rebuild votes (deleted before the plan is stored):
  // lets the enactor ask whether an old segment still sits on this contour
  plan.distAt = (r, c) =>
    (Math.abs(r - th.r) > W || Math.abs(c - th.c) > W) ? -1 : dist[di(r, c)];
  return plan;
}

// Perimeter of the Chebyshev ring at `radius` around (r0, c0), in walking
// order. Only used to migrate pre-v10 square wall plans.
function ringPositions(r0, c0, radius) {
  const out = [];
  for (let c = c0 - radius; c <= c0 + radius; c++) out.push([r0 - radius, c]); // top
  for (let r = r0 - radius + 1; r <= r0 + radius; r++) out.push([r, c0 + radius]); // right
  for (let c = c0 + radius - 1; c >= c0 - radius; c--) out.push([r0 + radius, c]); // bottom
  for (let r = r0 + radius - 1; r >= r0 - radius + 1; r--) out.push([r, c0 - radius]); // left
  return out;
}

function hasWalls(th) {
  return !!(th.wallPlan && th.wallPlan.done && th.wallPlan.built >= 8);
}

// A finished wall needs work when the town has outgrown it or raiders have
// knocked holes in it — both show up the same way: re-tracing the contour
// finds buildable gaps. Cached on the plan so town meetings stay cheap.
function wallWorkNeeded(th) {
  const plan = th.wallPlan;
  if (!plan || !plan.done) return false;
  if (simTick - (plan.checkedTick ?? -99999) < TOWN_MEASURE_INTERVAL / 2)
    return plan.needsWork ?? false;
  plan.checkedTick = simTick;
  plan.needsWork = makeWallPlan(th).cells.length >= 4;
  return plan.needsWork;
}

function thWallStep(th) {
  const plan = th.wallPlan;
  if (!plan || plan.done) return false;
  const cells = plan.cells || [];
  let placed = 0, scanned = 0;
  // wouldBlockPath flood-fills the map — bound the work per cycle
  while (plan.idx < cells.length && placed < 2 && scanned < 8) {
    const [r, c] = cells[plan.idx];
    scanned++;
    if (!inBounds(r, c) || !inLand(r, c) || grid[r][c] !== GRASS) { plan.idx++; continue; }
    if ((th.resources.stone || 0) < WALL_STONE_COST) return placed > 0; // wait for stone
    if (wouldBlockPath(r, c)) { plan.idx++; continue; } // this spot stays a gate
    th.resources.stone -= WALL_STONE_COST;
    grid[r][c] = WALL;
    clearBuriedResource(r, c);
    recordDiscovery(WALL);
    plan.idx++; plan.built++; placed++;
  }
  if (plan.idx >= cells.length && !plan.done) {
    plan.done = true;
    addParticles(th.r, th.c, '#b0bec5', 8);
    addChronicle(townLabel(th) + ' finished its walls (' + plan.built + ' segments)');
    logEvent('🧱 ' + townLabel(th) + ' finished its walls — raiders must take the gates', 'good');
    sfx('build');
  }
  return placed > 0;
}

// ── Military ──────────────────────────────────────────────────────────────────
// A militia town drafts 1 soldier per 5 citizens (max 6), ablest first.
// Soldiers gather nothing: they patrol near the hall in peace, march on the
// enemy hall in war, and haul stolen stockpile home. When soldiers of warring
// towns meet, they skirmish — the fallen release souls like any other death.

function militiaTargetCount(th) {
  if (!th.militia) return 0;
  const pop = citizensOf(th).length;
  if (pop < TOWN_MIN_POP) return 0;         // too few hands to spare
  if (foodTicksFor(th) < 5 && !isAtWar(th)) return 0; // famine: spears down, baskets up
  return clamp(Math.floor(pop / SOLDIER_RATIO), 1, MAX_SOLDIERS);
}

function draftSoldiers(th) {
  const target = militiaTargetCount(th);
  const soldiers = soldiersOf(th);
  // Stand down the surplus
  while (soldiers.length > target) {
    const p = soldiers.pop();
    p.job = 'gatherer'; p.mode = 'gather'; p.warTarget = null;
  }
  if (soldiers.length >= target) return;
  // Draft the ablest free citizens (never workers mid-shift, missions, or the last gatherers)
  const candidates = citizensOf(th).filter(p =>
    p.job !== 'soldier' && p.job !== 'worker'
    && p.mode !== 'explore' && p.mode !== 'found');
  candidates.sort((a, b) => (b.level || 0) - (a.level || 0));
  let need = target - soldiers.length;
  let drafted = 0;
  for (const p of candidates) {
    if (need <= 0) break;
    if (candidates.length - drafted <= 2) break; // leave hands to gather
    p.job = 'soldier';
    p.mode = 'patrol';
    p.gatherTarget = null; p.warTarget = null;
    need--; drafted++;
  }
}

// ── Wars ──────────────────────────────────────────────────────────────────────

function startWar(attTh, defTh) {
  wars.push({
    attackerId: attTh.id, defenderId: defTh.id,
    startTick: simTick, endTick: simTick + WAR_LENGTH,
    loot: 0, attackerLosses: 0, defenderLosses: 0, razed: 0,
  });
  records.warsWaged++;
  addChronicle(townLabel(attTh) + ' declared war on ' + townLabel(defTh));
  logEvent('⚔️ ' + townLabel(attTh) + ' marches to war on ' + townLabel(defTh) + '!', 'bad');
  showBanner('⚔️ WAR ⚔️');
  sfx('bad');
}

function endWar(war, reason) {
  const i = wars.indexOf(war);
  if (i !== -1) wars.splice(i, 1);
  const att = townById(war.attackerId), def = townById(war.defenderId);
  // Both towns need time to lick their wounds before the next war measure
  if (att) att.lastWarEndTick = simTick;
  if (def) def.lastWarEndTick = simTick;
  const attName = att ? townLabel(att) : 'a fallen town';
  const defName = def ? townLabel(def) : 'a fallen town';
  const fallen = (war.attackerLosses || 0) + (war.defenderLosses || 0);
  const summary = Math.floor(war.loot || 0) + ' plundered, '
    + (war.razed || 0) + ' buildings razed, ' + fallen + ' fallen';
  const text = reason === 'peace'    ? attName + ' sued for peace with ' + defName
             : reason === 'routed'   ? 'the attackers from ' + attName + ' were wiped out'
             : 'the war between ' + attName + ' and ' + defName + ' burned out';
  addChronicle(text + ' (' + summary + ')');
  logEvent('🏳 ' + text + ' — ' + summary, 'info');
  showBanner('🏳 peace 🏳');
  // Soldiers heading home with loot keep hauling; the rest fall back to patrol next tick
}

// A soldier's death in battle is still a harvest — souls flow home regardless
function fallInBattle(p, war, wasAttacker) {
  const r = Math.round(p.y), c = Math.round(p.x);
  const yield_ = soulYield(p);
  souls += yield_;
  records.soulsHarvested += yield_;
  records.totalDeaths++;
  records.battleDeaths++;
  if (wasAttacker) war.attackerLosses++; else war.defenderLosses++;
  addSoulWisp(r, c, Math.min(yield_, 8));
  addParticles(r, c, '#e53935', 6);
  // Loot they carried spills where they fell
  const total = carriedTotal(p);
  if (total > 0 && inBounds(r, c) && !resourceMap[r][c]) {
    const dominant = RES_KINDS.reduce((a, b) => ((p[a] || 0) >= (p[b] || 0) ? a : b));
    resourceMap[r][c] = { type: dominant, amount: total };
  }
  logEvent('⚔️ ' + p.name + (p.level ? ' (lv ' + p.level + ')' : '') + ' fell in battle — ✨ +' + yield_ + ' souls', 'bad');
  removePerson(p);
  sfx('soul');
}

// Raiders adjacent to the enemy hall stuff their packs from its stockpile
function raidSteal(p, defTh, attTh, war) {
  let space = carryCap(p) - carriedTotal(p);
  let taken = 0;
  const kinds = [...RES_KINDS].sort((a, b) => (defTh.resources[b] || 0) - (defTh.resources[a] || 0));
  for (const k of kinds) {
    if (space <= 0) break;
    const grab = Math.min(space, Math.floor(defTh.resources[k] || 0));
    if (grab <= 0) continue;
    defTh.resources[k] -= grab;
    p[k] = (p[k] || 0) + grab;
    space -= grab; taken += grab;
  }
  if (taken > 0) {
    defTh.lastRaidedTick = simTick;
    defTh.grudgeAgainst = attTh.id; // the seed of the next war
    defTh.grudgeTick = simTick;
    addParticles(defTh.r, defTh.c, '#e53935', 5);
    logEvent('💰 raiders from ' + townLabel(attTh) + ' looted ' + taken + ' from ' + townLabel(defTh), 'bad');
  }
  return taken;
}

// War leaves scars: a raider standing next to an enemy structure tears at it —
// walls are breached, timber is torched (and the fire spreads), stone is
// pulled down. The enemy hall itself is never destroyed and roads/parks are
// spared: wars raid and ruin towns, they don't erase them from the map.
function sackAdjacent(p, defTh, attTh, war) {
  const r = Math.round(p.y), c = Math.round(p.x);
  for (const [dr, dc] of [[-1,0],[1,0],[0,-1],[0,1]]) {
    const nr = r + dr, nc = c + dc;
    if (!inBounds(nr, nc)) continue;
    const t = grid[nr][nc];
    if (t === GRASS || t === ROAD || t === PARK || t === TOWN_HALL) continue;
    if (nearestTownHall(nr, nc) !== defTh) continue; // only the enemy's structures
    let hit = false;
    if (t === WALL) {
      if (Math.random() < RAZE_CHANCE_WALL) {
        demolishTile(nr, nc);
        addParticles(nr, nc, '#b0bec5', 8);
        logEvent('🧱 raiders from ' + townLabel(attTh) + ' breached the walls of ' + townLabel(defTh), 'bad');
        hit = true;
      }
    } else if (FLAMMABLE.has(t)) {
      if (Math.random() < RAZE_CHANCE_TORCH && igniteTile(nr, nc)) {
        logEvent('🔥 raiders from ' + townLabel(attTh) + ' torched a ' + TILE_NAMES[t] + ' in ' + townLabel(defTh), 'bad');
        hit = true;
      }
    } else if (Math.random() < RAZE_CHANCE_STONE) {
      demolishTile(nr, nc);
      addParticles(nr, nc, '#616161', 8);
      logEvent('💥 raiders from ' + townLabel(attTh) + ' tore down a ' + TILE_NAMES[t] + ' in ' + townLabel(defTh), 'bad');
      hit = true;
    }
    if (hit) {
      war.razed = (war.razed || 0) + 1;
      defTh.lastRaidedTick = simTick;
      defTh.grudgeAgainst  = attTh.id; // ruins are remembered
      defTh.grudgeTick     = simTick;
      grantXP(p, 1);
    }
    return; // one structure per soldier per tick, whether the blow landed or not
  }
}

// One skirmish: level, home walls, and luck decide who falls
function skirmish(a, b, war) {
  const power = (p) => {
    let pw = 2 + (p.level || 0) + Math.random() * 4;
    const th = townOf(p);
    // Fighting inside your own finished walls: the stones fight with you
    if (th && hasWalls(th)
        && Math.max(Math.abs(Math.round(p.y) - th.r), Math.abs(Math.round(p.x) - th.c)) <= th.wallPlan.radius)
      pw += 2;
    return pw;
  };
  const aIsAtt = townOf(a)?.id === war.attackerId;
  if (power(a) >= power(b)) fallInBattle(b, war, !aIsAtt);
  else                      fallInBattle(a, war, aIsAtt);
}

// Per-tick military brain: drafts, soldier orders, skirmishes, war endings.
// Soldier counts are tiny (≤6 per town), so this stays cheap.
function militaryTick() {
  if (townHalls.length === 0) return;
  if (simTick % 8 === 5) for (const th of townHalls) if (th.militia || soldiersOf(th).length > 0) draftSoldiers(th);

  // End wars whose time is up, whose towns fell, or whose attackers were routed
  for (const war of [...wars]) {
    const att = townById(war.attackerId), def = townById(war.defenderId);
    if (!att || !def) { endWar(war, 'over'); continue; }
    if (simTick >= war.endTick) { endWar(war, 'over'); continue; }
    if (att.militia && soldiersOf(att).length === 0 && simTick - war.startTick > 8)
      endWar(war, 'routed');
  }

  // Orders for every soldier
  const soldiers = people.filter(p => p.job === 'soldier');
  for (const p of soldiers) {
    const th = townOf(p);
    if (!th) { p.job = 'gatherer'; p.mode = 'gather'; p.warTarget = null; continue; }
    const attackWar = wars.find(w => w.attackerId === th.id);
    const defendWar = wars.find(w => w.defenderId === th.id);

    if (attackWar) {
      // March on the enemy hall; haul any loot home first
      const enemy = townById(attackWar.defenderId);
      p.sleeping = false; p.insideBuilding = false;
      p.mode = 'war';
      p.warTarget = carriedTotal(p) > 0 ? { r: th.r, c: th.c }
                  : enemy ? { r: enemy.r, c: enemy.c } : null;
    } else if (defendWar) {
      // Meet the raiders: intercept the nearest enemy soldier near home, else hold the hall
      const enemy = townById(defendWar.attackerId);
      p.sleeping = false; p.insideBuilding = false;
      p.mode = 'defend';
      let target = null, bestDist = Infinity;
      if (enemy) {
        for (const q of soldiers) {
          if (townOf(q) !== enemy) continue;
          const d = Math.abs(Math.round(q.y) - th.r) + Math.abs(Math.round(q.x) - th.c);
          if (d < 20 && d < bestDist) { bestDist = d; target = { r: Math.round(q.y), c: Math.round(q.x) }; }
        }
      }
      p.warTarget = target || { r: th.r, c: th.c };
    } else if (p.mode === 'war' || p.mode === 'defend'
               || (p.mode !== 'social' && p.mode !== 'home' && !p.sleeping)) {
      // Peacetime: finish hauling loot, then walk the walls
      p.mode = 'patrol';
      p.warTarget = carriedTotal(p) > 0 ? { r: th.r, c: th.c } : null;
      grantXP(p, 0.05); // drilling keeps the spear arm strong
    }
  }

  // Raiding and looting happen where soldiers stand
  const cardinals = [[-1,0],[1,0],[0,-1],[0,1]];
  for (const p of soldiers) {
    if (!people.includes(p)) continue; // fell in a skirmish this tick
    const th = townOf(p);
    if (!th) continue;
    const attackWar = wars.find(w => w.attackerId === th.id);
    const r = Math.round(p.y), c = Math.round(p.x);
    const adjacentToHall = (hall) => hall && cardinals.some(([dr, dc]) =>
      r + dr === hall.r && c + dc === hall.c);
    // Deposit (loot or otherwise) only at their OWN hall — never the enemy's
    if (carriedTotal(p) > 0 && adjacentToHall(th)) {
      let hauled = 0;
      for (const k of RES_KINDS) { hauled += p[k] || 0; th.resources[k] = (th.resources[k] || 0) + (p[k] || 0); p[k] = 0; }
      if (attackWar) attackWar.loot += hauled;
      addParticles(r, c, '#ffd54f', 4);
      grantXP(p, 2);
    } else if (attackWar && carriedTotal(p) < carryCap(p)) {
      const enemy = townById(attackWar.defenderId);
      if (enemy && adjacentToHall(enemy)) raidSteal(p, enemy, th, attackWar);
    }
    // Whatever else they did, raiders in enemy country tear at what they pass
    if (attackWar) {
      const enemy = townById(attackWar.defenderId);
      if (enemy) sackAdjacent(p, enemy, th, attackWar);
    }
  }

  // Skirmishes: soldiers of warring towns within a tile of each other fight
  if (wars.length > 0) {
    const fought = new Set();
    for (const a of soldiers) {
      if (fought.has(a.id) || !people.includes(a)) continue;
      const aTh = townOf(a);
      if (!aTh) continue;
      for (const b of soldiers) {
        if (a === b || fought.has(b.id) || !people.includes(b) || !people.includes(a)) continue;
        const bTh = townOf(b);
        if (!bTh || bTh === aTh) continue;
        const war = wars.find(w =>
          (w.attackerId === aTh.id && w.defenderId === bTh.id) ||
          (w.attackerId === bTh.id && w.defenderId === aTh.id));
        if (!war) continue;
        const dist = Math.abs(Math.round(a.y) - Math.round(b.y)) + Math.abs(Math.round(a.x) - Math.round(b.x));
        if (dist > 1) continue;
        fought.add(a.id); fought.add(b.id);
        skirmish(a, b, war);
        break;
      }
    }
  }
}
