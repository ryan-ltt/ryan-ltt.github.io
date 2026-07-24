// Headless Monopoly rules engine. No DOM dependency - runs identically in Node (for simulation)
// and in the browser (for the real game). All player decisions are delegated to an `agent`
// object with async-free callback methods (decisions are resolved synchronously via a
// decide* method returning a value, OR asynchronously in the UI via a promise-based agent).
//
// Two agent styles are supported:
//   - Synchronous agents (bots): every decide* method returns a plain value immediately.
//   - Asynchronous agents (human UI): decide* methods may return a Promise.
// The engine always awaits, so both work through the same `run` methods.

(function (root) {
	'use strict';

	const Board = (typeof module !== 'undefined' && module.exports) ? require('./board.js') : root.MonopolyBoard;

	function shuffle(arr, rng) {
		const a = arr.slice();
		for (let i = a.length - 1; i > 0; i--) {
			const j = Math.floor(rng() * (i + 1));
			[a[i], a[j]] = [a[j], a[i]];
		}
		return a;
	}

	// Simple seedable RNG (mulberry32) so simulations are reproducible.
	function mulberry32(seed) {
		let a = seed >>> 0;
		return function () {
			a |= 0; a = (a + 0x6D2B79F5) | 0;
			let t = Math.imul(a ^ (a >>> 15), 1 | a);
			t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	class Player {
		constructor(id, name, agent) {
			this.id = id;
			this.name = name;
			this.agent = agent;
			this.money = 1500;
			this.pos = 0;
			this.properties = []; // array of position ints
			this.inJail = false;
			this.jailTurns = 0;
			this.getOutOfJailFree = 0; // count of cards held
			this.bankrupt = false;
			this.consecutiveDoubles = 0;
		}
	}

	class Property {
		constructor(space) {
			this.pos = space.pos;
			this.type = space.type; // property, rail, utility
			this.group = space.group || space.type;
			this.owner = null; // player id or null
			this.houses = 0; // 0-4, 5 = hotel
			this.mortgaged = false;
		}
	}

	class MonopolyGame {
		/**
		 * @param {Array} agents - array of {name, agent} - agent implements decision methods
		 * @param {Object} opts - {seed, startingMoney, maxTurns}
		 */
		constructor(agents, opts = {}) {
			this.seed = opts.seed != null ? opts.seed : Math.floor(Math.random() * 2 ** 31);
			this.rng = mulberry32(this.seed);
			this.players = agents.map((a, i) => new Player(i, a.name || `Player ${i + 1}`, a.agent));
			this.properties = {};
			Board.SPACES.forEach(s => {
				if (s.type === 'property' || s.type === 'rail' || s.type === 'utility') {
					this.properties[s.pos] = new Property(s);
				}
			});
			this.chestDeck = shuffle(Board.CHEST_CARDS, this.rng);
			this.chestIdx = 0;
			this.fateDeck = shuffle(Board.FATE_CARDS, this.rng);
			this.fateIdx = 0;
			this.freeParkingPot = 0;
			this.turnCount = 0;
			this.maxTurns = opts.maxTurns || 1000;
			this.log = [];
			this.houseSupply = Board.HOUSE_SUPPLY;
			this.hotelSupply = Board.HOTEL_SUPPLY;
			this.verbose = !!opts.verbose;
			this.currentPlayerIdx = 0;
			this.gameOver = false;
			this.winner = null;
		}

		logEvent(msg) {
			if (this.verbose) this.log.push(msg);
		}

		/** Fires a structured, UI-facing notification for a game event that isn't already covered
		 * by a decide* popup (onAgentDecision) - card draws, rent/tax payments, jail, bankruptcy,
		 * auction outcomes, passing Go. Optional: no-op for headless sims / bots, since only ui.js
		 * assigns onEvent. Awaited so the UI can pause the game loop until the player acknowledges
		 * the popup (e.g. clicks "X") - callers must `await` this like onMove/onAgentDecision. */
		async emitEvent(type, data) {
			if (typeof this.onEvent === 'function') await this.onEvent(type, data);
		}

		/** Announces a player-to-player cash transfer at the moment it's about to be applied, so the
		 * UI can tag the pair BEFORE the money actually moves. Rent/bankruptcy notices are emitted
		 * only after payMoney() has already transferred (deliberately - see resolvePropertySpace), so
		 * a hint set from those events arrives too late whenever an intervening checkpoint (a
		 * liquidation popup's dismiss, say) has already diffed the transfer and routed it through the
		 * bank as two separate legs. Firing here instead means the pair is always known first.
		 * Synchronous and optional: no-op for headless sims, since only ui.js assigns onTransfer. */
		notifyTransfer(from, to, amount) {
			if (typeof this.onTransfer === 'function' && from && to && amount > 0) {
				this.onTransfer(from, to, amount);
			}
		}

		activePlayers() {
			return this.players.filter(p => !p.bankrupt);
		}

		rollDice() {
			const d1 = 1 + Math.floor(this.rng() * 6);
			const d2 = 1 + Math.floor(this.rng() * 6);
			return [d1, d2];
		}

		/** Gives the current player's agent a chance to gate the roll on user interaction
		 * (e.g. a "Roll Dice" button + animation in the UI). Bots that don't implement
		 * decideRoll are unaffected - callAgent returns null immediately for them. */
		async rollDiceForPlayer(player) {
			await this.callAgent(player, 'decideRoll', { player, game: this });
			const roll = this.rollDice();
			// onRoll may return a Promise (the UI's dice-throw animation) - awaiting it makes the token
			// move wait until the dice have finished being thrown and settled, for every player. No-op
			// for headless sims/bots (only ui.js assigns onRoll); game state / RNG are untouched.
			if (typeof this.onRoll === 'function') await this.onRoll(player, roll[0], roll[1]);
			return roll;
		}

		nextChestCard() {
			if (this.chestIdx >= this.chestDeck.length) {
				this.chestDeck = shuffle(Board.CHEST_CARDS, this.rng);
				this.chestIdx = 0;
			}
			return this.chestDeck[this.chestIdx++];
		}

		nextFateCard() {
			if (this.fateIdx >= this.fateDeck.length) {
				this.fateDeck = shuffle(Board.FATE_CARDS, this.rng);
				this.fateIdx = 0;
			}
			return this.fateDeck[this.fateIdx++];
		}

		propertiesInGroup(group) {
			return Board.GROUP_MEMBERS[group] || [];
		}

		ownsFullGroup(playerId, group) {
			const members = this.propertiesInGroup(group);
			if (!members.length) return false;
			return members.every(pos => this.properties[pos].owner === playerId);
		}

		countRailsOwned(playerId) {
			return Board.RAIL_POSITIONS.filter(p => this.properties[p].owner === playerId).length;
		}

		countUtilitiesOwned(playerId) {
			return Board.UTILITY_POSITIONS.filter(p => this.properties[p].owner === playerId).length;
		}

		getSpace(pos) {
			return Board.SPACES[pos];
		}

		calcRent(pos, diceRoll) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (prop.mortgaged) return 0;
			if (space.type === 'rail') {
				const n = this.countRailsOwned(prop.owner);
				return space.rent[Math.min(n, 4) - 1];
			}
			if (space.type === 'utility') {
				const n = this.countUtilitiesOwned(prop.owner);
				const mult = n >= 2 ? 10 : 4;
				return mult * (diceRoll || 7);
			}
			// property
			if (prop.houses >= 5) return space.rent[5]; // hotel
			if (prop.houses > 0) return space.rent[prop.houses];
			const ownsAll = this.ownsFullGroup(prop.owner, prop.group);
			return ownsAll ? space.rent[0] * 2 : space.rent[0];
		}

		netWorth(player) {
			let total = player.money;
			for (const pos of player.properties) {
				const prop = this.properties[pos];
				const space = this.getSpace(pos);
				total += prop.mortgaged ? space.price / 2 : space.price;
				if (prop.houses > 0 && prop.houses < 5) total += prop.houses * space.houseCost;
				if (prop.houses >= 5) total += 5 * space.houseCost;
			}
			return total;
		}

		// ---- Core turn loop (synchronous-friendly, but always returns a Promise) ----

		async playTurn() {
			const player = this.players[this.currentPlayerIdx];
			if (player.bankrupt) { this.advanceTurn(); return; }

			this.turnCount++;
			player.consecutiveDoubles = 0;
			let rolledDoublesCount = 0;
			let turnActive = true;

			// Pre-roll action phase: lets a player build/mortgage/trade BEFORE rolling. Gated to
			// human players only - bots' strategy was grid-searched against a post-roll-only turn, so
			// giving them a second action window would change their (frozen) behavior. For humans it's
			// the whole point of the UI's whole-turn trading: the action bar and click-to-trade are
			// live from the moment the turn starts, not just after the roll. actionCtx carries
			// phase:'preRoll' so the UI shows a Roll button (not End Turn) and knows 'done' means
			// "proceed to roll", not "end turn". Skipped for jailed players (their turn opens with the
			// jail decision instead).
			if (player.agent && player.agent.isHuman && !player.inJail) {
				await this.postLandingActions(player, 'preRoll');
				if (player.bankrupt || this.gameOver) { this.checkGameOver(); this.advanceTurn(); return; }
			}

			while (turnActive && !player.bankrupt && !this.gameOver) {
				if (player.inJail) {
					const handled = await this.handleJailTurn(player);
					if (!handled) { turnActive = false; break; }
					// handled === true means they rolled out this turn and should move
				}

				const [d1, d2] = await this.rollDiceForPlayer(player);
				const isDouble = d1 === d2;
				this.logEvent(`${player.name} rolled ${d1},${d2}`);

				if (isDouble) {
					rolledDoublesCount++;
					if (rolledDoublesCount === 3) {
						this.logEvent(`${player.name} rolled 3 doubles - go to jail`);
						// jail first, then notice (so the token is at Jail when the notice dismisses)
						this.sendToJail(player);
						await this.emitEvent('gotojail', { player, reason: 'doubles' });
						turnActive = false;
						break;
					}
				}

				await this.movePlayer(player, d1 + d2, true);
				if (player.bankrupt || this.gameOver) break;

				await this.resolveSpace(player, d1 + d2);
				if (player.bankrupt || this.gameOver) break;

				// post-landing actions: buy/build/trade offered every stop. On a (non-third) double the
				// player rolls again after this, so signal rollsAgain so the UI labels its button
				// "Roll Again" rather than "End Turn".
				await this.postLandingActions(player, undefined, isDouble);
				if (player.bankrupt || this.gameOver) break;

				if (!isDouble) turnActive = false;
				else this.logEvent(`${player.name} rolled doubles, goes again`);
			}

			this.checkGameOver();
			this.advanceTurn();
		}

		advanceTurn() {
			if (this.gameOver) return;
			do {
				this.currentPlayerIdx = (this.currentPlayerIdx + 1) % this.players.length;
			} while (this.players[this.currentPlayerIdx].bankrupt && this.activePlayers().length > 1);
		}

		async handleJailTurn(player) {
			// returns true if player should proceed to move this turn, false if turn ends
			const jailCtx = { player, game: this };
			const decision = await this.callAgent(player, 'decideJail', jailCtx);
			if (decision === 'card' && player.getOutOfJailFree > 0) {
				player.getOutOfJailFree--;
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} uses Get Out of Jail Free card`);
				await this.notifyDecision(player, 'decideJail', jailCtx, decision);
				return true;
			}
			if (decision === 'pay' && player.money >= Board.JAIL_FINE) {
				await this.payMoney(player, Board.JAIL_FINE, null);
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} pays $${Board.JAIL_FINE} bail`);
				// decideJail is in DEFERRED_NOTIFY_METHODS (see callAgent) so this fires AFTER the
				// bail payment above, not before - same reasoning as decideBuyProperty.
				await this.notifyDecision(player, 'decideJail', jailCtx, decision);
				return true;
			}
			// 'stay' (or 'pay' without enough cash) - no popup either way (see _describeAgentDecision),
			// but still notify so the UI's _renderAll() runs and nothing relies on stale state.
			await this.notifyDecision(player, 'decideJail', jailCtx, decision);
			// attempt roll
			const [d1, d2] = await this.rollDiceForPlayer(player);
			player.jailTurns++;
			if (d1 === d2) {
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} rolled doubles, out of jail`);
				await this.emitEvent('jailOutcome', { player, outcome: 'rolledDoubles' });
				await this.movePlayer(player, d1 + d2, true);
				if (player.bankrupt || this.gameOver) return false;
				await this.resolveSpace(player, d1 + d2);
				if (player.bankrupt || this.gameOver) return false;
				await this.postLandingActions(player);
				return false; // move already consumed; end turn (no extra roll for jail doubles)
			}
			if (player.jailTurns >= 3) {
				await this.payMoney(player, Board.JAIL_FINE, null);
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} forced to pay bail after 3 tries`);
				await this.emitEvent('jailOutcome', { player, outcome: 'forcedBail' });
				await this.movePlayer(player, d1 + d2, true);
				if (player.bankrupt || this.gameOver) return false;
				await this.resolveSpace(player, d1 + d2);
				if (player.bankrupt || this.gameOver) return false;
				await this.postLandingActions(player);
				return false;
			}
			this.logEvent(`${player.name} stays in jail (attempt ${player.jailTurns})`);
			return false;
		}

		/** @param direction 'forward' (default) or 'backward' - purely a hint passed through to
		 * onMove so the UI can animate the token the right way round (e.g. "Go Back 3 Spaces"
		 * walking backward 3 tiles instead of forward the long way around the board). Never
		 * affects game state - collectSalary/newPos math is unchanged either way. */
		async movePlayer(player, spaces, collectSalary, direction) {
			const oldPos = player.pos;
			const newPos = (player.pos + spaces) % Board.BOARD_SIZE;
			if (collectSalary && newPos < oldPos) {
				await this.receiveMoney(player, Board.GO_SALARY);
				this.logEvent(`${player.name} passes Start, collects $200`);
				await this.emitEvent('passGo', { player, amount: Board.GO_SALARY });
			}
			player.pos = newPos;
			// onMove may return a Promise (e.g. the UI animating the token along the board) -
			// awaiting it lets the animation finish before the engine resolves the landed-on space.
			if (typeof this.onMove === 'function') await this.onMove(player, oldPos, newPos, direction || 'forward');
		}

		/** Fires onMove for a position change that has ALREADY been applied to player.pos (e.g. the
		 * "advance to X" cards, which set player.pos directly and then resolve rent/purchase at the
		 * destination). Lets the UI walk the token there the same way a dice move animates, instead of
		 * the token snapping via ui.js's stale-position safety net. Game state is untouched - this is
		 * purely a UI hook, and no-op for headless sims/bots (only ui.js assigns onMove). */
		async emitMove(player, oldPos, direction) {
			if (oldPos === player.pos) return;
			if (typeof this.onMove === 'function') await this.onMove(player, oldPos, player.pos, direction || 'forward');
		}

		async receiveMoney(player, amount) {
			player.money += amount;
		}

		/** Attempts to deduct money; if insufficient, triggers liquidation/bankruptcy flow. creditor is a Player or null (bank). */
		async payMoney(player, amount, creditor) {
			if (player.money >= amount) {
				// tag the pair before the cash moves, so the UI never diffs this as two bank legs
				this.notifyTransfer(player, creditor, amount);
				player.money -= amount;
				if (creditor) creditor.money += amount;
				else this.freeParkingPot += amount; // house rule OFF by default via config below; harmless if unused
				return true;
			}
			// need to raise cash
			await this.raiseCash(player, amount);
			if (player.money >= amount) {
				this.notifyTransfer(player, creditor, amount);
				player.money -= amount;
				if (creditor) creditor.money += amount;
				return true;
			}
			// still short -> bankrupt to creditor (or bank)
			await this.declareBankruptcy(player, creditor);
			return false;
		}

		async raiseCash(player, amountNeeded) {
			// Ask agent for a liquidation plan repeatedly until enough cash or no more moves possible
			let guard = 0;
			while (player.money < amountNeeded && guard < 200) {
				guard++;
				const sellable = this.getSellableAssets(player);
				if (!sellable.length) break;
				const liqCtx = { player, game: this, amountNeeded, sellable };
				const action = await this.callAgent(player, 'decideLiquidation', liqCtx);
				if (!action) break;
				// decideLiquidation is in DEFERRED_NOTIFY_METHODS (see callAgent) so this fires AFTER
				// the mortgage/sale below is applied, not before - same reasoning as decideBuyProperty.
				if (action.type === 'mortgage') {
					this.mortgageProperty(player, action.pos);
					await this.notifyDecision(player, 'decideLiquidation', liqCtx, action);
				} else if (action.type === 'sellHouse') {
					this.sellHouse(player, action.pos);
					await this.notifyDecision(player, 'decideLiquidation', liqCtx, action);
				} else {
					break;
				}
			}
		}

		getSellableAssets(player) {
			const options = [];
			for (const pos of player.properties) {
				const prop = this.properties[pos];
				const space = this.getSpace(pos);
				if (prop.houses > 0) {
					// can only sell houses if selling evenly (simplify: allow if it's the max in group or single)
					options.push({ type: 'sellHouse', pos, value: Math.floor(space.houseCost / 2) });
				}
			}
			for (const pos of player.properties) {
				const prop = this.properties[pos];
				const space = this.getSpace(pos);
				if (!prop.mortgaged && prop.houses === 0) {
					options.push({ type: 'mortgage', pos, value: Math.floor(space.price / 2) });
				}
			}
			return options;
		}

		mortgageProperty(player, pos) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (prop.mortgaged || prop.owner !== player.id) return;
			prop.mortgaged = true;
			player.money += Math.floor(space.price / 2);
			this.logEvent(`${player.name} mortgages ${space.name} for $${Math.floor(space.price / 2)}`);
		}

		unmortgageProperty(player, pos) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (!prop.mortgaged || prop.owner !== player.id) return false;
			const cost = Math.ceil(space.price / 2 * 1.1);
			if (player.money < cost) return false;
			player.money -= cost;
			prop.mortgaged = false;
			this.logEvent(`${player.name} unmortgages ${space.name} for $${cost}`);
			return true;
		}

		sellHouse(player, pos) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (prop.houses === 0) return;
			if (prop.houses === 5) { this.hotelSupply++; this.houseSupply -= 4; } // hotel back to 4 houses conceptually
			prop.houses -= 1;
			player.money += Math.floor(space.houseCost / 2);
			this.houseSupply++;
			this.logEvent(`${player.name} sells a house on ${space.name}`);
		}

		buildHouse(player, pos) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (prop.houses >= 5) return false;
			if (prop.houses === 4) {
				if (this.hotelSupply <= 0) return false;
			} else if (this.houseSupply <= 0) return false;
			if (player.money < space.houseCost) return false;
			player.money -= space.houseCost;
			if (prop.houses === 4) { this.hotelSupply--; this.houseSupply += 4; }
			else this.houseSupply--;
			prop.houses++;
			this.logEvent(`${player.name} builds on ${space.name} (now ${prop.houses})`);
			return true;
		}

		canBuildOn(player, pos) {
			const prop = this.properties[pos];
			const space = this.getSpace(pos);
			if (space.type !== 'property') return false;
			if (prop.owner !== player.id) return false;
			if (!this.ownsFullGroup(player.id, space.group)) return false;
			if (prop.mortgaged) return false;
			if (prop.houses >= 5) return false;
			// bank's physical piece supply - the 5th "house" on a property is actually a hotel, drawn
			// from the separate hotel pool; buildHouse() enforces this same split. Without this check,
			// a bot whose strategy doesn't track remaining supply (money is its own responsibility -
			// see strategy.js's buildThreshold) can get stuck repeatedly deciding to build on a property
			// that's guaranteed to fail once the bank is out of houses, firing an empty "Builds a
			// house" notification each time with nothing actually happening.
			if (prop.houses === 4) { if (this.hotelSupply <= 0) return false; }
			else if (this.houseSupply <= 0) return false;
			// even building rule: can't build more than 1 ahead of lowest in group
			const members = this.propertiesInGroup(space.group);
			const minHouses = Math.min(...members.map(p => this.properties[p].houses));
			if (prop.houses > minHouses) return false;
			return true;
		}

		async declareBankruptcy(player, creditor) {
			player.bankrupt = true;
			this.logEvent(`${player.name} is BANKRUPT`);
			await this.emitEvent('bankruptcy', { player, creditor: creditor || null });
			if (creditor) {
				this.notifyTransfer(player, creditor, player.money);
				creditor.money += player.money;
				player.money = 0;
				for (const pos of player.properties.slice()) {
					const prop = this.properties[pos];
					prop.owner = creditor.id;
					creditor.properties.push(pos);
					// mortgaged status carries over; creditor must pay 10% to unmortgage later per rules, simplified: kept mortgaged
				}
				player.properties = [];
				player.getOutOfJailFree = 0; // simplified: cards returned to deck conceptually
			} else {
				// bankrupt to bank: properties returned to bank (auctioned in full implementation; simplified: unowned)
				for (const pos of player.properties.slice()) {
					const prop = this.properties[pos];
					prop.owner = null;
					prop.houses = 0;
					prop.mortgaged = false;
				}
				player.properties = [];
			}
			this.checkGameOver();
		}

		checkGameOver() {
			const active = this.activePlayers();
			if (active.length <= 1) {
				this.gameOver = true;
				this.winner = active[0] || null;
			}
			if (this.turnCount >= this.maxTurns) {
				this.gameOver = true;
				if (!this.winner) {
					// highest net worth wins on turn cap
					this.winner = active.slice().sort((a, b) => this.netWorth(b) - this.netWorth(a))[0];
				}
			}
		}

		async resolveSpace(player, diceRoll) {
			const space = this.getSpace(player.pos);
			switch (space.type) {
				case 'go': break;
				case 'tax':
					this.logEvent(`${player.name} pays tax $${space.amount}`);
					await this.payMoney(player, space.amount, null);
					await this.emitEvent('tax', { player, amount: space.amount, spaceName: space.name });
					break;
				case 'chest': {
					const card = this.nextChestCard();
					await this.drawCardAndNotify(player, card, diceRoll, 'chest');
					break;
				}
				case 'fate': {
					const card = this.nextFateCard();
					await this.drawCardAndNotify(player, card, diceRoll, 'fate');
					break;
				}
				case 'gotojail':
					// send to jail BEFORE the notice so the token is already at Jail when the notice
					// dismisses (its _renderAll snaps the token there) - otherwise the move to Jail is
					// deferred to the next render (e.g. when the action bar appears), reading as laggy.
					this.sendToJail(player);
					await this.emitEvent('gotojail', { player, reason: 'space' });
					break;
				case 'jail':
				case 'freeparking':
					break;
				case 'property':
				case 'rail':
				case 'utility':
					await this.resolvePropertySpace(player, space, diceRoll);
					break;
			}
		}

		sendToJail(player) {
			player.pos = Board.JAIL_POS;
			player.inJail = true;
			player.jailTurns = 0;
			this.logEvent(`${player.name} sent to jail`);
		}

		// Card actions that move the player and cascade into their own further notifications (rent,
		// a purchase decision, another card draw via postLandingActions's building/mortgage menu) -
		// for these, the outer 'card' notice announcing the draw must fire BEFORE drawCard() runs, so
		// it appears first in the narrative ahead of whatever it triggers (e.g. "drew: Advance to
		// Boardwalk" before "pays $50 rent for Boardwalk"). Every other card action is fully resolved
		// money/state-wise by the time drawCard() returns with nothing further to announce, so for
		// those the notice fires AFTER instead - see drawCardAndNotify - matching the same
		// apply-before-notify fix already used for tax/decideBuyProperty/decideJail/decideLiquidation/
		// decideAction: notifying before the effect is applied leaves the UI's diff-based flying-bill
		// animation with nothing to see at that checkpoint.
		// Cards that WALK the player are cascading: the draw notice/animation fires BEFORE drawCard()
		// so the card is revealed first and the token then walks to its destination (otherwise the token
		// moves before the player is shown why, reading as a jarring "blast" across the board). The
		// go-to-jail card is deliberately NOT here: it is a teleport (no walk), so it stays non-cascading
		// - drawCard() jails the player first, then the card flip render snaps the token there right away
		// rather than deferring the jail move to a later render. UI ordering only, never game state / RNG.
		static CASCADING_CARD_ACTIONS = new Set([
			'goBack', 'advanceTo', 'advanceToGo', 'advanceToNearestRail', 'advanceToNearestRail2', 'advanceToNearestUtility'
		]);

		async drawCardAndNotify(player, card, diceRoll, deck) {
			if (MonopolyGame.CASCADING_CARD_ACTIONS.has(card.action)) {
				await this.emitEvent('card', { player, card, deck });
				await this.drawCard(player, card, diceRoll);
			} else {
				await this.drawCard(player, card, diceRoll);
				await this.emitEvent('card', { player, card, deck });
			}
		}

		async drawCard(player, card, diceRoll) {
			this.logEvent(`${player.name} draws: ${card.text}`);
			switch (card.action) {
				case 'collect':
					await this.receiveMoney(player, card.amount);
					break;
				case 'pay':
					await this.payMoney(player, card.amount, null);
					break;
				case 'collectFromEach':
					for (const other of this.activePlayers()) {
						if (other.id !== player.id) {
							await this.payMoney(other, card.amount, player);
						}
					}
					break;
				case 'payEach':
					for (const other of this.activePlayers()) {
						if (other.id !== player.id) {
							await this.payMoney(player, card.amount, other);
						}
					}
					break;
				case 'getOutOfJail':
					player.getOutOfJailFree++;
					break;
				case 'gotojail':
					this.sendToJail(player);
					break;
				case 'goBack':
					await this.movePlayer(player, Board.BOARD_SIZE - card.amount, false, 'backward');
					await this.resolveSpace(player, diceRoll);
					await this.postLandingActions(player);
					break;
				case 'advanceToGo': {
					const goOldPos = player.pos;
					player.pos = 0;
					await this.emitMove(player, goOldPos);
					await this.receiveMoney(player, Board.GO_SALARY);
					break;
				}
				case 'advanceTo': {
					const advOldPos = player.pos;
					const passed = card.pos < player.pos;
					player.pos = card.pos;
					await this.emitMove(player, advOldPos);
					if (passed) await this.receiveMoney(player, Board.GO_SALARY);
					await this.resolveSpace(player, diceRoll);
					await this.postLandingActions(player);
					break;
				}
				case 'advanceToNearestRail':
				case 'advanceToNearestRail2': {
					const railOldPos = player.pos;
					const rails = Board.RAIL_POSITIONS;
					let target = rails.find(p => p > player.pos);
					if (target === undefined) { target = rails[0]; await this.receiveMoney(player, Board.GO_SALARY); }
					const targetSpace = this.getSpace(target);
					player.pos = target;
					await this.emitMove(player, railOldPos);
					const prop = this.properties[target];
					if (prop.owner === null) {
						await this.offerPurchaseOrAuction(player, target);
					} else if (prop.owner !== player.id && !prop.mortgaged) {
						const owner = this.players[prop.owner];
						if (owner.bankrupt) break;
						const mult = card.action === 'advanceToNearestRail' ? 2 : 1;
						const rent = this.calcRent(target, diceRoll) * mult;
						this.logEvent(`${player.name} owes $${rent} rent to ${owner.name} for ${targetSpace.name}${mult > 1 ? ' (double rent)' : ''}`);
						// pay before the notice so the bills fly at its dismiss (see resolvePropertySpace)
						await this.payMoney(player, rent, owner);
						await this.emitEvent('rent', { player, owner, amount: rent, spaceName: targetSpace.name, pos: target });
					}
					break;
				}
				case 'advanceToNearestUtility': {
					const utilOldPos = player.pos;
					const utils = Board.UTILITY_POSITIONS;
					let target = utils.find(p => p > player.pos);
					if (target === undefined) { target = utils[0]; await this.receiveMoney(player, Board.GO_SALARY); }
					const targetSpace = this.getSpace(target);
					player.pos = target;
					await this.emitMove(player, utilOldPos);
					const prop = this.properties[target];
					if (prop.owner === null) {
						await this.offerPurchaseOrAuction(player, target);
					} else if (prop.owner !== player.id && !prop.mortgaged) {
						const owner = this.players[prop.owner];
						if (owner.bankrupt) break;
						const rent = 10 * diceRoll;
						this.logEvent(`${player.name} owes $${rent} rent to ${owner.name} for ${targetSpace.name} (10x dice)`);
						// pay before the notice so the bills fly at its dismiss (see resolvePropertySpace)
						await this.payMoney(player, rent, owner);
						await this.emitEvent('rent', { player, owner, amount: rent, spaceName: targetSpace.name, pos: target });
					}
					break;
				}
				case 'repairs': {
					let total = 0;
					for (const pos of player.properties) {
						const prop = this.properties[pos];
						if (prop.houses === 5) total += card.hotel;
						else total += prop.houses * card.house;
					}
					if (total > 0) await this.payMoney(player, total, null);
					break;
				}
			}
		}

		async resolvePropertySpace(player, space, diceRoll) {
			const prop = this.properties[space.pos];
			if (prop.owner === null) {
				await this.offerPurchaseOrAuction(player, space.pos);
			} else if (prop.owner !== player.id && !prop.mortgaged) {
				const owner = this.players[prop.owner];
				if (owner.bankrupt) return;
				const rent = this.calcRent(space.pos, diceRoll);
				this.logEvent(`${player.name} owes $${rent} rent to ${owner.name} for ${space.name}`);
				// Pay BEFORE emitting the notice (like tax, above) so that by the time the rent notice's
				// dismiss fires the UI's flying-bill checkpoint, the money has actually moved and the
				// bills fly right then - rather than the transfer being deferred to the next checkpoint
				// (which, for a human, could be the End Turn button). If the player can't afford it,
				// payMoney's liquidation runs first, then this notice shows the completed payment.
				await this.payMoney(player, rent, owner);
				await this.emitEvent('rent', { player, owner, amount: rent, spaceName: space.name, pos: space.pos });
			}
		}

		async offerPurchaseOrAuction(player, pos) {
			const space = this.getSpace(pos);
			const ctx = { player, game: this, pos };
			const wantsToBuy = player.money >= space.price
				? await this.callAgent(player, 'decideBuyProperty', ctx)
				: false;
			if (wantsToBuy) {
				player.money -= space.price;
				this.properties[pos].owner = player.id;
				player.properties.push(pos);
				this.logEvent(`${player.name} buys ${space.name} for $${space.price}`);
				// decideBuyProperty is in DEFERRED_NOTIFY_METHODS (see callAgent) specifically so this
				// can fire manually AFTER the purchase is applied above, not before.
				await this.notifyDecision(player, 'decideBuyProperty', ctx, true);
			} else {
				await this.runAuction(pos);
			}
		}

		async runAuction(pos) {
			const space = this.getSpace(pos);
			let bidders = this.activePlayers().map(p => p.id);
			let highBid = 0;
			let highBidder = null;
			let lastRaiseIdx = -1;
			if (bidders.length <= 1 && bidders.length > 0) {
				// still run a trivial auction so the single active player can grab it cheaply
			}
			if (bidders.length === 0) return;
			let idx = 0;
			let roundsWithNoRaise = 0;
			const active = new Set(bidders);
			// Non-blocking UI hooks (like onRoll/onMove) so ui.js can render a live auction room -
			// no-op for headless sims/bots since only ui.js assigns them. onAuctionBid is awaited so
			// the UI can pace/animate each AI raise before the next bidder is asked.
			if (typeof this.onAuctionStart === 'function') this.onAuctionStart({ pos, spaceName: space.name, bidders: bidders.slice() });
			while (active.size > 1 && roundsWithNoRaise < active.size) {
				const pid = bidders[idx % bidders.length];
				idx++;
				if (!active.has(pid)) continue;
				const player = this.players[pid];
				const bid = await this.callAgent(player, 'decideAuctionBid', { player, game: this, pos, highBid, highBidder });
				let outcome;
				if (bid && bid > highBid && bid <= player.money) {
					highBid = bid;
					highBidder = pid;
					roundsWithNoRaise = 0;
					outcome = 'raise';
				} else {
					active.delete(pid);
					roundsWithNoRaise++;
					outcome = 'pass';
				}
				if (typeof this.onAuctionBid === 'function') {
					await this.onAuctionBid({ playerId: pid, bid: outcome === 'raise' ? bid : 0, outcome, highBid, highBidder, stillIn: Array.from(active), pos });
				}
				if (active.size <= 1) break;
			}
			if (highBidder !== null && highBid > 0) {
				const winner = this.players[highBidder];
				winner.money -= highBid;
				this.properties[pos].owner = winner.id;
				winner.properties.push(pos);
				this.logEvent(`${winner.name} wins auction for ${space.name} at $${highBid}`);
				await this.emitEvent('auctionResult', { winner, spaceName: space.name, amount: highBid, pos });
			} else {
				this.logEvent(`Auction for ${space.name} closed with no bids`);
				await this.emitEvent('auctionResult', { winner: null, spaceName: space.name, amount: 0, pos });
			}
		}

		async postLandingActions(player, phase, rollsAgain) {
			// Building, mortgage/unmortgage, and trade offers happen here (agent-driven, may loop).
			// phase is 'preRoll' when called at the top of the turn (human-only, see playTurn) so the
			// UI can present a Roll button instead of End Turn; undefined for the normal post-landing
			// call. rollsAgain is true when this landing was a doubles roll that will be followed by
			// another roll - the UI uses it to label its primary button "Roll Again" instead of "End
			// Turn" so a human isn't misled into thinking their turn is over. Bots ignore both.
			let guard = 0;
			while (guard < 30) {
				guard++;
				const actionCtx = { player, game: this, phase, rollsAgain };
				const action = await this.callAgent(player, 'decideAction', actionCtx);
				if (!action || action.type === 'done') break;
				// decideAction is in DEFERRED_NOTIFY_METHODS (see callAgent) so each branch below
				// notifies manually AFTER its mutation is applied, not before - same reasoning as
				// decideBuyProperty. proposeTrade is the one exception: its own popup just describes
				// the offer being made (no money/property state to wait for), and the trade's actual
				// effects get their own separate notification once decideTradeResponse resolves
				// (handleTradeProposal -> callAgent, not deferred) - so it can notify immediately.
				if (action.type === 'build') {
					if (!this.canBuildOn(player, action.pos)) continue;
					this.buildHouse(player, action.pos);
					await this.notifyDecision(player, 'decideAction', actionCtx, action);
				} else if (action.type === 'sellHouse') {
					if (this.properties[action.pos].owner !== player.id) continue;
					this.sellHouse(player, action.pos);
					await this.notifyDecision(player, 'decideAction', actionCtx, action);
				} else if (action.type === 'mortgage') {
					this.mortgageProperty(player, action.pos);
					await this.notifyDecision(player, 'decideAction', actionCtx, action);
				} else if (action.type === 'unmortgage') {
					this.unmortgageProperty(player, action.pos);
					await this.notifyDecision(player, 'decideAction', actionCtx, action);
				} else if (action.type === 'proposeTrade') {
					await this.notifyDecision(player, 'decideAction', actionCtx, action);
					await this.handleTradeProposal(player, action.trade);
				} else {
					break;
				}
			}
		}

		async handleTradeProposal(proposer, trade) {
			// trade: {toId, offerProps:[pos], offerMoney, requestProps:[pos], requestMoney, offerCards, requestCards}
			const target = this.players[trade.toId];
			if (!target || target.bankrupt) return;
			// validate ownership
			for (const p of trade.offerProps) if (this.properties[p].owner !== proposer.id) return;
			for (const p of trade.requestProps) if (this.properties[p].owner !== target.id) return;
			if (proposer.money < (trade.offerMoney || 0)) return;
			if (target.money < (trade.requestMoney || 0)) return;
			const tradeCtx = { player: target, game: this, trade, proposer };
			const accept = await this.callAgent(target, 'decideTradeResponse', tradeCtx);
			// lets a bot proposer's agent record a rejection (so it offers more next time) - duck-typed
			// since the human agent has no such method, and this never fires for lookahead rollouts
			// (those apply hypothetical trades directly via applyTradeEffects, bypassing this method).
			if (proposer.agent && typeof proposer.agent.onTradeResult === 'function') {
				proposer.agent.onTradeResult(trade, !!accept);
			}
			if (!accept) {
				this.logEvent(`${target.name} rejects trade from ${proposer.name}`);
				// no mutation on rejection, so nothing for the deferred notify to wait for - fine to
				// notify right here.
				await this.notifyDecision(target, 'decideTradeResponse', tradeCtx, accept);
				return;
			}
			this.applyTradeEffects(proposer, target, trade);
			this.logEvent(`${target.name} accepts trade from ${proposer.name}`);
			// decideTradeResponse is in DEFERRED_NOTIFY_METHODS (see callAgent) so this fires AFTER
			// applyTradeEffects above, not before - same reasoning as decideBuyProperty. Money-bearing
			// trades used to notify before the transfer happened, leaving the UI's diff-based
			// flying-bill checkpoint with nothing to animate.
			await this.notifyDecision(target, 'decideTradeResponse', tradeCtx, accept);
		}

		/** Mutates proposer/target to reflect an already-accepted trade (properties, cash, jail
		 * cards changing hands). Factored out of handleTradeProposal so trade-lookahead rollouts
		 * (see strategy.js's tradeLookahead) can apply a hypothetical trade to a cloned game state
		 * without re-running the accept/reject decision or duplicating this mutation logic. */
		applyTradeEffects(proposer, target, trade) {
			for (const p of trade.offerProps) { this.properties[p].owner = target.id; proposer.properties.splice(proposer.properties.indexOf(p), 1); target.properties.push(p); }
			for (const p of trade.requestProps) { this.properties[p].owner = proposer.id; target.properties.splice(target.properties.indexOf(p), 1); proposer.properties.push(p); }
			proposer.money -= (trade.offerMoney || 0);
			target.money += (trade.offerMoney || 0);
			target.money -= (trade.requestMoney || 0);
			proposer.money += (trade.requestMoney || 0);
			if (trade.offerCards) { proposer.getOutOfJailFree -= trade.offerCards; target.getOutOfJailFree += trade.offerCards; }
			if (trade.requestCards) { target.getOutOfJailFree -= trade.requestCards; proposer.getOutOfJailFree += trade.requestCards; }
		}

		// decide* methods whose effect is NOT applied until after callAgent returns - the caller has
		// to decide first, then apply the mutation itself (build a house, pay bail, buy a property,
		// etc.), so notifying at decide-time here would fire the "X does Y" popup (and the UI's
		// diff-based flying-bill/property checkpoint it triggers on dismiss) before that mutation
		// actually happened, leaving the checkpoint with nothing to animate. These callers must call
		// notifyDecision() manually, right after applying the effect, instead of relying on
		// callAgent's automatic notify below. decideRoll is excluded too, but for an unrelated reason
		// (it carries no meaningful decision - bots always proceed immediately).
		static DEFERRED_NOTIFY_METHODS = new Set([
			'decideRoll', 'decideBuyProperty', 'decideJail', 'decideLiquidation', 'decideAction', 'decideTradeResponse'
		]);

		async callAgent(player, method, ctx) {
			if (!player.agent || typeof player.agent[method] !== 'function') return null;
			const result = player.agent[method](ctx);
			const resolved = (result && typeof result.then === 'function') ? await result : result;
			if (!MonopolyGame.DEFERRED_NOTIFY_METHODS.has(method)) {
				await this.notifyDecision(player, method, ctx, resolved);
			}
			return resolved;
		}

		/** Fires onAgentDecision, if the UI has assigned one - factored out of callAgent so methods
		 * in DEFERRED_NOTIFY_METHODS (see above) can call this manually once their effect has
		 * actually been applied, rather than at decide-time. */
		async notifyDecision(player, method, ctx, result) {
			if (typeof this.onAgentDecision === 'function') {
				await this.onAgentDecision(player, method, ctx, result);
			}
		}

		async runToCompletion() {
			let guard = 0;
			while (!this.gameOver && guard < this.maxTurns * this.players.length + 10) {
				guard++;
				await this.playTurn();
			}
			this.checkGameOver();
			return this.winner;
		}

		/** Like runToCompletion(), but stops after `n` individual player-turns (or sooner if the
		 * game ends) instead of playing to a winner. Used for short lookahead rollouts (e.g. "what
		 * does the board look like ~15 turns from now") where simulating a full game would be both
		 * unnecessary and far more expensive than the decision being evaluated warrants. */
		async runForTurns(n) {
			for (let i = 0; i < n && !this.gameOver; i++) {
				await this.playTurn();
			}
			this.checkGameOver();
		}

		/** Plain-data snapshot of all mutable game state (no agents/functions), suitable for
		 * cloning into a fresh MonopolyGame via applySnapshot() - used to run "what happens from
		 * here" Monte Carlo rollouts without touching the live game. */
		snapshotState() {
			return {
				players: this.players.map(p => ({
					money: p.money, pos: p.pos, properties: p.properties.slice(),
					inJail: p.inJail, jailTurns: p.jailTurns, getOutOfJailFree: p.getOutOfJailFree,
					bankrupt: p.bankrupt, consecutiveDoubles: p.consecutiveDoubles
				})),
				properties: Object.fromEntries(Object.entries(this.properties).map(([pos, prop]) => [pos, {
					owner: prop.owner, houses: prop.houses, mortgaged: prop.mortgaged
				}])),
				chestIdx: this.chestIdx,
				fateIdx: this.fateIdx,
				turnCount: this.turnCount,
				houseSupply: this.houseSupply,
				hotelSupply: this.hotelSupply,
				currentPlayerIdx: this.currentPlayerIdx
			};
		}

		/** Applies a snapshot from snapshotState() onto this (freshly-constructed, same player
		 * count/order) game instance. Card decks are re-shuffled fresh with this game's own RNG
		 * rather than replaying the exact deck order/contents, since only chestIdx/fateIdx (how
		 * far into a shuffled deck play has progressed) are captured, not the shuffle itself -
		 * close enough for a probability estimate, and keeps the snapshot small. */
		applySnapshot(snap) {
			snap.players.forEach((sp, i) => {
				const p = this.players[i];
				p.money = sp.money; p.pos = sp.pos; p.properties = sp.properties.slice();
				p.inJail = sp.inJail; p.jailTurns = sp.jailTurns; p.getOutOfJailFree = sp.getOutOfJailFree;
				p.bankrupt = sp.bankrupt; p.consecutiveDoubles = sp.consecutiveDoubles;
			});
			Object.entries(snap.properties).forEach(([pos, sprop]) => {
				const prop = this.properties[pos];
				prop.owner = sprop.owner; prop.houses = sprop.houses; prop.mortgaged = sprop.mortgaged;
			});
			this.chestIdx = snap.chestIdx % this.chestDeck.length;
			this.fateIdx = snap.fateIdx % this.fateDeck.length;
			this.turnCount = snap.turnCount;
			this.houseSupply = snap.houseSupply;
			this.hotelSupply = snap.hotelSupply;
			this.currentPlayerIdx = snap.currentPlayerIdx;
		}
	}

	const api = { MonopolyGame, mulberry32, shuffle };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	} else {
		root.MonopolyEngine = api;
	}
})(typeof window !== 'undefined' ? window : globalThis);
