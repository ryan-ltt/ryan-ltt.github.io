// Side-by-side archetype round-robin: current (static-only trade evaluation) BEST_GENOME vs the
// same genome with tradeLookahead enabled (Monte Carlo forward simulation for trade accept/reject
// decisions - see evaluateTradeWithLookahead in strategy.js), tested against the same hand-crafted
// archetype set used to validate every prior round (gridsearch3.js's archetypeRoundRobin / round-4's
// compare-round4-archetypes.js). Answers: does the lookahead edge (27-28.6% seen head-to-head vs
// the static anchor at n=2000/5000) hold up broadly, or is it a narrow win that costs ground
// elsewhere? tradeLookahead is much more expensive per game (~20x), so this uses a smaller
// games-per-matchup than the round-4 archetype comparison to keep runtime reasonable.

const { compareGenome, DEFAULT_GENOME } = require('./simulate');
const { BEST_GENOME: STATIC_BEST } = require('../js/strategy.js');

const LOOKAHEAD_BEST = Object.assign({}, STATIC_BEST, {
	tradeLookahead: true,
	tradeLookaheadRollouts: 6,
	tradeLookaheadTurns: 15
});

const archetypes = {
	aggressiveBuyer: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.9, minCashReserve: 30, monopolyPremium: 1.0, riskAversion: 0.1 }),
	conservative: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.15, minCashReserve: 500, riskAversion: 0.9, buildThreshold: 600 }),
	monopolyFocused: Object.assign({}, DEFAULT_GENOME, { monopolyPremium: 3.0, tradeWillingness: 1.0, tradeFairnessMargin: 0.9, auctionMonopolyBonus: 2.5 }),
	jailCamper: Object.assign({}, DEFAULT_GENOME, { jailStayEarlyGame: true, jailPayThreshold: 0.9, lateGameAlwaysPay: false }),
	railCollector: Object.assign({}, DEFAULT_GENOME, { railValue: 1.8, utilityValue: 1.2, monopolyPremium: 1.0 }),
	blocker: Object.assign({}, DEFAULT_GENOME, { blockingAwareness: 0.75, tradeFairnessMargin: 0.9 }),
	groupHoarder: Object.assign({}, STATIC_BEST, { tradeWillingness: 1.0, tradeFairnessMargin: 1.0, tradeMonopolyDrive: 3.0 }), // the human-exploit stand-in
	default: DEFAULT_GENOME,
	staticBest: STATIC_BEST
};

const GAMES_PER_SEAT = 100; // 400 games per matchup per genome (smaller than round-4's 300/seat since tradeLookahead is ~20x slower per game)

async function runAll() {
	console.log('Comparing STATIC (current) BEST_GENOME vs LOOKAHEAD (tradeLookahead=true) BEST_GENOME against the same archetype set.');
	console.log(`${GAMES_PER_SEAT * 4} games per matchup per genome.\n`);
	console.log('Archetype'.padEnd(16), 'Static win%'.padStart(12), 'Lookahead win%'.padStart(15), 'Delta'.padStart(8));
	let staticTotalWins = 0, lookaheadTotalWins = 0, totalN = 0;
	const t0 = Date.now();
	for (const [name, genome] of Object.entries(archetypes)) {
		const seedBase = 61000 + name.length * 977;
		const staticRes = await compareGenome(STATIC_BEST, genome, GAMES_PER_SEAT, seedBase);
		const lookaheadRes = await compareGenome(LOOKAHEAD_BEST, genome, GAMES_PER_SEAT, seedBase + 500000);
		staticTotalWins += staticRes.wins; lookaheadTotalWins += lookaheadRes.wins; totalN += staticRes.n;
		const delta = (lookaheadRes.winRate - staticRes.winRate) * 100;
		console.log(
			name.padEnd(16),
			(staticRes.winRate * 100).toFixed(1).padStart(11) + '%',
			(lookaheadRes.winRate * 100).toFixed(1).padStart(14) + '%',
			(delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp'
		);
		console.log(`  [elapsed: ${((Date.now() - t0) / 1000).toFixed(0)}s]`);
	}
	console.log(`\nAggregate across all archetypes: static=${((staticTotalWins / totalN) * 100).toFixed(1)}%  lookahead=${((lookaheadTotalWins / totalN) * 100).toFixed(1)}%  (n=${totalN} each)`);

	console.log('\n--- Direct head-to-head ---');
	const direct = await compareGenome(LOOKAHEAD_BEST, STATIC_BEST, 300, 999999);
	console.log(`Lookahead vs Static direct: ${(direct.winRate * 100).toFixed(1)}% (n=${direct.n})`);
	console.log(`\nTotal time: ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

runAll();
