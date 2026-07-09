// ═══ citybuilder/js/07-politics.js ════════════════════════════════════
// Civilization-wide direct democracy: referendums, ballots, campaigns, enacted laws.
// Classic script (no modules): top-level declarations are shared with the
// other js/ files. index.html loads these in numbered order — load order
// matters for top-level code. See citybuilder/CLAUDE.md before editing.

// ── Politics: referendums ─────────────────────────────────────────────────────

// A citizen's leaning on a policy, judged from their own circumstances (-1 … 1).
// Circumstances means their own town's — a citizen votes their home hall's
// fortunes even when the day's gathering has carried them somewhere else.
function policySupport(key, p) {
  const th = townOf(p);
  if (!th) return 0;
  return clamp(POLICIES[key].support(p, th), -1, 1);
}

function avgSupport(key) {
  if (people.length === 0) return 0;
  let sum = 0;
  for (const p of people) sum += policySupport(key, p);
  return sum / people.length;
}

// A citizen's yes-leaning on the current ballot: a repeal measure passes on the
// votes of those who dislike the law, so the sign flips. Campaigns shift everyone.
function ballotLeaning(p) {
  const b = politics.ballot;
  const s = policySupport(b.key, p);
  return (b.kind === 'repeal' ? -s : s) + (b.for - b.against) * CAMPAIGN_SWING;
}

// Poll: projected yes share (%). The real vote adds private noise per voter.
function pollBallot() {
  if (!politics.ballot || people.length === 0) return 50;
  let yes = 0;
  for (const p of people) if (ballotLeaning(p) > 0) yes++;
  return Math.round((yes / people.length) * 100);
}

function announceBallot() {
  politics.announcedFor = politics.nextReferendumTick;

  // Retraction comes first: any law the people have turned against goes back
  // to the ballot before anything new is proposed — bad laws correct themselves.
  let measure = null, worstAvg = -0.05;
  for (const key of politics.enacted) {
    const a = avgSupport(key);
    if (a < worstAvg) { worstAvg = a; measure = { key, kind: 'repeal' }; }
  }
  if (!measure) {
    // Otherwise the most-wanted new law is proposed
    let bestAvg = -0.15; // nothing wildly unpopular reaches the ballot
    for (const [key, pol] of Object.entries(POLICIES)) {
      if (politics.enacted.includes(key) || !pol.unlocked()) continue;
      const a = avgSupport(key);
      if (a > bestAvg) { bestAvg = a; measure = { key, kind: 'enact' }; }
    }
  }
  if (!measure) return; // nothing worth voting on this cycle
  politics.ballot = { ...measure, for: 0, against: 0 };
  const pol = POLICIES[measure.key];
  logEvent('🗳 on tomorrow\'s ballot: ' + (measure.kind === 'repeal' ? 'repeal the ' : 'the ')
    + pol.emoji + ' ' + pol.name, 'info');
}

function holdReferendum() {
  const b = politics.ballot;
  politics.ballot = null;
  if (!b) return;
  const pol = POLICIES[b.key];
  let yes = 0, no = 0;
  const shift = (b.for - b.against) * CAMPAIGN_SWING;
  for (const p of people) {
    const s = (b.kind === 'repeal' ? -1 : 1) * policySupport(b.key, p)
            + shift + (Math.random() * 2 - 1) * VOTE_NOISE;
    if (s > 0) yes++; else no++;
  }
  const passed = yes > no;
  const tally = yes + '–' + no;
  if (b.kind === 'enact') {
    if (passed) {
      politics.enacted.push(b.key);
      addChronicle('the people enacted the ' + pol.name + ' (' + tally + ')');
      logEvent('🗳 the ' + pol.name + ' passes, ' + tally + ' — it is now law', 'good');
      showBanner(pol.emoji + ' ' + pol.name + ' enacted ' + pol.emoji);
      sfx('era');
    } else {
      logEvent('🗳 the ' + pol.name + ' fails at the ballot box, ' + tally, 'info');
    }
  } else if (passed) {
    politics.enacted = politics.enacted.filter(k => k !== b.key);
    addChronicle('the people repealed the ' + pol.name + ' (' + tally + ')');
    logEvent('🗳 the ' + pol.name + ' is repealed, ' + tally + ' — the law is struck down', 'info');
    showBanner('🗳 ' + pol.name + ' repealed 🗳');
    sfx('bad');
  } else {
    logEvent('🗳 the ' + pol.name + ' survives its repeal vote, ' + tally, 'info');
  }
}

function politicsTick() {
  if (townHalls.length === 0) return;
  if (politics.nextReferendumTick === 0) {
    if (people.length < POLITICS_MIN_POP) return;
    politics.nextReferendumTick = simTick + REFERENDUM_INTERVAL;
    addChronicle("the people formed a citizens' assembly");
    logEvent('🗳 the town is big enough to talk politics — the first referendum is in 2 days', 'good');
    return;
  }
  if (!politics.ballot && politics.announcedFor !== politics.nextReferendumTick
      && simTick >= politics.nextReferendumTick - BALLOT_NOTICE) {
    announceBallot();
  }
  if (simTick >= politics.nextReferendumTick) {
    holdReferendum();
    politics.nextReferendumTick = simTick + REFERENDUM_INTERVAL;
  }
}

// Under the public feasts law, every town that can spare the food opens the
// new season with a free festival (same effect as the paid power)
function holdPublicFeasts() {
  let held = 0;
  for (const th of townHalls) {
    if (th.resources.food >= FEAST_FOOD_COST && (th.festivalUntil || 0) <= simTick) {
      th.resources.food -= FEAST_FOOD_COST;
      th.festivalUntil = simTick + FESTIVAL_LENGTH;
      held++;
    }
  }
  if (held > 0) logEvent('🎪 public feast day — the new season opens with festivals, as the law demands', 'good');
}

// Player nudge: gold buys rallies for or against the measure on the ballot
function campaign(side) {
  const b = politics.ballot;
  if (!b) { logEvent('no measure is on the ballot right now'); return; }
  if (b[side] >= CAMPAIGN_MAX) { logEvent('the streets are already saturated with that message'); return; }
  if (gold < POWER_COSTS.campaign) { logEvent('need $' + POWER_COSTS.campaign + ' to campaign'); return; }
  gold -= POWER_COSTS.campaign;
  b[side]++;
  const pol = POLICIES[b.key];
  logEvent('📣 rallies ' + side + ' the ' + (b.kind === 'repeal' ? 'repeal of the ' : '')
    + pol.name + ' fill the squares', 'info');
  sfx('coin');
  updateUI();
}
