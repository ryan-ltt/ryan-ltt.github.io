/* Headless test harness.  node catan/test/harness.js  [games]
 *
 * The engine has no DOM in it, so it loads into node with one shim and the bots
 * can play thousands of games against themselves in a few seconds. That gets
 * used for four things beyond "does it crash":
 *
 *   1. round-trip every turn      - catches state that does not survive being
 *                                   serialised, which is otherwise reported as
 *                                   "the game broke when someone refreshed"
 *   2. redaction                  - viewFor(seat) never contains another seat's
 *                                   hand, deck order, or unplayed cards
 *   3. the authorisation table    - who may send what, in every phase, checked
 *                                   against an oracle written out separately
 *                                   from the implementation
 *   4. a host/guest round trip    - two Net endpoints wired to each other in
 *                                   memory, no network, playing a real game
 */
'use strict';

globalThis.window = globalThis;
require('../js/hex.js');
require('../js/map.js');
require('../js/game.js');
require('../js/ai.js');
require('../js/net.js');

const M = window.CatanMap;
const G = window.CatanGame;
const AI = window.CatanAI;
const Net = window.CatanNet;

const ACTION_NAMES = Object.keys(G.ACTIONS);
const MAX_BOT_STEPS = 60;      // mirrors ui.js

/* A cramped board can have the bots grinding for tens of thousands of actions
 * before somebody finally reaches ten points. They do get there - 2500 games
 * checked - so this is a generous budget, not a deadlock detector. */
const MAX_ACTIONS = 60000;

/* Two hands that serialise identically are indistinguishable, so a hand that
 * looks like the reader's own - or like the open trade offer, which is public -
 * cannot be counted as a leak. */
function hiddenHandLeaks(view, game, seat) {
	const text = JSON.stringify(view);
	const allowed = [JSON.stringify(game.players[seat] ? game.players[seat].resources : null)];
	if (game.offer) allowed.push(JSON.stringify(game.offer.give), JSON.stringify(game.offer.want));

	return game.players.filter(function (other) {
		if (other.id === seat) return false;
		if (G.countCards(other.resources) === 0) return false;   // no secret to keep
		const exact = JSON.stringify(other.resources);
		if (allowed.indexOf(exact) >= 0) return false;
		return text.indexOf(exact) >= 0;
	}).length;
}

let checks = 0;
let failures = 0;

function ok(condition, label, detail) {
	checks++;
	if (condition) return true;
	failures++;
	console.error('  FAIL  ' + label + (detail ? '\n        ' + detail : ''));
	return false;
}

