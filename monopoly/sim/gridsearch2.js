// Second-round grid search: refines the existing BEST_GENOME (from gridsearch.js's first run)
// rather than starting from DEFAULT_GENOME, adds 4 new parameters that weren't modeled in the
// first pass (build order preference, jail-card hoarding economics, opponent-blocking awareness,
// even house-selling), and uses a much higher games-per-candidate to cut through the noise that
// caused several parameters to flip-flop between passes last time.

const { compareGenome, DEFAULT_GENOME } = require('./simulate');
const { BEST_GENOME } = require('../js/strategy.js');

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
	// --- new dimensions ---
	buildCheapGroupsFirst: [true, false],
	keepJailCardLateGame: [true, false],
	blockingAwareness: [0.0, 0.15, 0.3, 0.5, 0.75],
	sellHouseEvenly: [true, false]
};

const GAMES_PER_SEAT = 150; // 4 seats -> 600 games per candidate evaluation (vs 240 in round 1)
const PASSES = 2;

async function evaluate(candidate, baseline, seedOffset) {
	const { winRate } = await compareGenome(candidate, baseline, GAMES_PER_SEAT, seedOffset);
	return winRate;
}

async function coordinateAscent(startGenome) {
	let best = Object.assign({}, startGenome);
	let seedCounter = 200000; // separate seed space from round 1
	let totalGames = 0;
	const history = [];

	for (let pass = 1; pass <= PASSES; pass++) {
		console.log(`\n=== PASS ${pass} ===`);
		for (const param of Object.keys(PARAM_GRID)) {
			const values = PARAM_GRID[param];
			let bestVal = best[param];
			let bestRate = -1;
			const results = [];
			for (const val of values) {
				const candidate = Object.assign({}, best, { [param]: val });
				seedCounter++;
				const rate = await evaluate(candidate, best, seedCounter);
				totalGames += GAMES_PER_SEAT * 4;
				results.push({ val, rate });
				if (rate > bestRate) { bestRate = rate; bestVal = val; }
			}
			const changed = bestVal !== best[param];
			best[param] = bestVal;
			console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> best=${bestVal}${changed ? ' (changed)' : ''}`);
			history.push({ pass, param, results, chosen: bestVal });
		}
		console.log(`[running total: ${totalGames.toLocaleString()} games]`);
	}
	return { best, history, totalGames };
}

async function archetypeRoundRobin(best) {
	console.log('\n=== ARCHETYPE SANITY CHECKS (round 2 genome vs hand-crafted) ===');
	const archetypes = {
		aggressiveBuyer: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.9, minCashReserve: 30, monopolyPremium: 1.0, riskAversion: 0.1 }),
		conservative: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.15, minCashReserve: 500, riskAversion: 0.9, buildThreshold: 600 }),
		monopolyFocused: Object.assign({}, DEFAULT_GENOME, { monopolyPremium: 3.0, tradeWillingness: 1.0, tradeFairnessMargin: 0.9, auctionMonopolyBonus: 2.5 }),
		jailCamper: Object.assign({}, DEFAULT_GENOME, { jailStayEarlyGame: true, jailPayThreshold: 0.9, lateGameAlwaysPay: false }),
		railCollector: Object.assign({}, DEFAULT_GENOME, { railValue: 1.8, utilityValue: 1.2, monopolyPremium: 1.0 }),
		blocker: Object.assign({}, DEFAULT_GENOME, { blockingAwareness: 0.75, tradeFairnessMargin: 0.9 }),
		default: DEFAULT_GENOME,
		roundOneBest: BEST_GENOME
	};
	let n = 0;
	for (const [name, genome] of Object.entries(archetypes)) {
		const { winRate, n: matchN } = await compareGenome(best, genome, 150, 9001 + name.length);
		n += matchN;
		console.log(`Round2 genome vs ${name}: ${(winRate * 100).toFixed(1)}% win rate (n=${matchN})`);
	}
	return n;
}

(async () => {
	const t0 = Date.now();
	console.log('Starting coordinate ascent from round-1 BEST_GENOME...');
	const { best, totalGames } = await coordinateAscent(BEST_GENOME);
	console.log('\n=== ROUND 2 BEST GENOME ===');
	console.log(JSON.stringify(best, null, 2));

	console.log('\n=== FINAL CONFIRMATION (large n vs round-1 best) ===');
	const conf = await compareGenome(best, BEST_GENOME, 1000, 555000);
	console.log(`Round2 genome win rate vs round-1 BEST_GENOME: ${(conf.winRate * 100).toFixed(2)}% (n=${conf.n})`);

	const archN = await archetypeRoundRobin(best);

	const grandTotal = totalGames + conf.n + archN;
	console.log(`\nTotal games this run: ${grandTotal.toLocaleString()}`);
	console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	const fs = require('fs');
	fs.writeFileSync(require('path').join(__dirname, 'best-genome-round2.json'), JSON.stringify(best, null, 2));
	console.log('\nWrote best-genome-round2.json');
})().catch(e => { console.error(e); process.exit(1); });
