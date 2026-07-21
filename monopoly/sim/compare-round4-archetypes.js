// Side-by-side archetype round-robin: old (round-3) BEST_GENOME vs new (round-4, group-scarcity-
// aware) BEST_GENOME, each tested against the same hand-crafted archetype set used to validate
// every prior round (gridsearch3.js's archetypeRoundRobin), plus the "group hoarder" exploit
// stand-in from gridsearch4.js's stress test. Answers: did the round-4 scarcity fix cost ground
// against any other strategy, or is it a clean win across the board?

const { compareGenome, DEFAULT_GENOME } = require('./simulate');
const { BEST_GENOME: NEW_BEST, makeBotAgent } = require('../js/strategy.js');

// Round-3 anchor exactly as it was BEFORE the round-4 change (groupScarcityPremium=0,
// chaseLastPieceDrive absent -> defaults to 1.0 no-op via makeBotAgent's Object.assign).
const OLD_BEST = Object.assign({}, NEW_BEST, { groupScarcityPremium: 0.0, chaseLastPieceDrive: 1.0 });

const archetypes = {
	aggressiveBuyer: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.9, minCashReserve: 30, monopolyPremium: 1.0, riskAversion: 0.1 }),
	conservative: Object.assign({}, DEFAULT_GENOME, { buyThreshold: 0.15, minCashReserve: 500, riskAversion: 0.9, buildThreshold: 600 }),
	monopolyFocused: Object.assign({}, DEFAULT_GENOME, { monopolyPremium: 3.0, tradeWillingness: 1.0, tradeFairnessMargin: 0.9, auctionMonopolyBonus: 2.5 }),
	jailCamper: Object.assign({}, DEFAULT_GENOME, { jailStayEarlyGame: true, jailPayThreshold: 0.9, lateGameAlwaysPay: false }),
	railCollector: Object.assign({}, DEFAULT_GENOME, { railValue: 1.8, utilityValue: 1.2, monopolyPremium: 1.0 }),
	blocker: Object.assign({}, DEFAULT_GENOME, { blockingAwareness: 0.75, tradeFairnessMargin: 0.9 }),
	groupHoarder: Object.assign({}, OLD_BEST, { tradeWillingness: 1.0, tradeFairnessMargin: 1.0, tradeMonopolyDrive: 3.0 }), // the human-exploit stand-in
	default: DEFAULT_GENOME,
	oldBest: OLD_BEST
};

const GAMES_PER_SEAT = 300; // 1200 games per matchup, per genome under test

async function runAll() {
	console.log('Comparing OLD (round-3) BEST_GENOME vs NEW (round-4) BEST_GENOME against the same archetype set.');
	console.log(`${GAMES_PER_SEAT * 4} games per matchup per genome.\n`);
	console.log('Archetype'.padEnd(16), 'Old win%'.padStart(10), 'New win%'.padStart(10), 'Delta'.padStart(8));
	let oldTotalWins = 0, newTotalWins = 0, totalN = 0;
	for (const [name, genome] of Object.entries(archetypes)) {
		const seedBase = 31000 + name.length * 977;
		const oldRes = await compareGenome(OLD_BEST, genome, GAMES_PER_SEAT, seedBase);
		const newRes = await compareGenome(NEW_BEST, genome, GAMES_PER_SEAT, seedBase + 500000);
		oldTotalWins += oldRes.wins; newTotalWins += newRes.wins; totalN += oldRes.n;
		const delta = (newRes.winRate - oldRes.winRate) * 100;
		console.log(
			name.padEnd(16),
			(oldRes.winRate * 100).toFixed(1).padStart(9) + '%',
			(newRes.winRate * 100).toFixed(1).padStart(9) + '%',
			(delta >= 0 ? '+' : '') + delta.toFixed(1) + 'pp'
		);
	}
	console.log(`\nAggregate across all archetypes: old=${((oldTotalWins/totalN)*100).toFixed(1)}%  new=${((newTotalWins/totalN)*100).toFixed(1)}%  (n=${totalN} each)`);

	// direct head-to-head, both directions, for a clean confirmation number
	console.log('\n--- Direct head-to-head (already known, included for completeness) ---');
	const direct = await compareGenome(NEW_BEST, OLD_BEST, 750, 999999);
	console.log(`New vs Old direct: ${(direct.winRate * 100).toFixed(1)}% (n=${direct.n})`);
}

runAll();
