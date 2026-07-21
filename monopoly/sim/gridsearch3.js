// Third-round grid search: fixes a methodology bug found in gridsearch2.js. Standard coordinate
// ascent compares each candidate only against the "running best" genome, which lets baseline
// drift compound — if a noisy/wrong choice slips in early in a pass, every later parameter in
// that pass is evaluated against an already-weakened baseline, so more bad choices can slip in
// looking like improvements. (Caught this because a genome from that run tested at 20-24% win
// rate against the true round-1 best in a dedicated head-to-head, despite "winning" every
// individual coordinate-ascent step against its own drifting baseline.)
//
// Fix: after each parameter's coordinate-ascent step, re-validate the newly-accepted genome
// against the ORIGINAL fixed anchor genome (not the running best) at moderate n. Only keep the
// change if it doesn't regress vs the anchor beyond noise; otherwise revert that parameter to
// the anchor's value and move on. This trades a bit of ground-covering speed for a monotonic
// guarantee: the genome can only get better (or stay flat) relative to the anchor as the search
// proceeds, never silently worse.

const { compareGenome, DEFAULT_GENOME } = require('./simulate');
const { BEST_GENOME: ANCHOR } = require('../js/strategy.js');

const PARAM_GRID = {
	buyThreshold: [0.1, 0.2, 0.35, 0.5, 0.65, 0.8],
	minCashReserve: [50, 100, 150, 200, 300, 400],
	monopolyPremium: [1.0, 1.25, 1.5, 1.75, 2.0, 2.5],
	utilityValue: [0.3, 0.45, 0.6, 0.75, 0.9],
	railValue: [0.6, 0.8, 1.0, 1.2, 1.4],
	auctionAggressiveness: [0.4, 0.6, 0.8, 1.0, 1.2, 1.4],
	auctionMonopolyBonus: [1.0, 1.2, 1.4, 1.6, 1.8, 2.2],
	buildThreshold: [100, 200, 300, 400, 500, 700],
	buildUpToHotel: [true, false],
	jailStayEarlyGame: [true, false],
	jailPayThreshold: [0.2, 0.35, 0.5, 0.65, 0.8],
	lateGameAlwaysPay: [true, false],
	tradeWillingness: [0.0, 0.25, 0.5, 0.75, 1.0],
	tradeFairnessMargin: [0.9, 1.0, 1.15, 1.3, 1.5, 1.75],
	tradeMonopolyDrive: [1.0, 1.5, 2.0, 2.5, 3.0],
	mortgageBeforeSellHouse: [true, false],
	riskAversion: [0.1, 0.3, 0.5, 0.7, 0.9],
	buildCheapGroupsFirst: [true, false],
	keepJailCardLateGame: [true, false],
	blockingAwareness: [0.0, 0.15, 0.3, 0.5, 0.75],
	sellHouseEvenly: [true, false]
};

const STEP_GAMES_PER_SEAT = 100; // 400 games to pick a candidate value for a parameter
const VALIDATE_GAMES_PER_SEAT = 150; // 600 games to validate the accepted change against the anchor
const VALIDATE_MARGIN = 0.02; // require accepted change to be within -2pp of anchor (allow slight noise) or better
const PASSES = 2;

async function evaluate(candidate, baseline, gamesPerSeat, seedOffset) {
	const { winRate } = await compareGenome(candidate, baseline, gamesPerSeat, seedOffset);
	return winRate;
}

