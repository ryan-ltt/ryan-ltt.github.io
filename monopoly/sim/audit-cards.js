// Exhaustive card/event audit: exercises every Chest and Fate card from a variety of starting
// positions and ownership setups, and checks the resulting player state against hand-computed
// expectations. Prints PASS/FAIL per case so bugs can be found systematically instead of by
// spot-checking individual cards.

const { MonopolyGame } = require('../js/game.js');
const Board = require('../js/board.js');

const dummyAgent = {
	decideBuyProperty: () => false,
	decideAuctionBid: () => 0,
	decideJail: () => 'stay',
	decideLiquidation: () => null,
	decideAction: () => ({ type: 'done' }),
	decideTradeResponse: () => false
};

function freshGame(numPlayers) {
	const agents = [];
	for (let i = 0; i < numPlayers; i++) agents.push({ name: 'P' + i, agent: dummyAgent });
	return new MonopolyGame(agents, { seed: 1, maxTurns: 5, verbose: false });
}

let passCount = 0, failCount = 0;
function check(label, condition, details) {
	if (condition) {
		passCount++;
		// console.log('PASS:', label);
	} else {
		failCount++;
		console.log('FAIL:', label, details || '');
	}
}

async function testGoBack() {
	console.log('\n--- goBack (Go Back 3 Spaces) ---');
	// Use starting positions whose landing spot (3 back) is NOT a chest/fate/gotojail space, so
	// the resulting position/money is deterministic and not dependent on a chained card draw.
	for (const startPos of [0, 15, 27]) {
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = startPos;
		const moneyBefore = p.money;
		await g.drawCard(p, { text: 'Go Back 3 Spaces.', action: 'goBack', amount: 3 }, 7);
		const expectedPos = (startPos - 3 + Board.BOARD_SIZE) % Board.BOARD_SIZE;
		check(`goBack from ${startPos} lands on ${expectedPos}`, p.pos === expectedPos, `got pos=${p.pos}`);
		check(`goBack from ${startPos} doesn't pay Go salary`, p.money - moneyBefore < Board.GO_SALARY, `money changed by ${p.money - moneyBefore}`);
	}
	// direction hint: movePlayer must report 'backward' via onMove for goBack, so the UI can
	// animate the correct way round instead of walking forward almost a full lap
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 5;
		let capturedDirection = null;
		g.onMove = (player, oldPos, newPos, direction) => { capturedDirection = direction; };
		await g.drawCard(p, { text: 'Go Back 3 Spaces.', action: 'goBack', amount: 3 }, 7);
		check('goBack: onMove receives direction="backward"', capturedDirection === 'backward', `got direction=${capturedDirection}`);
	}
}

async function testAdvanceToNearestRail(cardAction, expectedMultiplier, label) {
	console.log(`\n--- ${label} ---`);
	// case 1: unowned rail -> should trigger a purchase offer (dummyAgent declines -> auction)
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 3; // North Station is pos 5, next one ahead
		await g.drawCard(p, { text: label, action: cardAction }, 7);
		check(`${label}: lands on North Station (pos 5) when unowned`, p.pos === 5, `got pos=${p.pos}`);
	}
	// case 2: owned by another player, not mortgaged -> pay rent * multiplier
	{
		const g = freshGame(2);
		const p0 = g.players[0], p1 = g.players[1];
		p0.pos = 3;
		g.properties[5].owner = 1;
		p1.properties.push(5);
		const rentNormal = g.calcRent(5, 7);
		const moneyBefore = p0.money;
		const ownerMoneyBefore = p1.money;
		await g.drawCard(p0, { text: label, action: cardAction }, 7);
		const paid = moneyBefore - p0.money;
		const received = p1.money - ownerMoneyBefore;
		check(`${label}: pays ${expectedMultiplier}x rent ($${rentNormal * expectedMultiplier})`, paid === rentNormal * expectedMultiplier, `paid=$${paid}, expected=$${rentNormal * expectedMultiplier}`);
		check(`${label}: owner receives the rent`, received === rentNormal * expectedMultiplier, `owner received $${received}`);
	}
	// case 3: owned by SELF -> no payment
	{
		const g = freshGame(2);
		const p0 = g.players[0];
		p0.pos = 3;
		g.properties[5].owner = 0;
		p0.properties.push(5);
		const moneyBefore = p0.money;
		await g.drawCard(p0, { text: label, action: cardAction }, 7);
		check(`${label}: no self-rent when landing on own rail`, p0.money === moneyBefore, `money changed by ${p0.money - moneyBefore}`);
	}
	// case 4: mortgaged rail owned by other player -> should be rent-free (real rule)
	{
		const g = freshGame(2);
		const p0 = g.players[0], p1 = g.players[1];
		p0.pos = 3;
		g.properties[5].owner = 1;
		g.properties[5].mortgaged = true;
		p1.properties.push(5);
		const moneyBefore = p0.money;
		await g.drawCard(p0, { text: label, action: cardAction }, 7);
		check(`${label}: mortgaged rail charges no rent`, p0.money === moneyBefore, `money changed by ${p0.money - moneyBefore} (BUG: mortgaged check missing)`);
	}
	// case 5: wraparound - player already past the last rail, nearest rail is the FIRST one, should collect Go salary
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 36; // past West Station (pos 35), nearest ahead wraps to North Station (pos 5)
		const moneyBefore = p.money;
		await g.drawCard(p, { text: label, action: cardAction }, 7);
		check(`${label}: wraparound past last rail collects Go salary`, p.money - moneyBefore >= Board.GO_SALARY, `pos=${p.pos}, money changed by ${p.money - moneyBefore}`);
		check(`${label}: wraparound lands on North Station (pos 5)`, p.pos === 5, `got pos=${p.pos}`);
	}
}

