// Human agent: implements the same decide* interface as bot agents, but every method
// returns a Promise that resolves when the UI reports the player's choice. The UI module
// (ui.js) calls `resolve*` methods to fulfill whichever decision is currently pending.

(function (root) {
	'use strict';

	class HumanAgent {
		constructor(onNeedDecision) {
			// onNeedDecision(kind, ctx) is called by the engine-facing wrapper below whenever
			// a decision is needed; the UI is responsible for calling the matching resolve method.
			this.onNeedDecision = onNeedDecision;
			this._pending = null; // { resolve, kind, ctx }
		}

		_wait(kind, ctx) {
			return new Promise(resolve => {
				this._pending = { resolve, kind, ctx };
				this.onNeedDecision(kind, ctx);
			});
		}

		resolve(kind, value) {
			if (!this._pending || this._pending.kind !== kind) return false;
			const { resolve } = this._pending;
			this._pending = null;
			resolve(value);
			return true;
		}

		decideRoll(ctx) { return this._wait('roll', ctx); }
		decideBuyProperty(ctx) { return this._wait('buyProperty', ctx); }
		decideAuctionBid(ctx) { return this._wait('auctionBid', ctx); }
		decideJail(ctx) { return this._wait('jail', ctx); }
		decideLiquidation(ctx) { return this._wait('liquidation', ctx); }
		decideAction(ctx) { return this._wait('action', ctx); }
		decideTradeResponse(ctx) { return this._wait('tradeResponse', ctx); }
	}

	if (typeof module !== 'undefined' && module.exports) {
		module.exports = { HumanAgent };
	} else {
		root.MonopolyHumanAgent = { HumanAgent };
	}
})(typeof window !== 'undefined' ? window : globalThis);
