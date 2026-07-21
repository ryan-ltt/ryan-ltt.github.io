// Extensive grid search over strategy parameters to find the best-performing genome.
// Approach: coordinate ascent over a hand-picked grid for each parameter (holding others at
// current-best), several passes, each parameter tested with seat-rotated matches against the
// current-best baseline. This is far cheaper than full factorial (which would be astronomical)
// while still exploring each dimension thoroughly - true "extensive" grid search per parameter.
//
// After coordinate ascent converges, run a final large-n confirmation match and a round-robin
// sanity check against a few hand-crafted archetype strategies (aggressive buyer, conservative,
// monopoly-focused, jail-camper) to make sure the learned genome isn't just beating itself.

const { compareGenome, runMatch, DEFAULT_GENOME } = require('./simulate');

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
	riskAversion: [0.1, 0.3, 0.5, 0.7, 0.9]
};

const GAMES_PER_SEAT = 60; // 4 seats -> 240 games per candidate evaluation
const PASSES = 3;

async function evaluate(candidate, baseline, seedOffset) {
	const { winRate } = await compareGenome(candidate, baseline, GAMES_PER_SEAT, seedOffset);
	return winRate;
}

async function coordinateAscent() {
	let best = Object.assign({}, DEFAULT_GENOME);
	let seedCounter = 0;
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
				results.push({ val, rate });
				if (rate > bestRate) { bestRate = rate; bestVal = val; }
			}
			const changed = bestVal !== best[param];
			best[param] = bestVal;
			console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> best=${bestVal}${changed ? ' (changed)' : ''}`);
			history.push({ pass, param, results, chosen: bestVal });
		}
	}
	return { best, history };
}

async function archetypeRoundRobin(best) {
	console.log('\n=== ARCHETYPE SANITY CHECKS (learned vs hand-crafted) ===');
	const archetypes = {
		aggressiveBuyer: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.9, minCashReserve: 30, monopolyPremium: 1.0, riskAversion: 0.1 }),
		conservative: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.15, minCashReserve: 500, riskAversion: 0.9, buildThreshold: 600 }),
		monopolyFocused: Object.assign({}, DEFAULT_GENOME, { monopolyPremium: 3.0, tradeWillingness: 1.0, tradeFairnessMargin: 0.9, auctionMonopolyBonus: 2.5 }),
		jailCamper: Object.assign({}, DEFAULT_GENOME, { jailStayEarlyGame: true, jailPayThreshold: 0.9, lateGameAlwaysPay: false }),
		railCollector: Object.assign({}, DEFAULT_GENOME, { railValue: 1.8, utilityValue: 1.2, monopolyPremium: 1.0 }),
		default: DEFAULT_GENOME
	};
	for (const [name, genome] of Object.entries(archetypes)) {
		const { winRate, n } = await compareGenome(best, genome, 75, 9001 + name.length);
		console.log(`Learned vs ${name}: ${(winRate * 100).toFixed(1)}% win rate (n=${n})`);
	}
}

(async () => {
	const t0 = Date.now();
	const { best } = await coordinateAscent();
	console.log('\n=== FINAL BEST GENOME ===');
	console.log(JSON.stringify(best, null, 2));

	console.log('\n=== FINAL CONFIRMATION (large n vs default baseline) ===');
	const conf = await compareGenome(best, DEFAULT_GENOME, 500, 555);
	console.log(`Best genome win rate vs default baseline: ${(conf.winRate * 100).toFixed(2)}% (n=${conf.n})`);

	await archetypeRoundRobin(best);

	console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);

	const fs = require('fs');
	fs.writeFileSync(require('path').join(__dirname, 'best-genome.json'), JSON.stringify(best, null, 2));
	console.log('\nWrote best-genome.json');
})().catch(e => { console.error(e); process.exit(1); });
