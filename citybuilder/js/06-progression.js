// ═══ citybuilder/js/06-progression.js ═════════════════════════════════
// The four soul upgrades, the research tree, and per-town happiness computation.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
    if (lawActive('open_borders')) spawnChance *= 1.5;
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
  th.nearFactories = factories; // cached for policy support checks
  const parkBonus   = lawActive('greenbelt')     ? 8 : 5;
  const factoryCost = lawActive('clean_air_act') ? 4 : 10;
  let h = 70 + parks * parkBonus + wells * 3 - factories * factoryCost;
  if (lawActive('eight_hour_day')) h += 6;
  if (lawActive('rationing'))      h -= 6;
  if (lawActive('church_tithe'))   h -= 3;
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
  if (isAtWar(th)) h -= 8;                                    // war weariness
  if (simTick - (th.lastRaidedTick ?? -99999) < DAY_LENGTH) h -= 5; // raided within the day
  if (hasWalls(th)) h += 3;                                   // safe behind the stones
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
