/* Bot opponents. Deliberately simple and readable: score every spot by the
 * production it touches, then work down a fixed priority list each turn.
 *
 * `step` performs at most one action so the UI can play a bot turn out over a
 * few hundred milliseconds instead of in a single frozen frame. */
window.CatanAI = (function () {
	'use strict';

	const H = window.CatanHex;
	const M = window.CatanMap;
	const G = window.CatanGame;

	/* Rough long-run value of a resource, used for trades and stockpiling. */
	const WEIGHT = { brick: 1.1, lumber: 1.1, wool: 0.9, grain: 1.05, ore: 1.0 };

	function vertexScore(game, vertexKey, playerId) {
		const vertex = game.board.vertices[vertexKey];
		if (!vertex) return -1;
		let score = 0;
		const seen = {};
		vertex.hexes.forEach(function (hk) {
			const hex = game.board.hexes[hk];
			if (!hex.resource) return;
			const pips = M.pips(hex.number);
			score += pips * (WEIGHT[hex.resource] || 1);
			seen[hex.resource] = (seen[hex.resource] || 0) + pips;
		});
		// Spread beats concentration: reward touching resources you do not have yet.
		const player = playerId === undefined ? null : game.players[playerId];
		Object.keys(seen).forEach(function (res) {
			if (!player || !production(game, player)[res]) score += 2.5;
		});
		if (Object.keys(seen).length >= 3) score += 2;
		if (vertex.port) score += vertex.port === '3:1' ? 1.5 : 2.5;
		return score;
	}

	function production(game, player) {
		const out = { brick: 0, lumber: 0, wool: 0, grain: 0, ore: 0 };
		Object.keys(player.settlements).concat(Object.keys(player.cities)).forEach(function (vk) {
			const weight = player.cities[vk] ? 2 : 1;
			const vertex = game.board.vertices[vk];
			if (!vertex) return;
			vertex.hexes.forEach(function (hk) {
				const hex = game.board.hexes[hk];
				if (hex.resource) out[hex.resource] += M.pips(hex.number) * weight;
			});
		});
		return out;
	}

	function best(list, scorer) {
		let bestItem = null;
		let bestScore = -Infinity;
		list.forEach(function (item) {
			const score = scorer(item);
			if (score > bestScore) {
				bestScore = score;
				bestItem = item;
			}
		});
		return bestItem;
	}

	/* ---------------------------------------------------------------- setup phase */

	function setupSettlement(game) {
		const player = game.current();
		return best(game.legalSetupSettlements(), function (vk) {
			return vertexScore(game, vk, player.id);
		});
	}

	function setupRoad(game) {
		const player = game.current();
		const options = game.legalSetupRoads();
		return best(options, function (ek) {
			const ends = H.edgeEnds(ek);
			const far = ends[0] === game.lastSetupVertex ? ends[1] : ends[0];
			const vertex = game.board.vertices[far];
			if (!vertex) return -1;
			// Point the road at the best spot two steps away that is still open.
			let reach = 0;
			vertex.adjacent.forEach(function (next) {
				if (!game.vertexIsFree(next)) return;
				reach = Math.max(reach, vertexScore(game, next, player.id));
			});
			return reach + vertexScore(game, far, player.id) * 0.2;
		});
	}

	/* -------------------------------------------------------------------- robber */

	function robberChoice(game) {
		const me = game.current().id;
		const leaderPoints = Math.max.apply(null, game.players.map(function (p) {
			return game.publicPoints(p);
		}));

		const target = best(Object.keys(game.board.hexes), function (hk) {
			if (hk === game.robber) return -Infinity;
			const hex = game.board.hexes[hk];
			let score = 0;
			let touchesMe = false;
			hex.corners.forEach(function (vk) {
				const building = game.buildings[vk];
				if (!building) return;
				if (building.owner === me) {
					touchesMe = true;
					return;
				}
				const victim = game.players[building.owner];
				const weight = building.type === 'city' ? 2 : 1;
				score += M.pips(hex.number) * weight;
				score += G.countCards(victim.resources) * 0.4;
				if (game.publicPoints(victim) >= leaderPoints) score += 6;
			});
			if (touchesMe) score -= 50;
			return score;
		});

		const candidates = target ? candidatesFor(game, target, me) : [];
		return { hex: target, victim: candidates.length ? candidates[0] : null };
	}

	function candidatesFor(game, hexKey, me) {
		const hex = game.board.hexes[hexKey];
		const found = {};
		hex.corners.forEach(function (vk) {
			const b = game.buildings[vk];
			if (!b || b.owner === me) return;
			if (G.countCards(game.players[b.owner].resources) > 0) found[b.owner] = true;
		});
		return Object.keys(found).map(Number).sort(function (a, b) {
			return G.countCards(game.players[b].resources) - G.countCards(game.players[a].resources);
		});
	}

	/* --------------------------------------------------------------- trade replies */

	function respond(game, playerId) {
		const offer = game.offer;
		if (!offer) return false;
		const player = game.players[playerId];
		const canPay = M.RESOURCES.every(function (res) {
			return player.resources[res] >= (offer.want[res] || 0);
		});
		if (!canPay) return false;

		// Value what comes in against what goes out, with scarcity in the hand
		// counting for more than the flat weights alone.
		let value = 0;
		M.RESOURCES.forEach(function (res) {
			const scarcity = 1 + Math.max(0, 2 - player.resources[res]) * 0.5;
			value += (offer.give[res] || 0) * WEIGHT[res] * scarcity;
			value -= (offer.want[res] || 0) * WEIGHT[res] * scarcity * 1.25;
		});
		// Never hand the leader the win.
		const proposer = game.players[offer.from];
		if (game.publicPoints(proposer) >= game.targetVP - 2) value -= 3;
		return value > 0.4;
	}

	/* ------------------------------------------------------------------ main turn */

	function shortfall(resources, cost) {
		let missing = 0;
		Object.keys(cost).forEach(function (res) {
			missing += Math.max(0, cost[res] - (resources[res] || 0));
		});
		return missing;
	}

	/* One bank/port trade that moves the bot closer to `cost`, or null. `reserve`
	 * is held back so trading for a city never eats the bricks meant for a road. */
	function bankTradeTowards(game, player, cost, reserve) {
		if (shortfall(player.resources, cost) === 0) return null;
		const keep = reserve || {};
		const need = M.RESOURCES.filter(function (res) {
			return (cost[res] || 0) > player.resources[res];
		});
		for (let i = 0; i < need.length; i++) {
			const want = need[i];
			if (game.bank[want] < 1) continue;
			const spare = M.RESOURCES.filter(function (res) {
				const ratio = game.tradeRatio(player, res);
				const held = player.resources[res] - (cost[res] || 0) - (keep[res] || 0);
				return res !== want && held >= ratio;
			});
			const give = best(spare, function (res) {
				return player.resources[res] - game.tradeRatio(player, res);
			});
			if (give) return { give: give, get: want };
		}
		return null;
	}

	/* How much a vertex is worth to reach, spread outwards across the road graph
	 * so a spot four junctions away still pulls roads towards it - otherwise a bot
	 * boxed in by its neighbours simply stops expanding. */
	function reachValue(game, playerId) {
		const decay = 0.72;
		const value = {};
		const keys = Object.keys(game.board.vertices);
		keys.forEach(function (vk) {
			value[vk] = game.vertexIsFree(vk) ? vertexScore(game, vk, playerId) : 0;
		});
		for (let pass = 0; pass < 8; pass++) {
			let changed = false;
			keys.forEach(function (vk) {
				game.board.vertices[vk].adjacent.forEach(function (next) {
					const candidate = value[next] * decay;
					if (candidate > value[vk] + 0.001) {
						value[vk] = candidate;
						changed = true;
					}
				});
			});
			if (!changed) break;
		}
		return value;
	}

	function roadOptions(game, player) {
		const value = reachValue(game, player.id);
		return game.legalRoads(player.id).map(function (ek) {
			const ends = H.edgeEnds(ek);
			const score = Math.max(value[ends[0]] || 0, value[ends[1]] || 0);
			return { edge: ek, score: score };
		}).sort(function (a, b) {
			return b.score - a.score;
		});
	}

	/* Perform at most one action. Returns true while the bot still wants the turn. */
	function step(game) {
		const player = game.current();

		if (game.phase === 'build') return specialBuild(game, player);

		if (game.phase === 'roll') {
			// A knight before the roll both clears the robber and chases largest army.
			const robbedHex = game.board.hexes[game.robber];
			const robbingMe = robbedHex && robbedHex.corners.some(function (vk) {
				const b = game.buildings[vk];
				return b && b.owner === player.id;
			});
			const wantsArmy = player.knightsPlayed + 1 >= 3 && game.largestArmy !== player.id;
			if (player.dev.knight > 0 && !game.playedDevThisTurn && (robbingMe || wantsArmy)) {
				game.playDev('knight');
				return true;
			}
			game.rollDice();
			return true;
		}

		if (game.phase !== 'main') return true;

		// 1. Cities first - they double production and are worth two points.
		if (G.canAfford(player.resources, G.COSTS.city)) {
			const spot = best(game.legalCities(player.id), function (vk) {
				return vertexScore(game, vk);
			});
			if (spot && game.buildCity(spot).ok) return true;
		}

		// 2. New settlements.
		if (G.canAfford(player.resources, G.COSTS.settlement)) {
			const spot = best(game.legalSettlements(player.id), function (vk) {
				return vertexScore(game, vk, player.id);
			});
			if (spot && game.buildSettlement(spot).ok) return true;
		}

		// 3. Roads. A good spot nearby is worth a road on its own; with nowhere left
		// to settle, any road pointing at open ground beats standing still.
		const roads = roadOptions(game, player);
		const boxedIn = game.legalSettlements(player.id).length === 0;
		const roadsLeft = Object.keys(player.roads).length < G.LIMITS.road;
		const wantsRoad = roadsLeft && roads.length && roads[0].score > (boxedIn ? 0.5 : 6);
		if (wantsRoad && (game.freeRoads > 0 || G.canAfford(player.resources, G.COSTS.road))) {
			if (game.buildRoad(roads[0].edge).ok) return true;
		}

		// 4. Cash surplus into whatever is missing for the next build, keeping back
		// road materials while there is still somewhere to expand.
		const wantsCity = Object.keys(player.settlements).length > 0 &&
			Object.keys(player.cities).length < G.LIMITS.city;
		const goal = wantsCity ? G.COSTS.city : G.COSTS.settlement;
		const reserve = wantsRoad || (roadsLeft && boxedIn) ? G.COSTS.road : null;
		const trade = bankTradeTowards(game, player, goal, reserve);
		if (trade && game.tradeBank(trade.give, trade.get).ok) return true;

		// 5. Sitting on spare cards? Development cards beat losing them to a 7.
		if (game.devDeck.length && G.canAfford(player.resources, G.COSTS.dev) &&
			G.countCards(player.resources) >= 6) {
			if (game.buyDev().ok) return true;
		}

		// 6. Remaining one-shot cards.
		if (!game.playedDevThisTurn) {
			if (player.dev.monopoly > 0) {
				const target = best(M.RESOURCES, function (res) {
					return game.players.reduce(function (sum, other) {
						return sum + (other.id === player.id ? 0 : other.resources[res]);
					}, 0);
				});
				const held = game.players.reduce(function (sum, other) {
					return sum + (other.id === player.id ? 0 : other.resources[target]);
				}, 0);
				if (held >= 3 && game.playDev('monopoly', { resource: target }).ok) return true;
			}
			if (player.dev.yearOfPlenty > 0) {
				const needs = M.RESOURCES.filter(function (res) {
					return (G.COSTS.settlement[res] || 0) > player.resources[res];
				});
				const picks = needs.length ? needs.slice(0, 2) : ['ore', 'grain'];
				while (picks.length < 2) picks.push(picks[0]);
				if (game.playDev('yearOfPlenty', { resources: picks }).ok) return true;
			}
			if (player.dev.roadBuilding > 0 && roads.length >= 2 && roads[0].score > 4) {
				if (game.playDev('roadBuilding').ok) return true;
			}
			if (player.dev.knight > 0 && G.countCards(player.resources) < 4) {
				if (game.playDev('knight').ok) return true;
			}
		}

		return false;
	}

	/* The special build phase between turns: you may buy, but not trade and not
	 * play cards, so this is the main-turn priority list with those steps removed.
	 * Returns false as soon as there is nothing worth buying, which is what passes
	 * the phase along - a bot that never returns false freezes the table. */
	function specialBuild(game, player) {
		if (G.canAfford(player.resources, G.COSTS.city)) {
			const spot = best(game.legalCities(player.id), function (vk) {
				return vertexScore(game, vk);
			});
			if (spot && game.buildCity(spot).ok) return true;
		}

		if (G.canAfford(player.resources, G.COSTS.settlement)) {
			const spot = best(game.legalSettlements(player.id), function (vk) {
				return vertexScore(game, vk, player.id);
			});
			if (spot && game.buildSettlement(spot).ok) return true;
		}

		const roads = roadOptions(game, player);
		const boxedIn = game.legalSettlements(player.id).length === 0;
		const roadsLeft = Object.keys(player.roads).length < G.LIMITS.road;
		if (roadsLeft && roads.length && roads[0].score > (boxedIn ? 0.5 : 6) &&
			G.canAfford(player.resources, G.COSTS.road)) {
			if (game.buildRoad(roads[0].edge).ok) return true;
		}

		// Cards you buy here are not playable until your own next turn anyway, so
		// only spend on one when the hand is big enough to be at risk from a 7.
		if (game.devDeck.length && G.canAfford(player.resources, G.COSTS.dev) &&
			G.countCards(player.resources) >= 8) {
			if (game.buyDev().ok) return true;
		}

		return false;
	}

	function discard(game, playerId) {
		const player = game.players[playerId];
		const needed = game.pendingDiscards[playerId] || 0;
		const picks = G.emptyResources();
		const keep = G.COSTS.settlement;
		for (let i = 0; i < needed; i++) {
			const choice = best(M.RESOURCES, function (res) {
				const left = player.resources[res] - picks[res];
				if (left <= 0) return -Infinity;
				return left - (keep[res] || 0) * 1.5 - WEIGHT[res];
			});
			if (!choice) break;
			picks[choice]++;
		}
		return picks;
	}

	return {
		vertexScore: vertexScore,
		production: production,
		setupSettlement: setupSettlement,
		setupRoad: setupRoad,
		robberChoice: robberChoice,
		respond: respond,
		step: step,
		discard: discard
	};
})();