async function driftSafeAscent(anchor) {
	let current = Object.assign({}, anchor);
	let seedCounter = 300000;
	let totalGames = 0;
	let accepted = 0, reverted = 0;
	const history = [];

	for (let pass = 1; pass <= PASSES; pass++) {
		console.log(`\n=== PASS ${pass} ===`);
		for (const param of Object.keys(PARAM_GRID)) {
			const values = PARAM_GRID[param];
			let bestVal = current[param];
			let bestRate = -1;
			const results = [];
			// Step 1: pick the best-looking value by comparing each candidate to CURRENT (fast, noisy)
			for (const val of values) {
				const candidate = Object.assign({}, current, { [param]: val });
				seedCounter++;
				const rate = await evaluate(candidate, current, STEP_GAMES_PER_SEAT, seedCounter);
				totalGames += STEP_GAMES_PER_SEAT * 4;
				results.push({ val, rate });
				if (rate > bestRate) { bestRate = rate; bestVal = val; }
			}
			const proposed = Object.assign({}, current, { [param]: bestVal });
			// Step 2: validate the FULL proposed genome against the fixed ANCHOR, not `current`.
			seedCounter++;
			const anchorCheck = await evaluate(proposed, anchor, VALIDATE_GAMES_PER_SEAT, seedCounter + 50000);
			totalGames += VALIDATE_GAMES_PER_SEAT * 4;
			const changed = bestVal !== current[param];
			if (changed && anchorCheck < 0.25 - VALIDATE_MARGIN) {
				// this change (combined with everything accepted so far) regresses vs the anchor - revert
				console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> candidate=${bestVal} REJECTED (vs anchor: ${(anchorCheck*100).toFixed(1)}%, reverting to ${current[param]})`);
				reverted++;
			} else {
				current[param] = bestVal;
				console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> best=${bestVal}${changed ? ` (changed, vs anchor: ${(anchorCheck*100).toFixed(1)}%)` : ''}`);
				if (changed) accepted++;
			}
			history.push({ pass, param, results, chosen: current[param], anchorCheck });
		}
		console.log(`[running total: ${totalGames.toLocaleString()} games, ${accepted} accepted changes, ${reverted} reverted]`);
	}
	return { best: current, history, totalGames, accepted, reverted };
}

async function archetypeRoundRobin(best) {
	console.log('\n=== ARCHETYPE SANITY CHECKS ===');
	const archetypes = {
		aggressiveBuyer: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.9, minCashReserve: 30, monopolyPremium: 1.0, riskAversion: 0.1 }),
		conservative: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.15, minCashReserve: 500, riskAversion: 0.9, buildThreshold: 600 }),
		monopolyFocused: Object.assign({}, DEFAULT_GENOME, { monopolyPremium: 3.0, tradeWillingness: 1.0, tradeFairnessMargin: 0.9, auctionMonopolyBonus: 2.5 }),
		jailCamper: Object.assign({}, DEFAULT_GENOME, { jailStayEarlyGame: true, jailPayThreshold: 0.9, lateGameAlwaysPay: false }),
		railCollector: Object.assign({}, DEFAULT_GENOME, { railValue: 1.8, utilityValue: 1.2, monopolyPremium: 1.0 }),
		blocker: Object.assign({}, DEFAULT_GENOME, { blockingAwareness: 0.75, tradeFairnessMargin: 0.9 }),
		default: DEFAULT_GENOME,
		roundOneAnchor: ANCHOR
	};
	let n = 0;
	for (const [name, genome] of Object.entries(archetypes)) {
		const { winRate, n: matchN } = await compareGenome(best, genome, 200, 9001 + name.length);
		n += matchN;
		console.log(`Round3 genome vs ${name}: ${(winRate * 100).toFixed(1)}% win rate (n=${matchN})`);
	}
	return n;
}

(async () => {
	const t0 = Date.now();
	console.log('Starting drift-safe coordinate ascent, anchored to round-1 BEST_GENOME...');
	const { best, totalGames, accepted, reverted } = await driftSafeAscent(ANCHOR);
	console.log(`\n=== ROUND 3 BEST GENOME (${accepted} changes accepted, ${reverted} reverted for regressing vs anchor) ===`);
	console.log(JSON.stringify(best, null, 2));

	console.log('\n=== FINAL CONFIRMATION (large n vs round-1 anchor) ===');
	const conf = await compareGenome(best, ANCHOR, 1000, 555000);
	console.log(`Round3 genome win rate vs round-1 anchor: ${(conf.winRate * 100).toFixed(2)}% (n=${conf.n})`);

	console.log('\n=== FINAL CONFIRMATION (large n vs default baseline) ===');
	const confDefault = await compareGenome(best, DEFAULT_GENOME, 1000, 777000);
	console.log(`Round3 genome win rate vs default baseline: ${(confDefault.winRate * 100).toFixed(2)}% (n=${confDefault.n})`);

	const archN = await archetypeRoundRobin(best);

	const grandTotal = totalGames + conf.n + confDefault.n + archN;
	console.log(`\nTotal games this run: ${grandTotal.toLocaleString()}`);
	console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	const fs = require('fs');
	fs.writeFileSync(require('path').join(__dirname, 'best-genome-round3.json'), JSON.stringify(best, null, 2));
	console.log('\nWrote best-genome-round3.json');
})().catch(e => { console.error(e); process.exit(1); });
