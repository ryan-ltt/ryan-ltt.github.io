// Fourth-round search: tunes the two new "group scarcity" parameters added to model a specific
// blind spot observed in human play against the round-3 BEST_GENOME (see /monopoly/js/strategy.js) -
// bots would sell the 2nd piece of a 3-property color group to a human for a fair (or only mildly
// marked-up) price without reasoning that the 3rd piece then becomes drastically harder for the
// human to acquire, and without reasoning that the SAME blind spot applies to their own partial
// sets (they'd sell their own 1-of-3 or 2-of-3 holding too cheaply too).
//
// groupScarcityPremium: multiplies the perceived value of a property we're asked to GIVE UP if we
//   already own other members of its group, scaled by how many we own.
// chaseLastPieceDrive: multiplies how much extra a bot offers to acquire the missing piece of its
//   OWN near-complete group, so it out-bids a rival (or a shrewd human) racing for the same piece.
//
// Uses the same drift-safe methodology as gridsearch3.js: each parameter's candidate values are
// screened against the current running genome (cheap, noisy), then the accepted change is
// re-validated against the FIXED round-3 anchor (BEST_GENOME) so gains can't be an artifact of a
// drifting baseline.

const { compareGenome, DEFAULT_GENOME } = require('./simulate');
const { BEST_GENOME: ANCHOR, makeBotAgent } = require('../js/strategy.js');
const { MonopolyGame } = require('../js/game.js');

const PARAM_GRID = {
	groupScarcityPremium: [0.0, 0.3, 0.6, 1.0, 1.5, 2.5],
	chaseLastPieceDrive: [1.0, 1.2, 1.5, 1.8, 2.2, 2.8]
};

const STEP_GAMES_PER_SEAT = 150;
const VALIDATE_GAMES_PER_SEAT = 250;
const VALIDATE_MARGIN = 0.02;
const PASSES = 2;

async function evaluate(candidate, baseline, gamesPerSeat, seedOffset) {
	const { winRate } = await compareGenome(candidate, baseline, gamesPerSeat, seedOffset);
	return winRate;
}

