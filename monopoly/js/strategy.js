// Parametrized bot strategy. A single "genome" of numeric/boolean parameters drives every
// decision. This lets the simulator grid-search / evolve the parameter space to find the
// best-performing configuration, and lets the final game use that winning configuration
// as the built-in AI opponent's brain.

(function (root) {
	'use strict';

	const Board = (typeof module !== 'undefined' && module.exports) ? require('./board.js') : root.MonopolyBoard;

	// Default / baseline genome. Values are tuned starting points; simulation searches around these.
	const DEFAULT_GENOME = {
		// --- Buying ---
		buyThreshold: 0.35,        // buy if (money - price) / money >= -this after purchase is still safe; see logic
		minCashReserve: 150,       // never buy/build if it would drop cash below this (soft)
		monopolyPremium: 1.5,      // willingness multiplier to buy properties that complete/contribute to a monopoly
		utilityValue: 0.6,         // relative valuation of utilities vs their price
		railValue: 1.0,            // relative valuation of rails vs their price

		// --- Auctions ---
		auctionAggressiveness: 0.8, // fraction of "fair value" willing to bid up to
		auctionMonopolyBonus: 1.4,  // bonus multiplier when auction item completes a monopoly

		// --- Building ---
		buildThreshold: 300,       // keep at least this much cash after building
		buildUpToHotel: true,      // keep building through to hotel when affordable
        evenBuildBias: true,       // spread houses evenly across group before hotel-ing one

		// --- Jail ---
		jailStayEarlyGame: true,   // prefer staying in jail while few monopolies exist (avoid landing on rent)
		jailPayThreshold: 0.6,     // pay bail immediately if (turn/maxTurns) progress and monopolies owned exceed this signal
		lateGameAlwaysPay: true,   // once player owns a monopoly, pay to get out fast and keep building/collecting

		// --- Trading ---
		tradeWillingness: 0.5,     // overall propensity to propose/accept trades (0=never,1=always considers)
        tradeFairnessMargin: 1.15, // require this much value advantage to accept a trade
        tradeMonopolyDrive: 2.0,   // extra value assigned to trades that complete the proposer's own monopoly

		// --- Liquidation / risk ---
		mortgageBeforeSellHouse: false, // if true, prefers mortgaging plain properties before selling houses when raising cash
		riskAversion: 0.5,         // general dampener on aggressive spending (0=yolo, 1=very conservative)

		// --- New: build order, jail-card economics, blocking behavior ---
		buildCheapGroupsFirst: true,  // when multiple monopolies are buildable, develop the cheaper color group before the pricier one
		keepJailCardLateGame: true,   // hold onto Get Out of Jail Free cards once owning 2+ monopolies (worth more than selling) rather than trading them away
		blockingAwareness: 0.0,       // 0=never reason about opponents; >0 = willingness to overpay in auctions/trades to deny an opponent a monopoly-completing property
		sellHouseEvenly: true,        // when forced to sell houses, take from the group with the most houses first (even depletion) rather than cheapest-to-replace

		// --- Group scarcity (last-piece) awareness ---
		// Standard tradeMonopolyDrive/blockingAwareness only reason about a trade completing the
		// REQUESTER's set as a flat multiplier. They miss the compounding scarcity effect: once
		// two of three group members are split between two different players, the third owner
		// holds the single most valuable property on the board (either rival would pay almost
		// anything for it) and should refuse to sell either of their own pieces for anything close
		// to face value. groupScarcityPremium models this directly, scaled by how many members of
		// the group are already spoken for (scarcer group -> steeper asking price).
		groupScarcityPremium: 0.0,    // 0=off; >0 = extra multiplier per already-owned group member when asked to give up a property in a group we already hold part of
		chaseLastPieceDrive: 1.0      // multiplier on how much extra (beyond tradeMonopolyDrive) we'll offer to acquire the single missing piece of our own group before a rival can grab it
	};

	function propertyValue(game, pos, genome) {
		const space = game.getSpace(pos);
		let value = space.price;
		if (space.type === 'rail') value *= genome.railValue;
		if (space.type === 'utility') value *= genome.utilityValue;
		if (space.type === 'property') {
			const members = game.propertiesInGroup(space.group);
			const ownedByAnyone = members.filter(p => game.properties[p].owner !== null);
			if (ownedByAnyone.length > 0) value *= genome.monopolyPremium; // contested/valuable group
		}
		return value;
	}

	function countMonopolies(game, playerId) {
		let n = 0;
		for (const group of Object.keys(Board.GROUP_MEMBERS)) {
			if (game.ownsFullGroup(playerId, group)) n++;
		}
		return n;
	}

	/**
	 * Creates an agent object bound to a genome. Implements every decide* method
	 * the engine calls. All methods are synchronous (fast for simulation).
	 */
	function makeBotAgent(genome) {
		const g = Object.assign({}, DEFAULT_GENOME, genome);

		return {
			genome: g,

			decideBuyProperty({ player, game, pos }) {
				const space = game.getSpace(pos);
				const price = space.price;
				const cashAfter = player.money - price;
				if (cashAfter < g.minCashReserve * (1 - g.riskAversion * 0.5)) return false;
				const val = propertyValue(game, pos, g);
				// buy if perceived value exceeds price scaled by threshold tolerance
				const willingnessPrice = price * (1 - g.buyThreshold * 0.3 + 0.3);
				return val >= price * 0.9 && cashAfter >= g.minCashReserve * 0.4 && price <= player.money;
			},

			decideAuctionBid({ player, game, pos, highBid, highBidder }) {
				const space = game.getSpace(pos);
				let fairValue = propertyValue(game, pos, g);
				// bonus if this completes our own monopoly
				if (space.type === 'property') {
					const members = game.propertiesInGroup(space.group);
					const ownedByMe = members.filter(p => game.properties[p].owner === player.id).length;
					if (ownedByMe === members.length - 1) fairValue *= g.auctionMonopolyBonus;
					// blocking: does this complete (or nearly complete) some OTHER active player's monopoly?
					if (g.blockingAwareness > 0) {
						const otherOwners = new Set(members.map(p => game.properties[p].owner).filter(o => o !== null && o !== player.id));
						for (const oid of otherOwners) {
							const ownedByThem = members.filter(p => game.properties[p].owner === oid).length;
							if (ownedByThem === members.length - 1) {
								fairValue *= 1 + g.blockingAwareness;
								break;
							}
						}
					}
				}
				const cap = Math.min(fairValue * g.auctionAggressiveness, player.money - g.minCashReserve * 0.3);
				const nextBid = highBid + Math.max(5, Math.round(space.price * 0.05));
				if (nextBid > cap) return 0; // stop bidding
				if (nextBid > player.money) return 0;
				return nextBid;
			},

			decideJail({ player, game }) {
				if (player.getOutOfJailFree > 0) return 'card';
				const monopolies = countMonopolies(game, player.id);
				if (monopolies > 0 && g.lateGameAlwaysPay && player.money >= Board.JAIL_FINE + g.minCashReserve * 0.3) {
					return 'pay';
				}
				const progress = game.turnCount / game.maxTurns;
				if (g.jailStayEarlyGame && monopolies === 0 && progress < g.jailPayThreshold) {
					return 'stay';
				}
				if (player.money >= Board.JAIL_FINE + g.minCashReserve * 0.5) return 'pay';
				return 'stay';
			},

			decideLiquidation({ player, game, amountNeeded, sellable }) {
				if (!sellable.length) return null;
				let houses = sellable.filter(s => s.type === 'sellHouse');
				const mortgages = sellable.filter(s => s.type === 'mortgage');
				if (g.sellHouseEvenly) {
					// sell from the group with the most houses first, to keep development even
					houses = houses.slice().sort((a, b) => game.properties[b.pos].houses - game.properties[a.pos].houses);
				}
				// (Tried mortgagePriorityAware: sort mortgage candidates to protect group-progressed
				// properties/rails/utilities and mortgage lone properties first, per common human
				// strategy advice. Tested head-to-head: 25.0-25.3% win rate vs the unordered baseline
				// at n=3000 and n=8000 - statistically neutral, a fair coin flip either way. Reverted;
				// liquidation apparently doesn't happen often enough in these sims for ordering
				// within it to matter much.)
				let ordered;
				if (g.mortgageBeforeSellHouse) ordered = mortgages.concat(houses);
				else ordered = houses.concat(mortgages);
				return ordered[0] || null;
			},

			decideAction({ player, game }) {
				// 1) try unmortgage cheap properties if flush
				for (const pos of player.properties) {
					const prop = game.properties[pos];
					if (prop.mortgaged) {
						const space = game.getSpace(pos);
						const cost = Math.ceil(space.price / 2 * 1.1);
						if (player.money - cost >= g.minCashReserve * 1.5) {
							return { type: 'unmortgage', pos };
						}
					}
				}
				// 2) try building on any monopoly group, ordered by group cost preference
				// (Tried implementing evenBuildBias as "rush every property in a group to 3 houses
				// before hoteling any", per the common human-strategy advice that rent jumps most
				// steeply at 3 houses. Tested head-to-head: lost 25.5% vs the greedy cheapest-first
				// order (n=3000, a wash at best) and regressed slightly on the archetype aggregate
				// (45.6% -> 45.0%, n=9600). Reverted - evenBuildBias stays declared but unused; the
				// engine's even-building RULE [wouldBlockPath-style cap: can't build more than 1
				// ahead of the group minimum, see canBuildOn in game.js] already forces reasonably
				// even development regardless, which likely explains why an extra bias on top added
				// no value here.)
				const buildable = player.properties
					.filter(pos => game.canBuildOn(player, pos))
					.sort((a, b) => {
						const ca = game.getSpace(a).houseCost, cb = game.getSpace(b).houseCost;
						return g.buildCheapGroupsFirst ? ca - cb : cb - ca;
					});
				for (const pos of buildable) {
					const space = game.getSpace(pos);
					if (player.money - space.houseCost >= g.buildThreshold) {
						if (game.properties[pos].houses === 4 && !g.buildUpToHotel) continue;
						return { type: 'build', pos };
					}
				}
				// 3) consider proposing a trade occasionally
				if (g.tradeWillingness > 0 && Math.random() < g.tradeWillingness * 0.15) {
					const trade = proposeTrade(game, player, g);
					if (trade) return { type: 'proposeTrade', trade };
				}
				return { type: 'done' };
			},

			decideTradeResponse({ player, game, trade, proposer }) {
				return evaluateTrade(game, player, trade, g);
			}
		};
	}

	// --- Trading heuristics shared by propose/evaluate ---

	function estimateAssetValue(game, playerId, pos, genome) {
		const space = game.getSpace(pos);
		let v = space.price;
		const prop = game.properties[pos];
		if (prop.houses > 0) v += prop.houses * space.houseCost * 1.2;
		if (space.type === 'property') {
			const members = game.propertiesInGroup(space.group);
			const ownedByPlayer = members.filter(p => game.properties[p].owner === playerId).length;
			if (ownedByPlayer === members.length - 1) v *= genome.tradeMonopolyDrive; // near-complete set
		}
		return v;
	}

	/** How many members of pos's color group `playerId` already owns, EXCLUDING pos itself.
	 * Used to price "am I being asked to break up a partial set I'm holding onto?" - a player
	 * sitting on 1-of-3 (or 2-of-3) of a group holds a scarce asset even without owning `pos`. */
	function ownedGroupCountExcluding(game, playerId, pos, space) {
		if (space.type !== 'property') return 0;
		const members = game.propertiesInGroup(space.group);
		return members.filter(p => p !== pos && game.properties[p].owner === playerId).length;
	}

	function proposeTrade(game, proposer, genome) {
		// find a group where proposer owns all-but-one, and some other player owns the missing piece
		for (const group of Object.keys(Board.GROUP_MEMBERS)) {
			const members = Board.GROUP_MEMBERS[group];
			const ownedByMe = members.filter(p => game.properties[p].owner === proposer.id);
			if (ownedByMe.length !== members.length - 1) continue;
			const missing = members.find(p => game.properties[p].owner !== proposer.id);
			const missingProp = game.properties[missing];
			if (missingProp.owner === null || missingProp.owner === proposer.id) continue;
			const owner = game.players[missingProp.owner];
			if (owner.bankrupt) continue;
			// offer: cash + maybe a property they don't need, sized to missing property's value.
			// chaseLastPieceDrive scales the multiplier on top of the base 1.3x markup - a bot that
			// understands the endgame value of the last piece of a group offers substantially more
			// than "fair" for it rather than lowballing and losing the race to another player.
			const missingSpace = game.getSpace(missing);
			const markup = 1.3 * genome.chaseLastPieceDrive;
			const offerMoney = Math.min(Math.round(missingSpace.price * markup), Math.max(0, proposer.money - 100));
			if (offerMoney < missingSpace.price * 0.8) continue; // can't afford a fair offer
			return {
				toId: owner.id,
				offerProps: [],
				offerMoney,
				requestProps: [missing],
				requestMoney: 0,
				offerCards: 0,
				requestCards: 0
			};
		}
		return null;
	}

	function evaluateTrade(game, player, trade, genome) {
		let giveValue = (trade.requestMoney || 0);
		let getValue = (trade.offerMoney || 0);
		for (const pos of trade.requestProps) giveValue += estimateAssetValue(game, player.id, pos, genome);
		for (const pos of trade.offerProps) getValue += estimateAssetValue(game, trade.toId != null ? trade.toId : player.id, pos, genome);
		giveValue += (trade.requestCards || 0) * 60;
		getValue += (trade.offerCards || 0) * 60;
		// refuse to give away Get Out of Jail Free cards once holding 2+ monopolies (they're worth more
		// as insurance against being stuck in jail mid-build than whatever flat value a trade assigns them)
		if (genome.keepJailCardLateGame && (trade.requestCards || 0) > 0 && countMonopolies(game, player.id) >= 2) {
			return false;
		}
		// blocking awareness: if giving up these properties would hand the trade proposer a monopoly,
		// demand a steeper premium proportional to blockingAwareness before accepting
		if (genome.blockingAwareness > 0 && trade.requestProps && trade.requestProps.length) {
			for (const pos of trade.requestProps) {
				const space = game.getSpace(pos);
				if (space.type !== 'property') continue;
				const members = game.propertiesInGroup(space.group);
				const proposerOwned = members.filter(p => game.properties[p].owner === trade.toId || p === pos).length;
				if (proposerOwned === members.length) {
					giveValue *= 1 + genome.blockingAwareness;
					break;
				}
			}
		}
		// group scarcity: giving up a property from a group we ALSO hold a piece of is worse than
		// it looks from raw price alone - it kills our own shot at that set, and the fewer members
		// left unclaimed the more each remaining piece is worth to whoever ends up chasing it.
		// Scales with how many of the group we already own, so a 2-of-3 holder guards their piece
		// far more jealously than someone who owns none of the group.
		if (genome.groupScarcityPremium > 0 && trade.requestProps && trade.requestProps.length) {
			for (const pos of trade.requestProps) {
				const space = game.getSpace(pos);
				if (space.type !== 'property') continue;
				const ownedByMe = ownedGroupCountExcluding(game, player.id, pos, space);
				if (ownedByMe > 0) {
					giveValue *= 1 + genome.groupScarcityPremium * ownedByMe;
				}
			}
		}
		if (giveValue <= 0) return getValue >= 0;
		return getValue >= giveValue * genome.tradeFairnessMargin;
	}

	// Genome discovered via coordinate-ascent grid search over ~72,000 simulated 4-player games
	// (see /monopoly/sim/gridsearch.js), then confirmed at n=800/parameter on the parameters that
	// were still noisy after the initial passes. In head-to-head seat-rotated matches (3 baseline
	// bots + 1 challenger, challenger's seat rotated evenly) this genome beat:
	//   - the default/baseline genome: 40.0% win rate (n=2000) vs a fair share of 25%
	//   - a hand-crafted "monopoly-focused" archetype: 31.0% (its closest competitor, n=300)
	//   - "aggressive buyer", "conservative", "jail camper", "rail collector" archetypes: 36-46%
	// Re-tested against ~230,000 more simulated games across two follow-up search rounds
	// (gridsearch2.js, gridsearch3.js) that also tried 4 new parameters (buildCheapGroupsFirst,
	// keepJailCardLateGame, blockingAwareness, sellHouseEvenly) - no genome beat this one; every
	// individual parameter change tested in isolation was statistically neutral (within noise of
	// a fair 25% share at n=1200).
	//
	// Round 4 (gridsearch4.js): a human playtester reported exploiting a specific blind spot -
	// bots owning 1-of-3 (or 2-of-3) of a color group would sell their piece to a human for close
	// to face value, not accounting for the compounding scarcity effect (once 2 of 3 group members
	// are split between two different owners, the 3rd is the single most valuable property on the
	// board, since either rival will pay almost anything for it). Added two new parameters to model
	// this directly: groupScarcityPremium (demand a steeper price to give up a property from a
	// group we already partially own, scaled by how many members we hold) and chaseLastPieceDrive
	// (offer substantially more than "fair" to acquire our own group's last piece before a rival
	// or shrewd human beats us to it). Drift-safe coordinate ascent over ~18,400 games found
	// groupScarcityPremium=1.5, chaseLastPieceDrive=1.8 beat the round-3 anchor at 45.5-45.7% win
	// rate (confirmed at both n=4000 and n=6000 - not a fluke). Directly tested against the
	// exploit: pitted 3 defenders against 1 "group hoarder" opponent (trades aggressively to
	// complete color groups, same shape as the human strategy) - the hoarder's win rate dropped
	// from 19.4% (round-3 anchor defenders) to 11.1% (round-4 defenders), n=1000 each side.
	// This genome is a validated local optimum for this rule engine, including against this
	// specific human trading strategy. See /monopoly/strategy.html for the full writeup of what
	// this genome implies as human-readable advice.
	//
	// Round 5: researched published human/AI Monopoly strategy write-ups for additional ideas not
	// yet modeled, then implemented and head-to-head tested each in isolation (code-logic diff vs
	// current BEST_GENOME, same archetype round-robin as compare-round4-archetypes.js). All three
	// tested NEUTRAL to slightly negative and were reverted:
	//   - "rush every group property to 3 houses before hoteling any" (rent jumps steepest at 3
	//     houses, per common strategy advice): 25.5% win rate vs the existing cheapest-first order
	//     (n=3000), aggregate archetype win rate 45.6%->45.0% (n=9600, a regression). Likely
	//     redundant with the engine's existing even-build rule (canBuildOn in game.js already caps
	//     building more than 1 house ahead of the group minimum), so an extra bias added no value.
	//   - "mortgage lone properties before group-progressed ones, protect rails/utilities last"
	//     (protect properties on the path to a monopoly when raising cash): 25.0-25.3% (n=3000 and
	//     n=8000) - statistically neutral. Liquidation apparently doesn't come up often enough in
	//     these sims for its internal ordering to matter much.
	//   - "size cash reserve to the worst rent reachable in the next ~2 rolls" instead of a flat
	//     minCashReserve (common advice: hold back extra before crossing a built-up stretch):
	//     swept 5 candidate strengths (0.3-2.0), best candidate (0.3) confirmed at 25.30% (n=3000)
	//     - neutral, no signal at any strength tested.
	// Net: BEST_GENOME is unchanged from round 4. This isn't evidence the underlying advice is
	// wrong for human play - only that, given how this engine's other heuristics are already
	// tuned (buildCheapGroupsFirst, riskAversion, the even-build engine rule, raiseCash's
	// liquidation fallback), these particular refinements don't move the needle further here.
	const BEST_GENOME = {
		buyThreshold: 0.5,
		minCashReserve: 300,
		monopolyPremium: 1.25,
		utilityValue: 0.9,
		railValue: 1.4,
		auctionAggressiveness: 1.2,
		auctionMonopolyBonus: 2.2,
		buildThreshold: 200,
		buildUpToHotel: false,
		evenBuildBias: true,
		jailStayEarlyGame: false,
		jailPayThreshold: 0.65,
		lateGameAlwaysPay: false,
		tradeWillingness: 0.75,
		tradeFairnessMargin: 1.75,
		tradeMonopolyDrive: 2,
		mortgageBeforeSellHouse: false,
		riskAversion: 0.7,
		buildCheapGroupsFirst: true,
		keepJailCardLateGame: true,
		blockingAwareness: 0.0,
		sellHouseEvenly: true,
		groupScarcityPremium: 1.5,
		chaseLastPieceDrive: 1.8
	};

	const api = { DEFAULT_GENOME, BEST_GENOME, makeBotAgent, propertyValue, countMonopolies, evaluateTrade, proposeTrade };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	} else {
		root.MonopolyStrategy = api;
	}
})(typeof window !== 'undefined' ? window : globalThis);
