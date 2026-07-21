// Simulation harness: runs many headless games to compare strategy genomes.
// Key methodology point: seat/turn order has a strong effect on win rate (see exploratory
// run), so every comparison rotates the challenger genome through all 4 seat positions
// evenly and reports win-rate relative to 3 baseline opponents, controlling for seat bias.

const { MonopolyGame } = require('../js/game.js');
const { makeBotAgent, DEFAULT_GENOME } = require('../js/strategy.js');

function runMatch(genomes, seed, maxTurns) {
	const agents = genomes.map((g, i) => ({ name: 'P' + i, agent: makeBotAgent(g) }));
	const game = new MonopolyGame(agents, { seed, maxTurns: maxTurns || 300 });
	return game.runToCompletion().then(winner => ({
		winnerIdx: winner ? winner.id : -1,
		turns: game.turnCount,
		netWorths: game.players.map(p => game.netWorth(p))
	}));
}

/**
 * Compare a challenger genome against baseline genome, 3 baseline copies + 1 challenger,
 * rotating the challenger's seat across all 4 positions, across `gamesPerSeat` seeds per seat.
 * Returns { challengerWinRate, baselineWinRate, n }
 */
async function compareGenome(challenger, baseline, gamesPerSeat, seedOffset) {
	let challengerWins = 0;
	let total = 0;
	for (let seat = 0; seat < 4; seat++) {
		for (let s = 0; s < gamesPerSeat; s++) {
			const genomes = [baseline, baseline, baseline, baseline];
			genomes[seat] = challenger;
			const seed = (seedOffset || 0) * 1000003 + seat * 100003 + s;
			const result = await runMatch(genomes, seed);
			if (result.winnerIdx === seat) challengerWins++;
			total++;
		}
	}
	return { winRate: challengerWins / total, n: total, wins: challengerWins };
}

module.exports = { runMatch, compareGenome, DEFAULT_GENOME };

// CLI: node simulate.js  -> quick sanity comparison
if (require.main === module) {
	(async () => {
		const t0 = Date.now();
		const res = await compareGenome(DEFAULT_GENOME, DEFAULT_GENOME, 50, 1);
		console.log('Baseline vs baseline (should be ~25%):', (res.winRate * 100).toFixed(1) + '%', 'n=' + res.n, 'in', Date.now() - t0, 'ms');
	})();
}