async function testAdvanceToNearestUtility() {
	console.log('\n--- advanceToNearestUtility ---');
	const label = 'Advance to nearest Utility.';
	// unowned
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 10; // Power Co. is pos 12, next one ahead
		await g.drawCard(p, { text: label, action: 'advanceToNearestUtility' }, 7);
		check(`${label}: lands on Power Co. (pos 12) when unowned`, p.pos === 12, `got pos=${p.pos}`);
	}
	// owned by another, standard rule = 10x dice roll
	{
		const g = freshGame(2);
		const p0 = g.players[0], p1 = g.players[1];
		p0.pos = 10;
		g.properties[12].owner = 1;
		p1.properties.push(12);
		const moneyBefore = p0.money;
		await g.drawCard(p0, { text: label, action: 'advanceToNearestUtility' }, 6);
		const paid = moneyBefore - p0.money;
		check(`${label}: pays 10x dice roll ($60 for roll of 6)`, paid === 60, `paid=$${paid}`);
	}
	// mortgaged utility owned by other -> should be rent-free
	{
		const g = freshGame(2);
		const p0 = g.players[0], p1 = g.players[1];
		p0.pos = 10;
		g.properties[12].owner = 1;
		g.properties[12].mortgaged = true;
		p1.properties.push(12);
		const moneyBefore = p0.money;
		await g.drawCard(p0, { text: label, action: 'advanceToNearestUtility' }, 6);
		check(`${label}: mortgaged utility charges no rent`, p0.money === moneyBefore, `money changed by ${p0.money - moneyBefore} (BUG: mortgaged check missing)`);
	}
}

async function testAdvanceTo() {
	console.log('\n--- advanceTo (specific property cards) ---');
	// Advance to Skyline Place (pos 39), should pay normal rent if owned by another (not double - only rail card doubles)
	{
		const g = freshGame(2);
		const p0 = g.players[0], p1 = g.players[1];
		p0.pos = 10;
		g.properties[39].owner = 1;
		p1.properties.push(39);
		const rentNormal = g.calcRent(39, 7);
		const moneyBefore = p0.money;
		await g.drawCard(p0, { text: 'Advance to Skyline Place.', action: 'advanceTo', pos: 39 }, 7);
		const paid = moneyBefore - p0.money;
		check('Advance to Skyline Place: pays normal (not double) rent', paid === rentNormal, `paid=$${paid}, normal=$${rentNormal}`);
	}
	// Advance to Elm Street (pos 1) - if passing Go (i.e. current pos > 1), should collect $200
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 30; // definitely "passes" Go to reach pos 1
		const moneyBefore = p.money;
		await g.drawCard(p, { text: 'Advance to Elm Street. If you pass Start, collect $200.', action: 'advanceTo', pos: 1 }, 7);
		check('Advance to Elm Street from pos 30: collects Go salary (passed Start)', p.money - moneyBefore >= Board.GO_SALARY, `money changed by ${p.money - moneyBefore}`);
	}
	// Advance to Elm Street (pos 1) from a position BEFORE it (pos 0 itself) - should NOT collect (didn't pass Go)
	{
		const g = freshGame(2);
		const p = g.players[0];
		p.pos = 0;
		const moneyBefore = p.money;
		await g.drawCard(p, { text: 'Advance to Elm Street. If you pass Start, collect $200.', action: 'advanceTo', pos: 1 }, 7);
		check('Advance to Elm Street from pos 0: does NOT collect Go salary (did not pass Start)', p.money - moneyBefore < Board.GO_SALARY, `money changed by ${p.money - moneyBefore}`);
	}
}

