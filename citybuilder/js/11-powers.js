// ═══ citybuilder/js/11-powers.js ══════════════════════════════════════
// Player gold powers: pave road, supply drops, festivals, charter expeditions, vote swaying.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

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
