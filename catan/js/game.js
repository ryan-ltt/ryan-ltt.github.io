/* Rules engine. Pure state + methods, no DOM. Every action returns
 * { ok: true } or { ok: false, error: "..." } so the UI can report refusals
 * without knowing the rules itself. */
window.CatanGame = (function () {
	'use strict';

	const H = window.CatanHex;
	const M = window.CatanMap;

	const COSTS = {
		road: { brick: 1, lumber: 1 },
		settlement: { brick: 1, lumber: 1, wool: 1, grain: 1 },
		city: { grain: 2, ore: 3 },
		dev: { wool: 1, grain: 1, ore: 1 }
	};

	const LIMITS = { road: 15, settlement: 5, city: 4 };

	const DEV_LABELS = {
		knight: 'knight',
		victoryPoint: 'victory point',
		roadBuilding: 'road building',
		yearOfPlenty: 'year of plenty',
		monopoly: 'monopoly'
	};

	const PLAYER_COLORS = [
		{ id: 'red', fill: '#d64545', ink: '#ffffff' },
		{ id: 'blue', fill: '#3a6ea5', ink: '#ffffff' },
		{ id: 'orange', fill: '#e08e45', ink: '#1a1a1a' },
		{ id: 'white', fill: '#f7f7f2', ink: '#1a1a1a' },
		{ id: 'green', fill: '#4a7c59', ink: '#ffffff' },
		{ id: 'purple', fill: '#7a5c9e', ink: '#ffffff' }
	];

	function emptyResources() {
		return { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
	}

	function countCards(res) {
		return M.RESOURCES.reduce(function (sum, key) {
			return sum + (res[key] || 0);
		}, 0);
	}

	function canAfford(res, cost) {
		return Object.keys(cost).every(function (key) {
			return (res[key] || 0) >= cost[key];
		});
	}

	function costLabel(cost) {
		return Object.keys(cost).map(function (key) {
			return cost[key] + ' ' + key;
		}).join(' + ');
	}

	function Game(map, playerConfigs, options) {
		const opts = options || {};
		this.map = map;
		this.board = M.buildBoard(map);
		this.targetVP = opts.targetVP || (map.hexes.length > 24 ? 12 : 10);
		this.buildings = {};   // vertexKey -> { owner, type }
		this.roads = {};       // edgeKey   -> owner
		this.robber = this.board.robber;
		this.log = [];
		this.turn = 0;
		this.dice = null;
		this.winner = null;
		this.offer = null;
		this.pendingDiscards = {};
		this.freeRoads = 0;
		this.playedDevThisTurn = false;
		this.preRobberPhase = 'main';
		this.awaitingSteal = null;

		const bankSize = map.hexes.length > 24 ? 24 : 19;
		this.bank = {};
		M.RESOURCES.forEach(function (res) {
			this.bank[res] = bankSize;
		}, this);

		this.players = playerConfigs.map(function (cfg, i) {
			const color = PLAYER_COLORS[i % PLAYER_COLORS.length];
			return {
				id: i,
				name: cfg.name || 'player ' + (i + 1),
				isBot: !!cfg.isBot,
				color: color.id,
				fill: color.fill,
				ink: color.ink,
				resources: emptyResources(),
				dev: { knight: 0, victoryPoint: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
				devPending: { knight: 0, victoryPoint: 0, roadBuilding: 0, yearOfPlenty: 0, monopoly: 0 },
				knightsPlayed: 0,
				roads: {},
				settlements: {},
				cities: {},
				ports: {},
				longestRoad: 0
			};
		});

		this.devDeck = M.shuffle(buildDevDeck(map.hexes.length));
		this.largestArmy = null;
		this.longestRoadHolder = null;

		// Setup: snake order, one settlement + one road each pass.
		this.setupOrder = [];
		const ids = this.players.map(function (p) {
			return p.id;
		});
		this.setupOrder = ids.concat(ids.slice().reverse());
		this.setupIndex = 0;
		this.setupStep = 'settlement';
		this.lastSetupVertex = null;
		this.phase = 'setup';

		this.note('map "' + map.name + '" - first to ' + this.targetVP + ' points wins');
		this.note(this.current().name + ' places the first settlement');
	}

	function buildDevDeck(hexCount) {
		const big = hexCount > 24;
		const counts = big
			? { knight: 20, victoryPoint: 5, roadBuilding: 3, yearOfPlenty: 3, monopoly: 3 }
			: { knight: 14, victoryPoint: 5, roadBuilding: 2, yearOfPlenty: 2, monopoly: 2 };
		const deck = [];
		Object.keys(counts).forEach(function (key) {
			for (let i = 0; i < counts[key]; i++) deck.push(key);
		});
		return deck;
	}

	Game.prototype.note = function (text, kind) {
		this.log.push({ text: text, kind: kind || 'info', turn: this.turn });
		if (this.log.length > 300) this.log.shift();
	};

	Game.prototype.current = function () {
		if (this.phase === 'setup') return this.players[this.setupOrder[this.setupIndex]];
		return this.players[this.turn % this.players.length];
	};

	Game.prototype.player = function (id) {
		return this.players[id];
	};

	/* ------------------------------------------------------------ board queries */

	Game.prototype.buildingAt = function (vertexKey) {
		return this.buildings[vertexKey] || null;
	};

	Game.prototype.vertexIsFree = function (vertexKey) {
		if (this.buildings[vertexKey]) return false;
		const vertex = this.board.vertices[vertexKey];
		if (!vertex) return false;
		return vertex.adjacent.every(function (other) {
			return !this.buildings[other];
		}, this);
	};

	/* A road may extend from your own building, or from your own road as long as
	 * the shared corner is not blocked by an opponent's settlement or city. */
	Game.prototype.edgeIsConnected = function (edgeKey, playerId) {
		const edge = this.board.edges[edgeKey];
		if (!edge) return false;
		return edge.ends.some(function (vk) {
			const building = this.buildings[vk];
			if (building) return building.owner === playerId;
			const vertex = this.board.vertices[vk];
			if (!vertex) return false;
			return vertex.edges.some(function (ek) {
				return this.roads[ek] === playerId;
			}, this);
		}, this);
	};

	Game.prototype.legalRoads = function (playerId) {
		return Object.keys(this.board.edges).filter(function (ek) {
			return this.roads[ek] === undefined && this.edgeIsConnected(ek, playerId);
		}, this);
	};

	Game.prototype.legalSettlements = function (playerId) {
		return Object.keys(this.board.vertices).filter(function (vk) {
			if (!this.vertexIsFree(vk)) return false;
			return this.board.vertices[vk].edges.some(function (ek) {
				return this.roads[ek] === playerId;
			}, this);
		}, this);
	};

	Game.prototype.legalCities = function (playerId) {
		return Object.keys(this.buildings).filter(function (vk) {
			const b = this.buildings[vk];
			return b.owner === playerId && b.type === 'settlement';
		}, this);
	};

	Game.prototype.legalSetupSettlements = function () {
		return Object.keys(this.board.vertices).filter(function (vk) {
			return this.vertexIsFree(vk);
		}, this);
	};

	Game.prototype.legalSetupRoads = function () {
		const vk = this.lastSetupVertex;
		if (!vk || !this.board.vertices[vk]) return [];
		return this.board.vertices[vk].edges.filter(function (ek) {
			return this.roads[ek] === undefined;
		}, this);
	};

	/* --------------------------------------------------------------- setup phase */

	Game.prototype.placeSetupSettlement = function (vertexKey) {
		if (this.phase !== 'setup' || this.setupStep !== 'settlement') return fail('not placing a settlement right now');
		if (!this.vertexIsFree(vertexKey)) return fail('too close to another settlement');

		const player = this.current();
		this.buildings[vertexKey] = { owner: player.id, type: 'settlement' };
		player.settlements[vertexKey] = true;
		this.grantPort(player, vertexKey);
		this.lastSetupVertex = vertexKey;
		this.setupStep = 'road';

		// Second time round the table you collect from the hexes you just settled.
		if (this.setupIndex >= this.players.length) {
			const gained = [];
			this.board.vertices[vertexKey].hexes.forEach(function (hk) {
				const hex = this.board.hexes[hk];
				if (!hex.resource) return;
				this.give(player, hex.resource, 1);
				gained.push(hex.resource);
			}, this);
			if (gained.length) this.note(player.name + ' collects ' + gained.join(', '), 'gain');
		}
		this.note(player.name + ' settles', 'build');
		return ok();
	};

	Game.prototype.placeSetupRoad = function (edgeKey) {
		if (this.phase !== 'setup' || this.setupStep !== 'road') return fail('not placing a road right now');
		if (this.legalSetupRoads().indexOf(edgeKey) < 0) return fail('the road must touch the settlement you just placed');

		const player = this.current();
		this.roads[edgeKey] = player.id;
		player.roads[edgeKey] = true;
		this.note(player.name + ' builds a road', 'build');

		this.setupIndex++;
		this.setupStep = 'settlement';
		this.lastSetupVertex = null;

		if (this.setupIndex >= this.setupOrder.length) {
			this.phase = 'roll';
			this.turn = 0;
			this.updateLongestRoad();
			this.note('setup complete - ' + this.current().name + ' rolls first', 'phase');
		} else {
			this.note(this.current().name + ' places a settlement');
		}
		return ok();
	};

	/* --------------------------------------------------------------------- dice */

	Game.prototype.rollDice = function () {
		if (this.phase !== 'roll') return fail('you have already rolled this turn');
		const a = 1 + Math.floor(Math.random() * 6);
		const b = 1 + Math.floor(Math.random() * 6);
		this.dice = [a, b];
		const total = a + b;
		this.note(this.current().name + ' rolls ' + a + ' + ' + b + ' = ' + total, 'roll');

		if (total === 7) {
			// The roll is spent either way, so the robber hands back to the build
			// phase - only a knight played before rolling returns to 'roll'.
			this.phase = 'main';
			this.startRobber('a 7 is rolled');
			return ok({ roll: total });
		}

		this.distribute(total);
		this.phase = 'main';
		return ok({ roll: total });
	};

	Game.prototype.distribute = function (roll) {
		const owed = {};   // resource -> [{ player, amount }]
		Object.keys(this.board.hexes).forEach(function (hk) {
			const hex = this.board.hexes[hk];
			if (hex.number !== roll || !hex.resource || hk === this.robber) return;
			hex.corners.forEach(function (vk) {
				const building = this.buildings[vk];
				if (!building) return;
				const amount = building.type === 'city' ? 2 : 1;
				if (!owed[hex.resource]) owed[hex.resource] = [];
				owed[hex.resource].push({ id: building.owner, amount: amount });
			}, this);
		}, this);

		const summary = [];
		Object.keys(owed).forEach(function (res) {
			const claims = owed[res];
			const perPlayer = {};
			claims.forEach(function (c) {
				perPlayer[c.id] = (perPlayer[c.id] || 0) + c.amount;
			});
			const ids = Object.keys(perPlayer);
			const total = ids.reduce(function (sum, id) {
				return sum + perPlayer[id];
			}, 0);

			// Official shortage rule: if the bank cannot pay everyone, only a lone
			// claimant is paid (as much as the bank holds); otherwise nobody is.
			if (total > this.bank[res]) {
				if (ids.length === 1) {
					const only = this.players[ids[0]];
					const amount = this.bank[res];
					if (amount > 0) {
						this.give(only, res, amount);
						summary.push(only.name + ' +' + amount + ' ' + res + ' (bank nearly out)');
					}
				} else {
					this.note('the bank runs out of ' + res + ' - nobody collects it', 'warn');
				}
				return;
			}

			ids.forEach(function (id) {
				const player = this.players[id];
				this.give(player, res, perPlayer[id]);
				summary.push(player.name + ' +' + perPlayer[id] + ' ' + res);
			}, this);
		}, this);

		if (summary.length) this.note(summary.join(', '), 'gain');
		else this.note('nobody collects anything', 'dim');
	};

	Game.prototype.give = function (player, resource, amount) {
		const paid = Math.min(amount, this.bank[resource]);
		player.resources[resource] += paid;
		this.bank[resource] -= paid;
		return paid;
	};

	Game.prototype.take = function (player, resource, amount) {
		player.resources[resource] -= amount;
		this.bank[resource] += amount;
	};

	Game.prototype.pay = function (player, cost) {
		Object.keys(cost).forEach(function (res) {
			this.take(player, res, cost[res]);
		}, this);
	};

	/* ------------------------------------------------------------------- robber */

	Game.prototype.startRobber = function (reason) {
		this.preRobberPhase = this.phase === 'roll' ? 'roll' : 'main';
		this.pendingDiscards = {};
		this.players.forEach(function (p) {
			const held = countCards(p.resources);
			if (held > 7) this.pendingDiscards[p.id] = Math.floor(held / 2);
		}, this);

		if (Object.keys(this.pendingDiscards).length) {
			this.phase = 'discard';
			this.note(reason + ' - players holding more than 7 cards must discard half', 'warn');
		} else {
			this.phase = 'robber';
			this.note(reason + ' - ' + this.current().name + ' moves the robber', 'warn');
		}
	};

	Game.prototype.discard = function (playerId, picks) {
		if (this.phase !== 'discard') return fail('no discards are pending');
		const needed = this.pendingDiscards[playerId];
		if (!needed) return fail('that player does not need to discard');
		const player = this.players[playerId];
		const total = countCards(picks);
		if (total !== needed) return fail('discard exactly ' + needed + ' card' + (needed === 1 ? '' : 's'));
		const enough = M.RESOURCES.every(function (res) {
			return (picks[res] || 0) <= player.resources[res];
		});
		if (!enough) return fail('you cannot discard cards you do not hold');

		M.RESOURCES.forEach(function (res) {
			if (picks[res]) this.take(player, res, picks[res]);
		}, this);
		delete this.pendingDiscards[playerId];
		this.note(player.name + ' discards ' + total + ' card' + (total === 1 ? '' : 's'), 'dim');

		if (!Object.keys(this.pendingDiscards).length) {
			this.phase = 'robber';
			this.note(this.current().name + ' moves the robber', 'warn');
		}
		return ok();
	};

	Game.prototype.autoDiscard = function (playerId) {
		const player = this.players[playerId];
		const needed = this.pendingDiscards[playerId] || 0;
		const picks = emptyResources();
		for (let i = 0; i < needed; i++) {
			// Shed whatever is most plentiful first.
			let best = null;
			M.RESOURCES.forEach(function (res) {
				const left = player.resources[res] - picks[res];
				if (left > 0 && (best === null || left > player.resources[best] - picks[best])) best = res;
			});
			if (best === null) break;
			picks[best]++;
		}
		return this.discard(playerId, picks);
	};

	Game.prototype.robberCandidates = function (hexKey) {
		const hex = this.board.hexes[hexKey];
		if (!hex) return [];
		const me = this.current().id;
		const found = {};
		hex.corners.forEach(function (vk) {
			const b = this.buildings[vk];
			if (!b || b.owner === me) return;
			if (countCards(this.players[b.owner].resources) > 0) found[b.owner] = true;
		}, this);
		return Object.keys(found).map(Number);
	};

	Game.prototype.moveRobber = function (hexKey, victimId) {
		if (this.phase !== 'robber') return fail('the robber is not being moved right now');
		if (!this.board.hexes[hexKey]) return fail('that is not a hex');
		if (hexKey === this.robber) return fail('the robber must move to a different hex');

		this.robber = hexKey;
		const player = this.current();
		this.note(player.name + ' moves the robber', 'warn');

		const candidates = this.robberCandidates(hexKey);
		if (candidates.length) {
			let target = victimId;
			if (target === undefined || target === null || candidates.indexOf(target) < 0) {
				if (candidates.length > 1) {
					this.awaitingSteal = candidates;
					return ok({ chooseVictim: candidates });
				}
				target = candidates[0];
			}
			this.steal(player, this.players[target]);
		}

		this.awaitingSteal = null;
		this.phase = this.preRobberPhase;
		return ok();
	};

	Game.prototype.chooseVictim = function (victimId) {
		if (!this.awaitingSteal || this.awaitingSteal.indexOf(victimId) < 0) return fail('that player cannot be robbed');
		this.steal(this.current(), this.players[victimId]);
		this.awaitingSteal = null;
		this.phase = this.preRobberPhase;
		return ok();
	};

	Game.prototype.steal = function (thief, victim) {
		const hand = [];
		M.RESOURCES.forEach(function (res) {
			for (let i = 0; i < victim.resources[res]; i++) hand.push(res);
		});
		if (!hand.length) {
			this.note(victim.name + ' has nothing to steal', 'dim');
			return;
		}
		const picked = hand[Math.floor(Math.random() * hand.length)];
		victim.resources[picked]--;
		thief.resources[picked]++;
		this.note(thief.name + ' steals a card from ' + victim.name, 'warn');
	};

	/* ----------------------------------------------------------------- building */

	Game.prototype.buildRoad = function (edgeKey) {
		if (this.phase !== 'main') return fail('you can only build after rolling');
		const player = this.current();
		if (Object.keys(player.roads).length >= LIMITS.road) return fail('you have used all 15 roads');
		if (this.roads[edgeKey] !== undefined) return fail('there is already a road there');
		if (!this.edgeIsConnected(edgeKey, player.id)) return fail('roads must connect to your own network');

		const free = this.freeRoads > 0;
		if (!free && !canAfford(player.resources, COSTS.road)) return fail('a road costs ' + costLabel(COSTS.road));
		if (free) this.freeRoads--;
		else this.pay(player, COSTS.road);

		this.roads[edgeKey] = player.id;
		player.roads[edgeKey] = true;
		this.note(player.name + ' builds a road' + (free ? ' (free)' : ''), 'build');
		this.updateLongestRoad();
		this.checkWin();
		return ok();
	};

	Game.prototype.buildSettlement = function (vertexKey) {
		if (this.phase !== 'main') return fail('you can only build after rolling');
		const player = this.current();
		if (Object.keys(player.settlements).length >= LIMITS.settlement) return fail('all 5 settlements are on the board - upgrade one to a city first');
		if (!this.vertexIsFree(vertexKey)) return fail('too close to another settlement');
		if (this.legalSettlements(player.id).indexOf(vertexKey) < 0) return fail('settlements must sit on your own road network');
		if (!canAfford(player.resources, COSTS.settlement)) return fail('a settlement costs ' + costLabel(COSTS.settlement));

		this.pay(player, COSTS.settlement);
		this.buildings[vertexKey] = { owner: player.id, type: 'settlement' };
		player.settlements[vertexKey] = true;
		this.grantPort(player, vertexKey);
		this.note(player.name + ' builds a settlement', 'build');
		this.updateLongestRoad();
		this.checkWin();
		return ok();
	};

	Game.prototype.buildCity = function (vertexKey) {
		if (this.phase !== 'main') return fail('you can only build after rolling');
		const player = this.current();
		const building = this.buildings[vertexKey];
		if (!building || building.owner !== player.id || building.type !== 'settlement') {
			return fail('cities are upgrades - pick one of your own settlements');
		}
		if (Object.keys(player.cities).length >= LIMITS.city) return fail('you have used all 4 cities');
		if (!canAfford(player.resources, COSTS.city)) return fail('a city costs ' + costLabel(COSTS.city));

		this.pay(player, COSTS.city);
		building.type = 'city';
		delete player.settlements[vertexKey];
		player.cities[vertexKey] = true;
		this.note(player.name + ' upgrades to a city', 'build');
		this.checkWin();
		return ok();
	};

	Game.prototype.grantPort = function (player, vertexKey) {
		const vertex = this.board.vertices[vertexKey];
		if (vertex && vertex.port) player.ports[vertex.port] = true;
	};

	/* -------------------------------------------------------------- development */

	Game.prototype.buyDev = function () {
		if (this.phase !== 'main') return fail('you can only buy after rolling');
		const player = this.current();
		if (!this.devDeck.length) return fail('the development deck is empty');
		if (!canAfford(player.resources, COSTS.dev)) return fail('a development card costs ' + costLabel(COSTS.dev));

		this.pay(player, COSTS.dev);
		const card = this.devDeck.pop();
		if (card === 'victoryPoint') player.dev.victoryPoint++;
		else player.devPending[card]++;
		this.note(player.name + ' buys a development card', 'build');
		this.checkWin();
		return ok({ card: card });
	};

	Game.prototype.playableDev = function (player) {
		const out = [];
		Object.keys(player.dev).forEach(function (key) {
			if (key !== 'victoryPoint' && player.dev[key] > 0) out.push(key);
		});
		return out;
	};

	Game.prototype.playDev = function (type, args) {
		const player = this.current();
		if (this.phase !== 'main' && !(this.phase === 'roll' && type === 'knight')) {
			return fail('you cannot play that card right now');
		}
		if (this.playedDevThisTurn) return fail('only one development card per turn');
		if (!player.dev[type]) return fail('you do not have that card ready to play');

		const payload = args || {};
		if (type === 'knight') {
			player.dev.knight--;
			player.knightsPlayed++;
			this.playedDevThisTurn = true;
			this.note(player.name + ' plays a knight', 'card');
			this.updateLargestArmy();
			this.startRobber(player.name + ' plays a knight');
			this.checkWin();
			return ok();
		}
		if (type === 'roadBuilding') {
			player.dev.roadBuilding--;
			this.playedDevThisTurn = true;
			this.freeRoads = 2;
			this.note(player.name + ' plays road building - two free roads', 'card');
			return ok();
		}
		if (type === 'yearOfPlenty') {
			const picks = payload.resources || [];
			if (picks.length !== 2) return fail('pick two resources');
			const bad = picks.filter(function (res) {
				return M.RESOURCES.indexOf(res) < 0;
			});
			if (bad.length) return fail('pick two resources');
			const need = {};
			picks.forEach(function (res) {
				need[res] = (need[res] || 0) + 1;
			});
			const short = Object.keys(need).filter(function (res) {
				return this.bank[res] < need[res];
			}, this);
			if (short.length) return fail('the bank is out of ' + short.join(' and '));

			player.dev.yearOfPlenty--;
			this.playedDevThisTurn = true;
			picks.forEach(function (res) {
				this.give(player, res, 1);
			}, this);
			this.note(player.name + ' plays year of plenty and takes ' + picks.join(' + '), 'card');
			return ok();
		}
		if (type === 'monopoly') {
			const res = payload.resource;
			if (M.RESOURCES.indexOf(res) < 0) return fail('pick a resource to monopolise');
			player.dev.monopoly--;
			this.playedDevThisTurn = true;
			let taken = 0;
			this.players.forEach(function (other) {
				if (other.id === player.id) return;
				taken += other.resources[res];
				other.resources[res] = 0;
			});
			player.resources[res] += taken;
			this.note(player.name + ' plays monopoly on ' + res + ' and collects ' + taken, 'card');
			return ok();
		}
		return fail('unknown card');
	};

	/* -------------------------------------------------------------------- trade */

	Game.prototype.tradeRatio = function (player, resource) {
		if (player.ports[resource]) return 2;
		if (player.ports['3:1']) return 3;
		return 4;
	};

	Game.prototype.tradeBank = function (giveRes, getRes) {
		if (this.phase !== 'main') return fail('you can only trade after rolling');
		const player = this.current();
		if (giveRes === getRes) return fail('pick two different resources');
		if (M.RESOURCES.indexOf(giveRes) < 0 || M.RESOURCES.indexOf(getRes) < 0) return fail('pick two resources');
		const ratio = this.tradeRatio(player, giveRes);
		if (player.resources[giveRes] < ratio) return fail('you need ' + ratio + ' ' + giveRes + ' for that trade');
		if (this.bank[getRes] < 1) return fail('the bank is out of ' + getRes);

		this.take(player, giveRes, ratio);
		this.give(player, getRes, 1);
		this.note(player.name + ' trades ' + ratio + ' ' + giveRes + ' for 1 ' + getRes, 'trade');
		return ok();
	};

	Game.prototype.openOffer = function (give, want) {
		if (this.phase !== 'main') return fail('you can only trade after rolling');
		const player = this.current();
		if (!countCards(give) || !countCards(want)) return fail('offer at least one card and ask for at least one');
		const short = M.RESOURCES.filter(function (res) {
			return (give[res] || 0) > player.resources[res];
		});
		if (short.length) return fail('you do not hold that many ' + short.join(' or '));

		this.offer = { from: player.id, give: give, want: want, responses: {} };
		this.players.forEach(function (other) {
			if (other.id === player.id) return;
			this.offer.responses[other.id] = 'pending';
		}, this);
		this.note(player.name + ' offers ' + describe(give) + ' for ' + describe(want), 'trade');
		return ok();
	};

	Game.prototype.respondToOffer = function (playerId, accepted) {
		if (!this.offer || this.offer.responses[playerId] === undefined) return fail('there is no offer for you');
		const canPay = M.RESOURCES.every(function (res) {
			return this.players[playerId].resources[res] >= (this.offer.want[res] || 0);
		}, this);
		this.offer.responses[playerId] = accepted && canPay ? 'accept' : 'decline';
		return ok();
	};

	Game.prototype.acceptTradeWith = function (playerId) {
		if (!this.offer) return fail('there is no open offer');
		if (this.offer.from !== this.current().id) return fail('it is not your offer');
		if (this.offer.responses[playerId] !== 'accept') return fail('that player has not accepted');

		const from = this.players[this.offer.from];
		const to = this.players[playerId];
		const give = this.offer.give;
		const want = this.offer.want;
		const possible = M.RESOURCES.every(function (res) {
			return from.resources[res] >= (give[res] || 0) && to.resources[res] >= (want[res] || 0);
		});
		if (!possible) {
			this.offer = null;
			return fail('the trade is no longer possible');
		}

		M.RESOURCES.forEach(function (res) {
			from.resources[res] -= give[res] || 0;
			to.resources[res] += give[res] || 0;
			to.resources[res] -= want[res] || 0;
			from.resources[res] += want[res] || 0;
		});
		this.note(from.name + ' trades ' + describe(give) + ' to ' + to.name + ' for ' + describe(want), 'trade');
		this.offer = null;
		return ok();
	};

	Game.prototype.cancelOffer = function () {
		this.offer = null;
		return ok();
	};

	function describe(res) {
		const parts = M.RESOURCES.filter(function (key) {
			return res[key];
		}).map(function (key) {
			return res[key] + ' ' + key;
		});
		return parts.length ? parts.join(' + ') : 'nothing';
	}

	/* ------------------------------------------------------- awards and scoring */

	Game.prototype.roadLengthFor = function (playerId) {
		const own = Object.keys(this.roads).filter(function (ek) {
			return this.roads[ek] === playerId;
		}, this);
		if (!own.length) return 0;

		const adjacency = {};
		own.forEach(function (ek) {
			const ends = H.edgeEnds(ek);
			ends.forEach(function (vk, i) {
				if (!adjacency[vk]) adjacency[vk] = [];
				adjacency[vk].push({ edge: ek, to: ends[1 - i] });
			});
		});

		const blocked = function (vk) {
			const b = this.buildings[vk];
			return !!b && b.owner !== playerId;
		}.bind(this);

		const used = {};
		let best = 0;

		const walk = function (vk, length) {
			if (length > best) best = length;
			// An opponent's building cuts a road, but only when you arrive at it -
			// starting there and walking away is fine.
			if (length > 0 && blocked(vk)) return;
			(adjacency[vk] || []).forEach(function (link) {
				if (used[link.edge]) return;
				used[link.edge] = true;
				walk(link.to, length + 1);
				delete used[link.edge];
			});
		};

		Object.keys(adjacency).forEach(function (vk) {
			walk(vk, 0);
		});
		return best;
	};

	Game.prototype.updateLongestRoad = function () {
		this.players.forEach(function (p) {
			p.longestRoad = this.roadLengthFor(p.id);
		}, this);

		const holder = this.longestRoadHolder;
		let best = 0;
		this.players.forEach(function (p) {
			if (p.longestRoad > best) best = p.longestRoad;
		});
		const tied = this.players.filter(function (p) {
			return p.longestRoad === best;
		});

		// Five roads to claim it. The holder keeps it on a tie; if a road is broken
		// and several challengers tie for the new best, nobody holds it.
		let leader;
		if (best < 5) leader = null;
		else if (holder !== null && this.players[holder].longestRoad === best) leader = holder;
		else if (tied.length === 1) leader = tied[0].id;
		else leader = null;

		if (leader !== holder) {
			this.longestRoadHolder = leader;
			if (leader !== null) this.note(this.players[leader].name + ' takes longest road (' + this.players[leader].longestRoad + ')', 'award');
			else this.note('longest road is up for grabs', 'award');
		}
	};

	Game.prototype.updateLargestArmy = function () {
		const holder = this.largestArmy;
		let leader = holder;
		let best = holder === null ? 2 : this.players[holder].knightsPlayed;
		this.players.forEach(function (p) {
			if (p.knightsPlayed >= 3 && p.knightsPlayed > best) {
				leader = p.id;
				best = p.knightsPlayed;
			}
		});
		if (leader !== holder) {
			this.largestArmy = leader;
			this.note(this.players[leader].name + ' takes largest army (' + best + ' knights)', 'award');
		}
	};

	Game.prototype.publicPoints = function (player) {
		let vp = Object.keys(player.settlements).length + Object.keys(player.cities).length * 2;
		if (this.largestArmy === player.id) vp += 2;
		if (this.longestRoadHolder === player.id) vp += 2;
		return vp;
	};

	Game.prototype.points = function (player) {
		return this.publicPoints(player) + player.dev.victoryPoint;
	};

	Game.prototype.checkWin = function () {
		const player = this.current();
		if (this.points(player) >= this.targetVP) {
			this.winner = player.id;
			this.phase = 'over';
			this.note(player.name + ' wins with ' + this.points(player) + ' points', 'award');
		}
	};

	/* --------------------------------------------------------------------- turn */

	Game.prototype.endTurn = function () {
		if (this.phase === 'setup') return fail('finish setting up first');
		if (this.phase === 'roll') return fail('roll the dice first');
		if (this.phase !== 'main') return fail('finish the current action first');

		const player = this.current();
		Object.keys(player.devPending).forEach(function (key) {
			player.dev[key] += player.devPending[key];
			player.devPending[key] = 0;
		});

		this.offer = null;
		this.freeRoads = 0;
		this.playedDevThisTurn = false;
		this.dice = null;
		this.turn++;
		this.phase = 'roll';
		this.note('--- ' + this.current().name + ' to play', 'phase');
		return ok();
	};

	function ok(extra) {
		return Object.assign({ ok: true }, extra || {});
	}

	function fail(error) {
		return { ok: false, error: error };
	}

	return {
		Game: Game,
		COSTS: COSTS,
		LIMITS: LIMITS,
		DEV_LABELS: DEV_LABELS,
		PLAYER_COLORS: PLAYER_COLORS,
		emptyResources: emptyResources,
		countCards: countCards,
		canAfford: canAfford,
		costLabel: costLabel,
		describe: describe
	};
})();
