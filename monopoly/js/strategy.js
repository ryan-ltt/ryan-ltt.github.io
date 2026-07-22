// Parametrized bot strategy. A single "genome" of numeric/boolean parameters drives every
// decision. This lets the simulator grid-search / evolve the parameter space to find the
// best-performing configuration, and lets the final game use that winning configuration
// as the built-in AI opponent's brain.

(function (root) {
	'use strict';

	const Board = (typeof module !== 'undefined' && module.exports) ? require('./board.js') : root.MonopolyBoard;
	// Lazily resolved (see rolloutNetWorthDelta) rather than required at module load time: game.js
	// doesn't depend on strategy.js, so there's no real cycle, but resolving lazily keeps this
	// module loadable even if something ever changes that load order, and avoids paying the cost
	// of looking it up unless tradeLookahead is actually enabled.
	function getEngine() {
		return (typeof module !== 'undefined' && module.exports) ? require('./game.js') : root.MonopolyEngine;
	}

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

		// --- Trade proposal composition (see proposeTrade/composeCounterOffer) ---
		tradeOfferMargin: 0.85,       // size proposed offers to this fraction of what the target's own
		                               // valuation (x tradeFairnessMargin) would require - generous enough
		                               // to plausibly land rather than a bare-minimum lowball
		tradeEscalationRate: 0.25,    // each prior rejection from the same opponent for the same target
		                               // property inflates the next offer by this fraction (see tradeLedger)
		tradePropertySwapWillingness: 0.6, // chance of sweetening/substituting an offer with one of the
		                               // proposer's own properties instead of cash-only, when a plausible swap exists

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
		chaseLastPieceDrive: 1.0,     // multiplier on how much extra (beyond tradeMonopolyDrive) we'll offer to acquire the single missing piece of our own group before a rival can grab it

		// --- Forward-looking trade evaluation ---
		// evaluateTrade() above is a pure snapshot heuristic: it prices properties/cash/cards by
		// static rules (list price, monopoly multipliers) and never asks what actually happens
		// after the trade goes through. tradeLookahead turns on a Monte Carlo check instead: clone
		// the live game twice (with the trade applied, and without), play both clones forward
		// tradeLookaheadTurns player-turns using every player's own real strategy, average net
		// worth across tradeLookaheadRollouts trials each, and accept only if the with-trade
		// average beats the without-trade average by tradeFairnessMargin. This can catch things the
		// static rules can't (e.g. a trade that looks fair on paper but sets up an opponent's
		// monopoly two turns before yours completes), at the cost of being far more expensive to
		// evaluate - each decision this drives runs 2*tradeLookaheadRollouts short simulated games.
		tradeLookahead: false,
		tradeLookaheadTurns: 15,      // how many player-turns to simulate forward from the current state
		tradeLookaheadRollouts: 6     // simulated trials per side (with-trade vs without-trade); averaged to smooth over dice/card variance
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
		// Per-opponent, per-property memory of past trade attempts: `${opponentId}:${pos}` ->
		// {rejectionCount, lastOfferMoney, lastOfferValue, lastProposedTurn}. Lives only on this
		// agent closure - it's negotiation history for THIS bot's real game, not board/player
		// state, so it must never be threaded through game.snapshotState()/applySnapshot(). Monte
		// Carlo rollouts (see makeRolloutGame below) already construct a fresh makeBotAgent() per
		// clone, so rollout agents naturally get their own empty ledger and can't leak into or
		// out of the live game's real one - don't "fix" that by passing this in from outside.
		const tradeLedger = new Map();

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
					const trade = proposeTrade(game, player, g, tradeLedger);
					if (trade) return { type: 'proposeTrade', trade };
				}
				return { type: 'done' };
			},

			decideTradeResponse({ player, game, trade, proposer }) {
				if (g.tradeLookahead) return evaluateTradeWithLookahead(game, player, trade, g);
				return evaluateTrade(game, player, trade, g);
			},

			/** Feedback hook: game.js's handleTradeProposal calls this on the PROPOSER's agent right
			 * after the target accepts/rejects, so the ledger can record a rejection for next time.
			 * Accepted trades need no bookkeeping - the property changes hands, so there's nothing
			 * left to escalate toward. Duck-typed (game.js checks this exists before calling) so the
			 * human agent, which has no such method, is unaffected. */
			onTradeResult(trade, accepted) {
				if (accepted) return;
				for (const pos of (trade.requestProps || [])) {
					const key = `${trade.toId}:${pos}`;
					const prev = tradeLedger.get(key) || { rejectionCount: 0, lastOfferMoney: 0, lastOfferValue: 0, lastProposedTurn: -1 };
					tradeLedger.set(key, Object.assign({}, prev, { rejectionCount: prev.rejectionCount + 1 }));
				}
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

	/** True if `pos` is the single missing piece of a color group `playerId` otherwise fully
	 * owns - i.e. estimateAssetValue's tradeMonopolyDrive bonus is active for this asset. Used to
	 * (a) apply chaseLastPieceDrive on top when composing an offer for such a piece, and (b)
	 * keep findSwapCandidate from offering away the proposer's own near-complete piece as a
	 * sweetener for an unrelated trade. */
	function isNearCompletePiece(game, playerId, pos, space) {
		if (space.type !== 'property') return false;
		const members = game.propertiesInGroup(space.group);
		const ownedByPlayer = members.filter(p => game.properties[p].owner === playerId).length;
		return ownedByPlayer === members.length - 1;
	}

	/** Scans every property/rail/utility NOT owned by proposer (and owned by some other live,
	 * non-bankrupt player), scores each by (value to proposer) - (fair market cost), and returns
	 * candidates sorted best-gap-first. Reuses estimateAssetValue/propertyValue rather than a
	 * parallel pricing scheme, so a group's near-complete piece naturally scores highest via
	 * estimateAssetValue's existing tradeMonopolyDrive bonus - no separate "check my own
	 * monopolies first" pass is needed, that case just falls out of the unified scoring. Rails
	 * and utilities participate for the same reason: propertyValue/estimateAssetValue already
	 * branch on space.type for their multipliers. */
	function scoreTradeTargets(game, proposer, genome) {
		const candidates = [];
		for (const posStr of Object.keys(game.properties)) {
			const pos = Number(posStr);
			const prop = game.properties[pos];
			if (prop.owner === null || prop.owner === proposer.id) continue;
			const owner = game.players[prop.owner];
			if (owner.bankrupt) continue;
			const valueToMe = estimateAssetValue(game, proposer.id, pos, genome);
			const costToAcquire = propertyValue(game, pos, genome);
			const gap = valueToMe - costToAcquire;
			if (gap <= 0) continue;
			candidates.push({ pos, owner, space: game.getSpace(pos), valueToMe, gap });
		}
		candidates.sort((a, b) => b.gap - a.gap);
		return candidates;
	}

	/** Looks for one of proposer's own properties that `target` would plausibly want, to
	 * sweeten/substitute for cash in a counter-offer. Values each candidate AS IF target already
	 * owned it (the same trick evaluateTrade uses for offerProps), so a rail/utility target lacks
	 * or a piece that would complete target's own set score highest. Skips developed properties
	 * (don't give away built equity) and skips the proposer's own near-complete group pieces
	 * (never trade away your own monopoly chase to sweeten an unrelated deal). */
	function findSwapCandidate(game, proposer, target, excludePos, genome) {
		let best = null;
		for (const pos of proposer.properties) {
			if (pos === excludePos) continue;
			const space = game.getSpace(pos);
			if (game.properties[pos].houses > 0) continue;
			if (isNearCompletePiece(game, proposer.id, pos, space)) continue;
			const valueToTarget = estimateAssetValue(game, target.id, pos, genome);
			if (!best || valueToTarget > best.valueToTarget) {
				best = { pos, space, valueToTarget };
			}
		}
		return best;
	}

	/** Builds the offerMoney/offerProps/offerCards side of a trade requesting `targetPos` from
	 * `target`, sized to be generous enough to plausibly clear target's own evaluateTrade
	 * threshold (tradeOfferMargin fraction of target's own valuation x tradeFairnessMargin),
	 * escalated past any previously-rejected offer for this exact opponent+property
	 * (tradeEscalationRate), but never past what the property is actually worth to the proposer
	 * (ceiling - prevents runaway offers across a long game, since the ledger never decays).
	 * Returns null if no affordable/valid offer can be composed. */
	function composeCounterOffer(game, proposer, target, targetPos, genome, ledgerEntry) {
		const ownValueToProposer = estimateAssetValue(game, proposer.id, targetPos, genome);
		const requiredValue = estimateAssetValue(game, target.id, targetPos, genome) * genome.tradeFairnessMargin;
		let targetOfferValue = requiredValue * genome.tradeOfferMargin;
		// chaseLastPieceDrive: extra push on top when this is the proposer's own near-complete
		// group piece - the same endgame urgency the old proposeTrade modeled, now layered onto
		// the unified offer-sizing instead of being the only case handled.
		const targetSpace = game.getSpace(targetPos);
		if (isNearCompletePiece(game, proposer.id, targetPos, targetSpace)) {
			targetOfferValue *= genome.chaseLastPieceDrive;
		}
		if (ledgerEntry && ledgerEntry.rejectionCount > 0) {
			targetOfferValue = Math.max(targetOfferValue, ledgerEntry.lastOfferValue * (1 + ledgerEntry.rejectionCount * genome.tradeEscalationRate));
		}
		// never offer more than the property is worth to the proposer, no matter how escalated
		targetOfferValue = Math.min(targetOfferValue, ownValueToProposer);
		if (ledgerEntry && targetOfferValue <= ledgerEntry.lastOfferValue) return null; // can't beat the last (rejected) offer within the ceiling - not worth repeating

		let remaining = targetOfferValue;
		let offerProps = [];
		if (Math.random() < genome.tradePropertySwapWillingness) {
			const swap = findSwapCandidate(game, proposer, target, targetPos, genome);
			if (swap) {
				offerProps = [swap.pos];
				remaining -= swap.valueToTarget;
			}
		}

		let offerCards = 0;
		const keepingCards = genome.keepJailCardLateGame && countMonopolies(game, proposer.id) >= 2;
		if (remaining > 60 && proposer.getOutOfJailFree > 0 && !keepingCards) {
			offerCards = 1;
			remaining -= 60; // matches evaluateTrade's flat per-card valuation
		}

		const offerMoney = Math.max(0, Math.round(remaining));
		const affordableCap = Math.max(0, proposer.money - genome.minCashReserve);
		if (offerMoney > affordableCap) return null;
		if (offerCards > proposer.getOutOfJailFree) return null;

		const totalOfferValue = offerMoney + offerCards * 60 + offerProps.reduce((sum, p) => sum + estimateAssetValue(game, target.id, p, genome), 0);
		return { offerMoney, offerProps, offerCards, totalOfferValue };
	}

	function proposeTrade(game, proposer, genome, ledger) {
		const led = ledger || new Map();
		const candidates = scoreTradeTargets(game, proposer, genome);
		for (const candidate of candidates) {
			const { pos, owner } = candidate;
			const key = `${owner.id}:${pos}`;
			const ledgerEntry = led.get(key);
			const composed = composeCounterOffer(game, proposer, owner, pos, genome, ledgerEntry);
			if (!composed) continue;

			led.set(key, Object.assign({}, ledgerEntry, {
				rejectionCount: ledgerEntry ? ledgerEntry.rejectionCount : 0,
				lastOfferMoney: composed.offerMoney,
				lastOfferValue: composed.totalOfferValue,
				lastProposedTurn: game.turnCount
			}));

			return {
				toId: owner.id,
				offerProps: composed.offerProps,
				offerMoney: composed.offerMoney,
				requestProps: [pos],
				requestMoney: 0,
				offerCards: composed.offerCards,
				requestCards: 0
			};
		}
		return null;
	}

	function evaluateTrade(game, player, trade, genome) {
		let giveValue = (trade.requestMoney || 0);
		let getValue = (trade.offerMoney || 0);
		for (const pos of trade.requestProps) giveValue += estimateAssetValue(game, player.id, pos, genome);
		// offerProps are valued as if owned by trade.toId - the RESPONDER (this function's
		// `player`) receiving them, i.e. trade.toId is player.id here, since handleTradeProposal
		// always calls decideTradeResponse on the trade's target. Correct on purpose: getValue is
		// "how much is what I'd receive worth to me", so pricing offerProps from the receiver's
		// own group-ownership/monopoly-bonus perspective is exactly right, not a proposer/
		// responder mixup. This path was rarely exercised before (bots only offered cash), so
		// it's worth flagging now that proposeTrade routinely fills in offerProps.
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

	/** Builds a fresh rollout MonopolyGame cloned from `game`'s current state via
	 * snapshot/applySnapshot, with every seat using its OWN real strategy genome except that
	 * tradeLookahead is forced off for all of them - without this, every simulated turn inside the
	 * rollout could itself try to spawn a nested rollout, which would blow up combinatorially (a
	 * depth-15 lookahead containing depth-15 lookahecks containing more lookaheads...). The rollout
	 * bots are otherwise "as smart as the real ones" so the projection reflects how players would
	 * actually keep playing, not a dumbed-down stand-in. */
	function makeRolloutGame(game, seed) {
		const MonopolyEngine = getEngine();
		const agents = game.players.map(p => {
			const baseGenome = (p.agent && p.agent.genome) ? p.agent.genome : DEFAULT_GENOME;
			return { name: p.name, agent: makeBotAgent(Object.assign({}, baseGenome, { tradeLookahead: false })) };
		});
		const rollout = new MonopolyEngine.MonopolyGame(agents, { seed, maxTurns: game.maxTurns });
		rollout.applySnapshot(game.snapshotState());
		game.players.forEach((p, i) => { rollout.players[i].bankrupt = p.bankrupt; });
		return rollout;
	}

	/** Forward-looking trade evaluation: simulates `rollouts` short playouts (each
	 * `lookaheadTurns` player-turns deep) from the CURRENT game state, once with the hypothetical
	 * trade applied and once without, using every player's real strategy so the projection reflects
	 * actual future play rather than a static snapshot heuristic. Returns true if `player`'s average
	 * projected net worth with the trade beats their average without it by at least
	 * genome.tradeFairnessMargin. This can catch effects the static evaluateTrade() can't see at
	 * all - e.g. a trade that looks even on paper but hands the proposer a monopoly that starts
	 * collecting steep rent well before the responder's own properties pay off. */
	async function evaluateTradeWithLookahead(game, player, trade, genome) {
		const proposer = game.players[trade.toId];
		const rollouts = Math.max(1, genome.tradeLookaheadRollouts);
		const turns = Math.max(1, genome.tradeLookaheadTurns);
		let withTradeTotal = 0, withoutTradeTotal = 0;
		let seedBase = Math.floor(Math.random() * 2 ** 31);

		for (let i = 0; i < rollouts; i++) {
			// same seed for both branches of a given trial, so dice/card variance cancels out in the
			// comparison and the trade itself is the only thing that differs between the two runs
			const seed = seedBase + i;

			const withTrade = makeRolloutGame(game, seed);
			withTrade.applyTradeEffects(withTrade.players[proposer.id], withTrade.players[player.id], trade);
			await withTrade.runForTurns(turns);
			withTradeTotal += withTrade.netWorth(withTrade.players[player.id]);

			const withoutTrade = makeRolloutGame(game, seed);
			await withoutTrade.runForTurns(turns);
			withoutTradeTotal += withoutTrade.netWorth(withoutTrade.players[player.id]);
		}

		const avgWith = withTradeTotal / rollouts;
		const avgWithout = withoutTradeTotal / rollouts;
		if (avgWithout <= 0) return avgWith >= 0;
		return avgWith >= avgWithout * genome.tradeFairnessMargin;
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
	//
	// Trade rework: proposeTrade rewritten to evaluate ALL opponent-owned properties/rails/
	// utilities by value-gap (not just the proposer's own near-complete monopoly), compose
	// offers that can include a property swap alongside/instead of cash, and consult a
	// per-opponent per-property tradeLedger (kept on the agent closure, see makeBotAgent) so a
	// second attempt at a previously-rejected target offers strictly more than the first.
	// Introduced tradeOfferMargin/tradeEscalationRate/tradePropertySwapWillingness as
	// manually-tuned starting points - NOT yet grid-searched, unlike every other parameter in
	// this genome. A future search round should sweep these three.
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
		tradeOfferMargin: 0.85,
		tradeEscalationRate: 0.25,
		tradePropertySwapWillingness: 0.6,
		mortgageBeforeSellHouse: false,
		riskAversion: 0.7,
		buildCheapGroupsFirst: true,
		keepJailCardLateGame: true,
		blockingAwareness: 0.0,
		sellHouseEvenly: true,
		groupScarcityPremium: 1.5,
		chaseLastPieceDrive: 1.8
	};

	const api = { DEFAULT_GENOME, BEST_GENOME, makeBotAgent, propertyValue, estimateAssetValue, countMonopolies, evaluateTrade, proposeTrade };

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = api;
	} else {
		root.MonopolyStrategy = api;
	}
})(typeof window !== 'undefined' ? window : globalThis);