async function testAdvanceToGo() {
	console.log('\n--- advanceToGo ---');
	const g = freshGame(2);
	const p = g.players[0];
	p.pos = 25;
	const moneyBefore = p.money;
	await g.drawCard(p, { text: 'Advance to Start. Collect $200.', action: 'advanceToGo' }, 7);
	check('advanceToGo: lands on pos 0', p.pos === 0, `got pos=${p.pos}`);
	check('advanceToGo: collects exactly $200', p.money - moneyBefore === 200, `money changed by ${p.money - moneyBefore}`);
}

async function testCollectPay() {
	console.log('\n--- collect / pay (flat amounts) ---');
	const g = freshGame(2);
	const p = g.players[0];
	const moneyBefore = p.money;
	await g.drawCard(p, { text: 'x', action: 'collect', amount: 200 }, 7);
	check('collect $200', p.money - moneyBefore === 200, `money changed by ${p.money - moneyBefore}`);

	const g2 = freshGame(2);
	const p2 = g2.players[0];
	const before2 = p2.money;
	await g2.drawCard(p2, { text: 'x', action: 'pay', amount: 50 }, 7);
	check('pay $50', before2 - p2.money === 50, `money changed by ${p2.money - before2}`);
}

async function testCollectFromEachPayEach() {
	console.log('\n--- collectFromEach / payEach ---');
	{
		const g = freshGame(3);
		const p = g.players[0];
		const others = [g.players[1], g.players[2]];
		const beforeSelf = p.money;
		const beforeOthers = others.map(o => o.money);
		await g.drawCard(p, { text: 'birthday', action: 'collectFromEach', amount: 10 }, 7);
		check('collectFromEach: collector gains $10 per other player', p.money - beforeSelf === 20, `gained $${p.money - beforeSelf}`);
		check('collectFromEach: each other player pays $10', others.every((o, i) => beforeOthers[i] - o.money === 10), others.map(o => o.money));
	}
	{
		const g = freshGame(3);
		const p = g.players[0];
		const others = [g.players[1], g.players[2]];
		const beforeSelf = p.money;
		const beforeOthers = others.map(o => o.money);
		await g.drawCard(p, { text: 'chairperson', action: 'payEach', amount: 50 }, 7);
		check('payEach: payer loses $50 per other player', beforeSelf - p.money === 100, `lost $${beforeSelf - p.money}`);
		check('payEach: each other player gains $50', others.every((o, i) => o.money - beforeOthers[i] === 50), others.map(o => o.money));
	}
}

async function testGetOutOfJail() {
	console.log('\n--- getOutOfJail ---');
	const g = freshGame(2);
	const p = g.players[0];
	const before = p.getOutOfJailFree;
	await g.drawCard(p, { text: 'x', action: 'getOutOfJail' }, 7);
	check('getOutOfJail: increments card count', p.getOutOfJailFree - before === 1, `count now ${p.getOutOfJailFree}`);
}

async function testGotoJail() {
	console.log('\n--- gotojail (card) ---');
	const g = freshGame(2);
	const p = g.players[0];
	p.pos = 15;
	await g.drawCard(p, { text: 'x', action: 'gotojail' }, 7);
	check('gotojail card: sends to jail position', p.pos === Board.JAIL_POS, `got pos=${p.pos}`);
	check('gotojail card: sets inJail flag', p.inJail === true);
}

async function testRepairs() {
	console.log('\n--- repairs ---');
	const g = freshGame(2);
	const p = g.players[0];
	// give p a property with 3 houses and one with a hotel
	g.properties[1].owner = 0; g.properties[1].houses = 3;
	p.properties.push(1);
	g.properties[39].owner = 0; g.properties[39].houses = 5; // hotel
	p.properties.push(39);
	const before = p.money;
	await g.drawCard(p, { text: 'repairs', action: 'repairs', house: 40, hotel: 115 }, 7);
	const expected = 3 * 40 + 115;
	check('repairs: charges house*count + hotel*count', before - p.money === expected, `paid $${before - p.money}, expected $${expected}`);
}

(async () => {
	await testGoBack();
	await testAdvanceToNearestRail('advanceToNearestRail', 2, 'advanceToNearestRail (Fate: pay double rent)');
	await testAdvanceToNearestRail('advanceToNearestRail2', 1, 'advanceToNearestRail2 (Fate: normal rent)');
	await testAdvanceToNearestUtility();
	await testAdvanceTo();
	await testAdvanceToGo();
	await testCollectPay();
	await testCollectFromEachPayEach();
	await testGetOutOfJail();
	await testGotoJail();
	await testRepairs();

	console.log(`\n\n=== TOTAL: ${passCount} passed, ${failCount} failed ===`);
})();