function section(name) {
	console.log('\n' + name);
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

/* Dice, the deck shuffle and the robber's pick all come from Math.random, so a
 * recorded game only replays if the randomness replays with it. Pinning it is
 * also a small proof of the claim in the design notes: those three sites are the
 * whole of the engine's non-determinism. */
function withSeed(seed, fn) {
	const real = Math.random;
	let s = seed >>> 0;
	Math.random = function () {
		s = (s * 1664525 + 1013904223) >>> 0;
		return s / 4294967296;
	};
	try {
		return fn();
	} finally {
		Math.random = real;
	}
}

/* ------------------------------------------------------------- bot driving */

/* The headless equivalent of tick() in ui.js. `onTurn` gets a chance to swap the
 * game object out, which is how the round-trip test works. */
function playOut(game, onTurn) {
	let steps = 0;
	let botSteps = 0;
	let builds = 0;
	while (game.phase !== 'over' && steps < MAX_ACTIONS) {
		steps++;

		if (game.phase === 'discard') {
			const id = Object.keys(game.pendingDiscards).map(Number)[0];
			if (id === undefined) break;
			game.discard(id, AI.discard(game, id));
			continue;
		}
		if (game.phase === 'setup') {
			if (game.setupStep === 'settlement') game.placeSetupSettlement(AI.setupSettlement(game));
			else game.placeSetupRoad(AI.setupRoad(game));
			continue;
		}
		if (game.phase === 'robber') {
			if (game.awaitingSteal) {
				game.chooseVictim(game.awaitingSteal[0]);
				continue;
			}
			const choice = AI.robberChoice(game);
			game.moveRobber(choice.hex, choice.victim);
			continue;
		}
		if (game.phase === 'build') builds++;
		if (game.phase === 'roll' || game.phase === 'main' || game.phase === 'build') {
			// The same escape hatch ui.js uses: a bot that will not settle down
			// has its turn ended for it rather than hanging the table.
			botSteps++;
			const wasBuilding = game.phase === 'build';
			const wantsMore = botSteps < MAX_BOT_STEPS && AI.step(game);
			if (!wantsMore && game.canBuildNow()) {
				game.endTurn();
				botSteps = 0;
				// Only round-trip on a real turn boundary, not a special build pass.
				if (onTurn && !wasBuilding) game = onTurn(game);
			}
			continue;
		}
		break;
	}
	return { game: game, steps: steps, builds: builds };
}

/* The seven-hex preset has 24 vertices, and the two-apart rule means three
 * players fill it before anyone reaches ten points: every game that stalls does
 * so with zero free vertices, an empty deck, and everybody sat on 8 or 9. That
 * is a board-size problem in the preset, not a bug in anything below, so the
 * harness sticks to matchups that can actually be won. (Measured: 2 stalls in
 * 4000 games at small/3, none at all with these caps.) */
const MAX_SEATS_FOR = { small: 2, standard: 5, large: 6 };

function makeGame(seats, mapName, options) {
	const name = mapName || 'standard';
	const map = name === 'small' ? M.smallMap() : name === 'large' ? M.largeMap() : M.standardMap();
	const configs = [];
	const count = Math.min(seats, MAX_SEATS_FOR[name]);
	for (let i = 0; i < count; i++) configs.push({ name: 'p' + i, isBot: true });
	return new G.Game(map, configs, options || {});
}

/* Cards only ever move between the bank and a hand, so the totals are fixed. */
function conserved(game) {
	const size = game.map.hexes.length > 24 ? 24 : 19;
	return M.RESOURCES.every(function (res) {
		const held = game.players.reduce(function (sum, p) {
			return sum + p.resources[res];
		}, 0);
		return held + game.bank[res] === size;
	});
}

/* -------------------------------------------------------- 1. games finish */

function testGames(count) {
	section('playing ' + count + ' bot games');
	let unfinished = 0;
	let leaks = 0;
	let totalSteps = 0;

	let bigTables = 0;
	let specialBuilds = 0;

	for (let i = 0; i < count; i++) {
		const seats = 2 + (i % 5);
		// Five and six players belong on the large board; see MAX_SEATS_FOR.
		const board = seats >= 5 ? 'large' : i % 7 === 0 ? 'small' : i % 11 === 0 ? 'large' : 'standard';
		const game = makeGame(seats, board);
		if (game.players.length >= 5) bigTables++;
		const out = playOut(game);
		totalSteps += out.steps;
		specialBuilds += out.builds;
		if (out.game.phase !== 'over' || out.game.winner === null) unfinished++;
		if (!conserved(out.game)) leaks++;
	}

	ok(unfinished === 0, 'every game reaches a winner', unfinished + ' did not finish');
	ok(leaks === 0, 'resource totals are conserved', leaks + ' games leaked cards');
	ok(bigTables > 0, 'the sample includes tables of five and six', bigTables + ' big tables');
	ok(specialBuilds > 0, 'those tables ran special build phases', specialBuilds + ' of them');
	console.log('  ' + totalSteps + ' actions total, ' + specialBuilds + ' special builds');
}

/* ------------------------------------------- 2. serialisation round trip */

function testRoundTrip(count) {
	section('round-tripping through toJSON/fromJSON every turn');
	let broken = 0;
	let unfinished = 0;

	for (let i = 0; i < count; i++) {
		const game = makeGame(2 + (i % 4));
		const out = playOut(game, function (live) {
			const copy = G.Game.fromJSON(clone(live));
			// The rebuilt board is derived, so compare everything else.
			if (JSON.stringify(copy.toJSON()) !== JSON.stringify(live.toJSON())) broken++;
			if (!copy.board || !Object.keys(copy.board.vertices).length) broken++;
			return copy;
		});
		if (out.game.phase !== 'over') unfinished++;
		if (!conserved(out.game)) broken++;
	}

	ok(broken === 0, 'state survives a JSON round trip on every turn', broken + ' mismatches');
	ok(unfinished === 0, 'round-tripped games still finish', unfinished + ' stalled');
}

/* --------------------------------------------------------- 3. redaction */

function testRedaction() {
	section('redacting views');
	let hands = 0;
	let decks = 0;
	let ownHand = 0;
	let substring = 0;
	let publicLoss = 0;
	let games = 0;

	for (let i = 0; i < 60; i++) {
		// Stop partway through so there is something worth hiding.
		const game = makeGame(4);
		let turns = 0;
		playOut(game, function (live) {
			turns++;
			return turns > 6 + (i % 15) ? Object.assign(live, { phase: 'over' }) : live;
		});
		game.phase = 'main';   // undo the stop so viewFor actually redacts
		if (game.players.every(function (p) { return G.countCards(p.resources) === 0; })) continue;
		games++;

		game.players.forEach(function (me) {
			const view = game.viewFor(me.id);

			if (typeof view.devDeck !== 'number') decks++;
			if (typeof view.players[me.id].resources !== 'object') ownHand++;

			// The breakdown must not survive anywhere in the payload, however it
			// got there - not just in the obvious field.
			substring += hiddenHandLeaks(view, game, me.id);

			game.players.forEach(function (other) {
				if (other.id === me.id) return;
				const shown = view.players[other.id];
				if (typeof shown.resources !== 'number' ||
					typeof shown.dev !== 'number' ||
					typeof shown.devPending !== 'number') hands++;
				if (shown.resources !== G.countCards(other.resources)) hands++;

				// Public facts must still be public or the panel breaks.
				if (shown.knightsPlayed !== other.knightsPlayed ||
					shown.longestRoad !== other.longestRoad ||
					JSON.stringify(shown.settlements) !== JSON.stringify(other.settlements) ||
					JSON.stringify(shown.ports) !== JSON.stringify(other.ports)) publicLoss++;
			});
		});
	}

	ok(games > 0, 'built games worth redacting', 'every sample was empty');
	ok(hands === 0, "another seat's hand is a count, not a breakdown", hands + ' leaks');
	ok(substring === 0, 'no hand breakdown appears anywhere in the payload', substring + ' leaks');
	ok(decks === 0, 'the dev deck is a count, not an ordered list', decks + ' leaks');
	ok(ownHand === 0, 'your own seat still sees its own cards', ownHand + ' redacted too far');
	ok(publicLoss === 0, 'public facts survive redaction', publicLoss + ' lost');

	// A finished game reveals everything - the scoreboard needs hidden VP cards.
	const done = makeGame(3);
	playOut(done);
	const finalView = done.viewFor(0);
	ok(typeof finalView.players[1].resources === 'object',
		'a finished game reveals every hand');
	ok(done.points(done.players[done.winner]) >= done.targetVP,
		'the winner is actually at the target');
}

/* ----------------------------------------------------- 4. authorisation */

/* Written out from the rules rather than from Game.authorise, so that the two
 * agreeing means something. */
function mayAct(game, seat, action, args) {
	if (!G.ACTIONS[action]) return false;
	if (!game.players[seat]) return false;
	if (game.phase === 'over') return false;

	if (action === 'discard') {
		return Number(args[0]) === seat && !!game.pendingDiscards[seat];
	}
	if (action === 'respondToOffer') {
		return Number(args[0]) === seat && !!game.offer && game.offer.responses[seat] !== undefined;
	}
	if (game.phase === 'discard') return false;

	// Trading and playing cards are barred during the special build phase, but
	// that is a rule the methods enforce, not an identity question - authorise
	// only answers "is this seat allowed to speak right now".
	// Not turn % players.length: setup is a snake, and the special build phase
	// runs its own queue of everyone except the player whose turn it is.
	const current = game.phase === 'setup' ? game.setupOrder[game.setupIndex]
		: game.phase === 'build' ? game.buildOrder[game.buildIndex]
		: game.turn % game.players.length;
	return seat === current;
}

/* One game frozen in each phase worth testing. */
function phaseSamples() {
	const samples = {};

	samples.setup = makeGame(4);

	const rolling = makeGame(4);
	while (rolling.phase === 'setup') {
		if (rolling.setupStep === 'settlement') rolling.placeSetupSettlement(AI.setupSettlement(rolling));
		else rolling.placeSetupRoad(AI.setupRoad(rolling));
	}
	samples.roll = rolling;

	const main = G.Game.fromJSON(clone(rolling));
	main.rollDice();
	if (main.phase !== 'main') main.phase = 'main';
	main.pendingDiscards = {};
	main.awaitingSteal = null;
	samples.main = main;

	// A 7 with two seats over the limit: the classic several-humans-at-once case.
	const discarding = G.Game.fromJSON(clone(samples.main));
	[1, 3].forEach(function (id) {
		M.RESOURCES.forEach(function (res) { discarding.players[id].resources[res] = 2; });
	});
	discarding.phase = 'roll';
	discarding.startRobber('a 7 is rolled');
	samples.discard = discarding;

	const robber = G.Game.fromJSON(clone(samples.main));
	robber.phase = 'robber';
	samples.robber = robber;

	const offering = G.Game.fromJSON(clone(samples.main));
	M.RESOURCES.forEach(function (res) {
		offering.players[offering.current().id].resources[res] = 3;
	});
	offering.openOffer({ brick: 1 }, { ore: 1 });
	samples.offer = offering;

	// The special build phase: everyone except the active player, in turn order.
	const building = G.Game.fromJSON(clone(samples.main));
	building.specialBuild = true;
	building.phase = 'main';
	building.endTurn();
	samples.build = building;

	const over = G.Game.fromJSON(clone(samples.main));
	over.phase = 'over';
	over.winner = 0;
	samples.over = over;

	return samples;
}

function argsFor(action, seat) {
	if (action === 'discard') return [seat, G.emptyResources()];
	if (action === 'respondToOffer') return [seat, true];
	if (action === 'playDev') return ['knight'];
	if (action === 'moveRobber') return ['0,0'];
	if (action === 'chooseVictim') return [0];
	if (action === 'tradeBank') return ['brick', 'ore'];
	if (action === 'openOffer') return [{ brick: 1 }, { ore: 1 }];
	if (action === 'acceptTradeWith') return [1];
	if (action === 'buildRoad' || action === 'placeSetupRoad') return ['x'];
	if (action === 'buildSettlement' || action === 'buildCity' || action === 'placeSetupSettlement') return ['x'];
	return [];
}

function testAuthorisation() {
	section('the authorisation table');
	const samples = phaseSamples();
	let wrong = 0;
	let cells = 0;

	Object.keys(samples).forEach(function (label) {
		const game = samples[label];
		game.players.forEach(function (_, seat) {
			ACTION_NAMES.forEach(function (action) {
				const args = argsFor(action, seat);
				const expected = mayAct(game, seat, action, args);
				const actual = game.authorise(seat, action, args).ok;
				cells++;
				if (expected !== actual) {
					wrong++;
					if (wrong <= 5) {
						console.error('        ' + label + ' / seat ' + seat + ' / ' + action +
							': expected ' + expected + ', got ' + actual);
					}
				}
			});
		});
	});

	ok(wrong === 0, cells + ' action x seat x phase cells agree with the rules', wrong + ' disagree');

	// The cases worth naming, because they are the ones that get written wrong.
	const setup = samples.setup;
	const setupSeat = setup.setupOrder[setup.setupIndex];
	ok(setup.authorise(setupSeat, 'placeSetupSettlement', ['x']).ok,
		'the seat named by setupOrder may place');
	ok(!setup.authorise((setupSeat + 1) % 4, 'placeSetupSettlement', ['x']).ok,
		'nobody else may place during setup');

	const late = G.Game.fromJSON(clone(setup));
	late.setupIndex = late.players.length;   // first seat of the return leg
	const snakeSeat = late.setupOrder[late.setupIndex];
	ok(snakeSeat !== late.turn % late.players.length,
		'the sample really does exercise the snake order');
	ok(late.authorise(snakeSeat, 'placeSetupSettlement', ['x']).ok,
		'setup order wins over turn order');

	const discarding = samples.discard;
	ok(discarding.phase === 'discard', 'the discard sample is in the discard phase');
	ok(discarding.authorise(1, 'discard', [1, G.emptyResources()]).ok,
		'a seat that owes cards may discard, out of turn');
	ok(!discarding.authorise(1, 'discard', [3, G.emptyResources()]).ok,
		'a seat may not discard from somebody else8s hand'.replace('8', "'"));
	ok(!discarding.authorise(0, 'discard', [0, G.emptyResources()]).ok,
		'a seat that owes nothing may not discard');
	ok(!discarding.authorise(discarding.current().id, 'endTurn', []).ok,
		'the roller cannot end the turn while discards are pending');

	const offering = samples.offer;
	const responder = Number(Object.keys(offering.offer.responses)[0]);
	ok(offering.authorise(responder, 'respondToOffer', [responder, true]).ok,
		'a seat with a pending offer may answer, out of turn');
	ok(!offering.authorise(responder, 'respondToOffer', [offering.offer.from, true]).ok,
		'a seat may not answer on behalf of another');
	ok(!offering.authorise(responder, 'buildRoad', ['x']).ok,
		'answering an offer does not buy you a turn');

	ok(!samples.main.authorise(0, 'notARealAction', []).ok, 'unknown actions are refused');
	ok(!samples.over.authorise(samples.over.current().id, 'rollDice', []).ok,
		'a finished game accepts nothing');
}

/* ------------------------------------------ 4b. the special build phase */

function testSpecialBuild() {
	section('the special build phase');

	// Defaults: on from five players, and overridable in both directions.
	ok(makeGame(4, 'standard').specialBuild === false, 'off by default at four');
	ok(makeGame(5, 'large').specialBuild === true, 'on by default at five');
	ok(makeGame(6, 'large').specialBuild === true, 'on by default at six');
	ok(makeGame(4, 'standard', { specialBuild: true }).specialBuild === true, 'can be forced on at four');
	ok(makeGame(6, 'large', { specialBuild: false }).specialBuild === false, 'can be forced off at six');

	/* Take a five-player game to the start of a turn, then end it. */
	const game = makeGame(5, 'large');
	while (game.phase === 'setup') {
		if (game.setupStep === 'settlement') game.placeSetupSettlement(AI.setupSettlement(game));
		else game.placeSetupRoad(AI.setupRoad(game));
	}
	const active = game.current().id;
	const turnBefore = game.turn;
	game.rollDice();
	if (game.phase !== 'main') game.phase = 'main';   // skip a 7 if we rolled one
	game.pendingDiscards = {};

	ok(game.endTurn().ok, 'ending a turn opens the special build phase');
	ok(game.phase === 'build', 'the phase is build', game.phase);
	ok(game.turn === turnBefore, 'the turn counter has not moved yet');
	ok(game.buildOrder.length === game.players.length - 1,
		'everyone except the active player is queued', String(game.buildOrder));
	ok(game.buildOrder.indexOf(active) < 0, 'the active player does not build in their own phase');
	ok(game.buildOrder[0] === (active + 1) % game.players.length,
		'the queue starts with whoever rolls next');
	ok(game.activePlayer().id === active, 'activePlayer still names whose turn it is');

	// Everything that is not building or buying is refused, by rule not by seat.
	const builder = game.current().id;
	M.RESOURCES.forEach(function (res) { game.players[builder].resources[res] = 5; });
	ok(game.authorise(builder, 'tradeBank', ['brick', 'ore']).ok,
		'the builder is the one the game is waiting on');
	ok(!game.tradeBank('brick', 'ore').ok, 'but bank trading is refused');
	ok(!game.openOffer({ brick: 1 }, { ore: 1 }).ok, 'and so is offering a trade');
	game.players[builder].dev.knight = 1;
	ok(!game.playDev('knight').ok, 'and so is playing a development card');
	ok(!game.rollDice().ok, 'and so is rolling');
	ok(game.offer === null, 'no offer survived the refusals');

	// Buying is allowed, and what you buy is not playable until your own turn.
	const deckBefore = game.devDeck.length;
	ok(game.buyDev().ok, 'buying a development card is allowed');
	ok(game.devDeck.length === deckBefore - 1, 'the card left the deck');
	ok(G.devTotal(game.players[builder]) > 1, 'the card is in hand');

	// Each seat gets exactly one pass, then the next turn starts.
	let passes = 0;
	while (game.phase === 'build' && passes < 10) {
		passes++;
		game.endTurn();
	}
	ok(passes === game.players.length - 1, 'each queued seat passed once', passes + ' passes');
	ok(game.phase === 'roll', 'the next turn begins with a roll', game.phase);
	ok(game.turn === turnBefore + 1, 'and the turn counter moved exactly once');
	ok(game.current().id === (active + 1) % game.players.length, 'it is the next player&apos;s turn');
	ok(game.buildOrder.length === 0, 'the queue is cleared');

	// With the phase off, ending a turn goes straight to the next roll.
	const plain = makeGame(6, 'large', { specialBuild: false });
	while (plain.phase === 'setup') {
		if (plain.setupStep === 'settlement') plain.placeSetupSettlement(AI.setupSettlement(plain));
		else plain.placeSetupRoad(AI.setupRoad(plain));
	}
	plain.rollDice();
	if (plain.phase !== 'main') plain.phase = 'main';
	plain.pendingDiscards = {};
	plain.endTurn();
	ok(plain.phase === 'roll', 'with the phase off, endTurn goes straight to the next roll');

	// Winning during someone else&apos;s turn is legal and must end the game.
	const winning = makeGame(5, 'large', { specialBuild: true, targetVP: 3 });
	while (winning.phase === 'setup') {
		if (winning.setupStep === 'settlement') winning.placeSetupSettlement(AI.setupSettlement(winning));
		else winning.placeSetupRoad(AI.setupRoad(winning));
	}
	winning.rollDice();
	if (winning.phase !== 'main') winning.phase = 'main';
	winning.pendingDiscards = {};
	winning.endTurn();
	const buyer = winning.current().id;
	M.RESOURCES.forEach(function (res) { winning.players[buyer].resources[res] = 9; });
	const spot = winning.legalCities(buyer)[0];
	ok(winning.phase === 'build' && spot !== undefined, 'set up a winnable special build');
	if (spot !== undefined) {
		winning.buildCity(spot);
		ok(winning.phase === 'over' && winning.winner === buyer,
			'a player can win during their special build', winning.phase + '/' + winning.winner);
	}
}

/* -------------------------------------------- 5. wrong sender is refused */

function testWrongSender() {
	section('replaying a game with the wrong sender');
	const SEED = 20260730;
	const map = M.standardMap();
	const configs = [0, 1, 2, 3].map(function (i) {
		return { name: 'p' + i, isBot: true };
	});
	const recorded = [];

	// Record a real game as (seat, action, args), with the dice pinned so it can
	// be played back move for move.
	const rec = withSeed(SEED, function () {
		const g = new G.Game(map, configs);
		let guard = 0;
		while (g.phase !== 'over' && guard++ < 4000) {
			const seat = g.current().id;
			if (g.phase === 'discard') {
				const id = Object.keys(g.pendingDiscards).map(Number)[0];
				const picks = AI.discard(g, id);
				recorded.push([id, 'discard', [id, picks]]);
				g.discard(id, picks);
			} else if (g.phase === 'setup') {
				if (g.setupStep === 'settlement') {
					const vk = AI.setupSettlement(g);
					recorded.push([seat, 'placeSetupSettlement', [vk]]);
					g.placeSetupSettlement(vk);
				} else {
					const ek = AI.setupRoad(g);
					recorded.push([seat, 'placeSetupRoad', [ek]]);
					g.placeSetupRoad(ek);
				}
			} else if (g.phase === 'robber') {
				const choice = AI.robberChoice(g);
				recorded.push([seat, 'moveRobber', [choice.hex, choice.victim]]);
				g.moveRobber(choice.hex, choice.victim);
			} else if (g.phase === 'roll') {
				recorded.push([seat, 'rollDice', []]);
				g.rollDice();
			} else {
				recorded.push([seat, 'endTurn', []]);
				g.endTurn();
			}
		}
		return g;
	});

	/* Replay it faithfully, and at every step offer the same action from every
	 * other seat as well. The replay has to stay in step with the recording or an
	 * impostor eventually becomes the current player by accident and the test
	 * stops meaning anything - hence the faithful apply, and a pure authorise()
	 * probe for the impostors. */
	let refusedReplay = 0;
	let impostorsAccepted = 0;
	let probes = 0;

	const replay = withSeed(SEED, function () {
		const g = new G.Game(map, configs);
		recorded.forEach(function (entry) {
			g.players.forEach(function (_, impostor) {
				if (impostor === entry[0]) return;
				probes++;
				if (g.authorise(impostor, entry[1], entry[2]).ok) impostorsAccepted++;
			});
			if (!Net.apply(g, entry[0], entry[1], entry[2]).ok) refusedReplay++;
		});
		return g;
	});

	ok(recorded.length > 40, 'recorded a game worth replaying', recorded.length + ' actions');
	ok(refusedReplay === 0, 'the recording replays cleanly from the right seats',
		refusedReplay + ' refused');
	ok(replay.phase === rec.phase && replay.turn === rec.turn &&
		JSON.stringify(replay.buildings) === JSON.stringify(rec.buildings),
		'the replay lands in exactly the same place as the recording');
	ok(impostorsAccepted === 0, probes + ' impostor attempts all refused',
		impostorsAccepted + ' slipped through');

	/* And the out-of-order case: skip ahead to an action from the next seat and
	 * it must be refused rather than quietly applied. */
	let swapIndex = -1;
	for (let i = 1; i < recorded.length - 1; i++) {
		if (recorded[i][0] !== recorded[i + 1][0]) { swapIndex = i; break; }
	}
	const swapRefused = withSeed(SEED, function () {
		if (swapIndex < 0) return false;
		const g = new G.Game(map, configs);
		for (let i = 0; i < swapIndex; i++) Net.apply(g, recorded[i][0], recorded[i][1], recorded[i][2]);
		const later = recorded[swapIndex + 1];
		return !Net.apply(g, later[0], later[1], later[2]).ok;
	});
	ok(swapIndex >= 0, 'found two neighbouring actions from different seats');
	ok(swapRefused, 'an action that arrives a turn early is refused');
}

/* ---------------------------------------------- 6. host and guest, in memory */

/* Two Net endpoints wired directly to each other. Same code paths as the real
 * thing minus Trystero: the guest still only ever sees what viewFor gives it. */
function testHostGuest() {
	section('a host and a guest playing over an in-memory link');

	const map = M.standardMap();
	const configs = [
		{ name: 'host', isBot: false },
		{ name: 'friend', isBot: false },
		{ name: 'bot', isBot: true }
	];
	const game = new G.Game(map, configs);

	let actCb = null;
	let guestView = null;
	const GUEST = 1;
	let leaked = 0;
	let views = 0;
	let revealed = 0;

	const hostLink = {
		onAct: function (cb) { actCb = cb; },
		onSeatChange: function () {},
		sendView: function (s, payload) {
			if (s !== GUEST) return;
			views++;
			// Everything the guest is handed goes through this check, right up to
			// the final view - which is the one place a full reveal is intended,
			// because the scoreboard has to show hidden victory point cards.
			if (payload.view && payload.view.phase !== 'over') {
				leaked += hiddenHandLeaks(payload.view, game, GUEST);
				if (typeof payload.view.devDeck !== 'number') leaked++;
			} else {
				revealed++;
			}
			guestView(payload);
		},
		seats: function () { return [GUEST]; },
		close: function () {}
	};

	const hostNet = Net.host(game, 0, hostLink);
	const guestNet = Net.guest(GUEST, {
		sendAct: function (msg) { actCb(GUEST, msg); },
		onView: function (cb) { guestView = cb; },
		close: function () {}
	});

	let updates = 0;
	guestNet.onUpdate(function () { updates++; });
	hostNet.sync();

	/* Drive both humans with the bot brain: the host straight through hostNet,
	 * the guest through guestNet, which is the path a browser would take. */
	function driveSeat(seatNet, seat) {
		let acted = false;
		function send(action, args) {
			seatNet.send(action, args, function (result) { acted = result.ok; });
		}
		if (game.phase === 'discard') {
			if (game.pendingDiscards[seat]) send('discard', [seat, AI.discard(game, seat)]);
			return acted;
		}
		if (game.current().id !== seat) return false;
		if (game.phase === 'setup') {
			if (game.setupStep === 'settlement') send('placeSetupSettlement', [AI.setupSettlement(game)]);
			else send('placeSetupRoad', [AI.setupRoad(game)]);
			return acted;
		}
		if (game.phase === 'robber') {
			const choice = AI.robberChoice(game);
			send('moveRobber', [choice.hex, choice.victim]);
			if (game.awaitingSteal) send('chooseVictim', [game.awaitingSteal[0]]);
			return acted;
		}
		if (game.phase === 'roll') {
			send('rollDice', []);
			return acted;
		}
		if (game.phase === 'main') {
			// One cheap build then pass, so the game moves along briskly.
			if (!AI.step(gameProxy(seatNet, seat))) send('endTurn', []);
			return true;
		}
		return false;
	}

	/* AI.step wants to call the engine directly. Online it may not, so it gets a
	 * stand-in whose mutators go out through the net instead. */
	function gameProxy(seatNet, seat) {
		const proxy = Object.create(game);
		ACTION_NAMES.forEach(function (action) {
			proxy[action] = function () {
				let out = { ok: false };
				seatNet.send(action, Array.prototype.slice.call(arguments), function (r) { out = r; });
				return out;
			};
		});
		return proxy;
	}

	let guard = 0;
	while (game.phase !== 'over' && guard++ < 4000) {
		if (game.phase === 'discard') {
			Object.keys(game.pendingDiscards).map(Number).forEach(function (id) {
				if (id === GUEST) driveSeat(guestNet, GUEST);
				else if (id === 0) driveSeat(hostNet, 0);
				else game.discard(id, AI.discard(game, id));
			});
			continue;
		}
		const seat = game.current().id;
		if (seat === GUEST) driveSeat(guestNet, GUEST);
		else if (seat === 0) driveSeat(hostNet, 0);
		else {
			// The bot seat runs on the host, exactly as it does in the browser.
			if (game.phase === 'robber') {
				const choice = AI.robberChoice(game);
				game.moveRobber(choice.hex, choice.victim);
			} else if (game.phase === 'setup') {
				if (game.setupStep === 'settlement') game.placeSetupSettlement(AI.setupSettlement(game));
				else game.placeSetupRoad(AI.setupRoad(game));
			} else if (!AI.step(game) && game.phase === 'main') {
				game.endTurn();
			}
			hostNet.sync();
		}
	}

	const seen = guestNet.game();
	ok(game.phase === 'over', 'the networked game finishes', 'stopped in ' + game.phase);
	ok(views > 50, 'the guest was pushed a view for every change', views + ' views');
	ok(updates > 0, 'the guest was told about changes it did not cause');
	ok(leaked === 0, 'nothing hidden ever reached the guest', leaked + ' leaks');
	ok(revealed > 0, 'the guest got the end-of-game reveal', revealed + ' final views');
	ok(!!seen, 'the guest ended up holding a game');
	ok(seen && seen.phase === game.phase && seen.turn === game.turn,
		'the guest view tracks the host');
	ok(seen && JSON.stringify(seen.buildings) === JSON.stringify(game.buildings),
		'the guest sees the same board');
	ok(seen && typeof seen.players[GUEST].resources === 'object',
		'the guest can read its own hand');
	ok(conserved(game), 'the networked game conserved its cards');
}

/* -------------------------------------------------------------------- run */

const count = Number(process.argv[2]) || 1000;
const started = Date.now();

testGames(count);
testRoundTrip(Math.max(20, Math.round(count / 10)));
testRedaction();
testAuthorisation();
testSpecialBuild();
testWrongSender();
testHostGuest();

console.log('\n' + (failures ? failures + ' of ' + checks + ' checks FAILED' : checks + ' checks passed') +
	' in ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
process.exit(failures ? 1 : 0);