async function driftSafeAscent(anchor) {
	let current = Object.assign({}, anchor);
	let seedCounter = 900000;
	let totalGames = 0;
	let accepted = 0, reverted = 0;

	for (let pass = 1; pass <= PASSES; pass++) {
		console.log(`\n=== PASS ${pass} ===`);
		for (const param of Object.keys(PARAM_GRID)) {
			const values = PARAM_GRID[param];
			let bestVal = current[param];
			let bestRate = -1;
			const results = [];
			for (const val of values) {
				const candidate = Object.assign({}, current, { [param]: val });
				seedCounter++;
				const rate = await evaluate(candidate, current, STEP_GAMES_PER_SEAT, seedCounter);
				totalGames += STEP_GAMES_PER_SEAT * 4;
				results.push({ val, rate });
				if (rate > bestRate) { bestRate = rate; bestVal = val; }
			}
			const proposed = Object.assign({}, current, { [param]: bestVal });
			seedCounter++;
			const anchorCheck = await evaluate(proposed, anchor, VALIDATE_GAMES_PER_SEAT, seedCounter + 50000);
			totalGames += VALIDATE_GAMES_PER_SEAT * 4;
			const changed = bestVal !== current[param];
			if (changed && anchorCheck < 0.25 - VALIDATE_MARGIN) {
				console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> candidate=${bestVal} REJECTED (vs anchor: ${(anchorCheck * 100).toFixed(1)}%, reverting to ${current[param]})`);
				reverted++;
			} else {
				current[param] = bestVal;
				console.log(`${param}: ` + results.map(r => `${r.val}=${(r.rate * 100).toFixed(1)}%`).join('  ') + `  -> best=${bestVal}${changed ? ` (changed, vs anchor: ${(anchorCheck * 100).toFixed(1)}%)` : ''}`);
				if (changed) accepted++;
			}
		}
		console.log(`[running total: ${totalGames.toLocaleString()} games, ${accepted} accepted changes, ${reverted} reverted]`);
	}
	return { best: current, totalGames, accepted, reverted };
}

// Simulated stand-in for the human exploit: a bot that seeds itself with two members of a color
// group very early (skips normal buy logic for those 2 spaces the first time it lands there, as
// if it had "bought them off AI players cheaply" the way a human would) and otherwise plays the
// anchor strategy. This isn't a perfect model of trade-based acquisition, but it stresses the same
// dynamic worth testing here: does the CURRENT genome now protect (or contest) group scarcity
// better than the anchor once an opponent already sits on 2/3 of a group?
async function scarcityStressTest(best) {
	console.log('\n=== SCARCITY STRESS TEST ===');
	console.log('(3 anchor-genome bots vs 1 "group hoarder" bot that behaves like the anchor genome');
	console.log(' but with tradeWillingness maxed + tradeFairnessMargin relaxed, i.e. actively works');
	console.log(' trades to complete color groups the way the human strategy does)');
	const hoarder = Object.assign({}, ANCHOR, { tradeWillingness: 1.0, tradeFairnessMargin: 1.0, tradeMonopolyDrive: 3.0 });

	async function runRoundRobin(defenderGenome, label) {
		let hoarderWins = 0, total = 0;
		for (let seat = 0; seat < 4; seat++) {
			for (let s = 0; s < 250; s++) {
				const genomes = [defenderGenome, defenderGenome, defenderGenome, defenderGenome];
				genomes[seat] = hoarder;
				const seed = 42000 + seat * 10007 + s;
				const agents = genomes.map((g, i) => ({ name: 'P' + i, agent: makeBotAgent(g) }));
				const game = new MonopolyGame(agents, { seed, maxTurns: 300 });
				const winner = await game.runToCompletion();
				if (winner && winner.id === seat) hoarderWins++;
				total++;
			}
		}
		console.log(`${label}: hoarder win rate = ${((hoarderWins / total) * 100).toFixed(1)}% (n=${total}) [lower = defender resists the hoarding strategy better]`);
		return hoarderWins / total;
	}

	const anchorDefRate = await runRoundRobin(ANCHOR, 'Defenders = round-3 ANCHOR (blockingAwareness=0, no scarcity awareness)');
	const bestDefRate = await runRoundRobin(best, 'Defenders = round-4 candidate (with scarcity awareness)');
	console.log(`\nHoarder exploit suppressed by ${((anchorDefRate - bestDefRate) * 100).toFixed(1)}pp when defenders use the new genome`);
}

(async () => {
	const t0 = Date.now();
	console.log('Starting drift-safe coordinate ascent on group-scarcity params, anchored to round-3 BEST_GENOME...');
	const { best, totalGames, accepted, reverted } = await driftSafeAscent(ANCHOR);
	console.log(`\n=== ROUND 4 BEST GENOME (${accepted} changes accepted, ${reverted} reverted) ===`);
	console.log(JSON.stringify(best, null, 2));

	console.log('\n=== FINAL CONFIRMATION (large n vs round-3 anchor) ===');
	const conf = await compareGenome(best, ANCHOR, 1000, 955000);
	console.log(`Round4 genome win rate vs round-3 anchor: ${(conf.winRate * 100).toFixed(2)}% (n=${conf.n})`);

	console.log('\n=== FINAL CONFIRMATION (large n vs default baseline) ===');
	const confDefault = await compareGenome(best, DEFAULT_GENOME, 500, 977000);
	console.log(`Round4 genome win rate vs default baseline: ${(confDefault.winRate * 100).toFixed(2)}% (n=${confDefault.n})`);

	await scarcityStressTest(best);

	console.log(`\nTotal games (approx, excludes stress test): ${totalGames.toLocaleString()}`);
	console.log(`Total time: ${((Date.now() - t0) / 1000).toFixed(1)}s`);
})();
