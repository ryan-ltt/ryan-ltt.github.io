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
			if (typeof this.onRoll === 'function') this.onRoll(player, roll[0], roll[1]);
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
						await this.emitEvent('gotojail', { player, reason: 'doubles' });
						this.sendToJail(player);
						turnActive = false;
						break;
					}
				}

				await this.movePlayer(player, d1 + d2, true);
				if (player.bankrupt || this.gameOver) break;

				await this.resolveSpace(player, d1 + d2);
				if (player.bankrupt || this.gameOver) break;

				// post-landing actions: buy/build/trade offered every stop
				await this.postLandingActions(player);
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
			const decision = await this.callAgent(player, 'decideJail', { player, game: this });
			if (decision === 'card' && player.getOutOfJailFree > 0) {
				player.getOutOfJailFree--;
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} uses Get Out of Jail Free card`);
				return true;
			}
			if (decision === 'pay' && player.money >= Board.JAIL_FINE) {
				await this.payMoney(player, Board.JAIL_FINE, null);
				player.inJail = false;
				player.jailTurns = 0;
				this.logEvent(`${player.name} pays $${Board.JAIL_FINE} bail`);
				return true;
			}
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

		async receiveMoney(player, amount) {
			player.money += amount;
		}

		/** Attempts to deduct money; if insufficient, triggers liquidation/bankruptcy flow. creditor is a Player or null (bank). */
		async payMoney(player, amount, creditor) {
			if (player.money >= amount) {
				player.money -= amount;
				if (creditor) creditor.money += amount;
				else this.freeParkingPot += amount; // house rule OFF by default via config below; harmless if unused
				return true;
			}
			// need to raise cash
			await this.raiseCash(player, amount);
			if (player.money >= amount) {
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
				const action = await this.callAgent(player, 'decideLiquidation', { player, game: this, amountNeeded, sellable });
				if (!action) break;
				if (action.type === 'mortgage') {
					this.mortgageProperty(player, action.pos);
				} else if (action.type === 'sellHouse') {
					this.sellHouse(player, action.pos);
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
					await this.emitEvent('tax', { player, amount: space.amount, spaceName: space.name });
					await this.payMoney(player, space.amount, null);
					break;
				case 'chest': {
					const card = this.nextChestCard();
					await this.emitEvent('card', { player, card, deck: 'chest' });
					await this.drawCard(player, card, diceRoll);
					break;
				}
				case 'fate': {
					const card = this.nextFateCard();
					await this.emitEvent('card', { player, card, deck: 'fate' });
					await this.drawCard(player, card, diceRoll);
					break;
				}
				case 'gotojail':
					await this.emitEvent('gotojail', { player, reason: 'space' });
					this.sendToJail(player);
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
				case 'advanceToGo':
					player.pos = 0;
					await this.receiveMoney(player, Board.GO_SALARY);
					break;
				case 'advanceTo': {
					const passed = card.pos < player.pos;
					player.pos = card.pos;
					if (passed) await this.receiveMoney(player, Board.GO_SALARY);
					await this.resolveSpace(player, diceRoll);
					await this.postLandingActions(player);
					break;
				}
				case 'advanceToNearestRail':
				case 'advanceToNearestRail2': {
					const rails = Board.RAIL_POSITIONS;
					let target = rails.find(p => p > player.pos);
					if (target === undefined) { target = rails[0]; await this.receiveMoney(player, Board.GO_SALARY); }
					const targetSpace = this.getSpace(target);
					player.pos = target;
					const prop = this.properties[target];
					if (prop.owner === null) {
						await this.offerPurchaseOrAuction(player, target);
					} else if (prop.owner !== player.id && !prop.mortgaged) {
						const owner = this.players[prop.owner];
						if (owner.bankrupt) break;
						const mult = card.action === 'advanceToNearestRail' ? 2 : 1;
						const rent = this.calcRent(target, diceRoll) * mult;
						this.logEvent(`${player.name} owes $${rent} rent to ${owner.name} for ${targetSpace.name}${mult > 1 ? ' (double rent)' : ''}`);
						await this.emitEvent('rent', { player, owner, amount: rent, spaceName: targetSpace.name, pos: target });
						await this.payMoney(player, rent, owner);
					}
					break;
				}
				case 'advanceToNearestUtility': {
					const utils = Board.UTILITY_POSITIONS;
					let target = utils.find(p => p > player.pos);
					if (target === undefined) { target = utils[0]; await this.receiveMoney(player, Board.GO_SALARY); }
					const targetSpace = this.getSpace(target);
					player.pos = target;
					const prop = this.properties[target];
					if (prop.owner === null) {
						await this.offerPurchaseOrAuction(player, target);
					} else if (prop.owner !== player.id && !prop.mortgaged) {
						const owner = this.players[prop.owner];
						if (owner.bankrupt) break;
						const rent = 10 * diceRoll;
						this.logEvent(`${player.name} owes $${rent} rent to ${owner.name} for ${targetSpace.name} (10x dice)`);
						await this.emitEvent('rent', { player, owner, amount: rent, spaceName: targetSpace.name, pos: target });
						await this.payMoney(player, rent, owner);
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
				await this.emitEvent('rent', { player, owner, amount: rent, spaceName: space.name, pos: space.pos });
				await this.payMoney(player, rent, owner);
			}
		}

		async offerPurchaseOrAuction(player, pos) {
			const space = this.getSpace(pos);
			const wantsToBuy = player.money >= space.price
				? await this.callAgent(player, 'decideBuyProperty', { player, game: this, pos })
				: false;
			if (wantsToBuy) {
				player.money -= space.price;
				this.properties[pos].owner = player.id;
				player.properties.push(pos);
				this.logEvent(`${player.name} buys ${space.name} for $${space.price}`);
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
			while (active.size > 1 && roundsWithNoRaise < active.size) {
				const pid = bidders[idx % bidders.length];
				idx++;
				if (!active.has(pid)) continue;
				const player = this.players[pid];
				const bid = await this.callAgent(player, 'decideAuctionBid', { player, game: this, pos, highBid, highBidder });
				if (bid && bid > highBid && bid <= player.money) {
					highBid = bid;
					highBidder = pid;
					roundsWithNoRaise = 0;
				} else {
					active.delete(pid);
					roundsWithNoRaise++;
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

		async postLandingActions(player) {
			// Building, mortgage/unmortgage, and trade offers happen here (agent-driven, may loop)
			let guard = 0;
			while (guard < 30) {
				guard++;
				const action = await this.callAgent(player, 'decideAction', { player, game: this });
				if (!action || action.type === 'done') break;
				if (action.type === 'build') {
					if (!this.canBuildOn(player, action.pos)) continue;
					this.buildHouse(player, action.pos);
				} else if (action.type === 'sellHouse') {
					if (this.properties[action.pos].owner !== player.id) continue;
					this.sellHouse(player, action.pos);
				} else if (action.type === 'mortgage') {
					this.mortgageProperty(player, action.pos);
				} else if (action.type === 'unmortgage') {
					this.unmortgageProperty(player, action.pos);
				} else if (action.type === 'proposeTrade') {
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
			const accept = await this.callAgent(target, 'decideTradeResponse', { player: target, game: this, trade, proposer });
			if (!accept) {
				this.logEvent(`${target.name} rejects trade from ${proposer.name}`);
				return;
			}
			this.applyTradeEffects(proposer, target, trade);
			this.logEvent(`${target.name} accepts trade from ${proposer.name}`);
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

		async callAgent(player, method, ctx) {
			if (!player.agent || typeof player.agent[method] !== 'function') return null;
			const result = player.agent[method](ctx);
			const resolved = (result && typeof result.then === 'function') ? await result : result;
			// lets the UI show a transient "what did the AI just decide" popup; decideRoll is
			// excluded since it carries no meaningful decision (bots always proceed immediately).
			if (method !== 'decideRoll' && typeof this.onAgentDecision === 'function') {
				await this.onAgentDecision(player, method, ctx, resolved);
			}
			return resolved;
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
