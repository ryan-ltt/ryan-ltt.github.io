/* The client/server seam.
 *
 * The UI never calls a Game method that mutates. It calls net.send(action, args)
 * and re-renders whatever state it is handed back. There are three
 * implementations of that one interface:
 *
 *   local  - single browser. Applies straight to an in-memory Game. Hot seat, so
 *            "who is sending" is whoever's turn it is.
 *   host   - single browser, but other people are watching. Same as local, plus
 *            it answers guests and pushes each of them their own redacted view.
 *   guest  - no Game of its own until a view arrives. Posts intents to the host.
 *
 * Every implementation exposes:
 *
 *   net.mode           'local' | 'host' | 'guest'
 *   net.authoritative  true when this browser holds the real Game (and so drives
 *                      the bots, holds the timer, and owns the randomness)
 *   net.seat           the seat this browser plays, or null for hot seat
 *   net.game()         the Game the UI should render
 *   net.send(a, args, cb)
 *   net.sync()         push the authoritative state out (after a bot moves)
 *   net.onUpdate(cb)   something changed that this browser did not ask for
 *   net.close()
 *
 * `host` and `guest` take a `link`, which is the only thing that knows about the
 * transport. See transport.js. */
window.CatanNet = (function () {
	'use strict';

	const G = window.CatanGame;
	const AI = window.CatanAI;

	/* Bots answer a trade offer the moment it is opened. This lives here rather
	 * than in ui.js because ai.js reads real hands, so it may only ever run where
	 * the real hands are. */
	function botsRespond(game) {
		if (!game.offer) return;
		game.players.forEach(function (p) {
			if (p.isBot && game.offer && game.offer.responses[p.id] === 'pending') {
				game.respondToOffer(p.id, AI.respond(game, p.id));
			}
		});
	}

	/* The one place an action is allowed to touch the state. Authorisation first,
	 * then the rules. */
	function apply(game, seat, action, args) {
		const auth = game.authorise(seat, action, args);
		if (!auth.ok) return auth;
		const result = game[action].apply(game, args || []);
		if (result && result.ok && action === 'openOffer') botsRespond(game);
		return result;
	}

	/* Hot seat has no seats, so the sender is inferred. The two out-of-turn
	 * actions name their player in the first argument; everything else is the
	 * current player by definition. */
	function senderFor(game, action, args) {
		if (action === 'discard' || action === 'respondToOffer') return Number((args || [])[0]);
		return game.current().id;
	}

	/* ---------------------------------------------------------------- local */

	function local(map, playerConfigs, options) {
		const game = new G.Game(map, playerConfigs, options);
		return {
			mode: 'local',
			authoritative: true,
			seat: null,
			game: function () { return game; },
			send: function (action, args, cb) {
				const result = apply(game, senderFor(game, action, args), action, args);
				if (cb) cb(result);
			},
			sync: function () {},
			onUpdate: function () {},
			close: function () {}
		};
	}

	/* ----------------------------------------------------------------- host */

	/* `link` must provide:
	 *   link.onAct(cb)            cb(seat, { id, action, args }) from a guest
	 *   link.onSeatChange(cb)     cb(seat, connected) - someone dropped or returned
	 *   link.sendView(seat, payload)
	 *   link.seats()              seats currently reachable (never the host's own)
	 *   link.close()
	 */
	function host(game, mySeat, link) {
		let updateCb = null;

		function pushViews(actor, ack, ackId) {
			link.seats().forEach(function (s) {
				const payload = { view: game.viewFor(s) };
				if (s === actor) {
					payload.result = ack;
					payload.id = ackId;
				}
				link.sendView(s, payload);
			});
		}

		link.onAct(function (seat, msg) {
			const result = apply(game, seat, msg.action, msg.args);
			pushViews(seat, result, msg.id);
			if (updateCb) updateCb();
		});

		/* A player who closes their tab must not freeze the table. Their seat keeps
		 * playing as a bot until they come back, which also covers the case where
		 * the game is waiting on them to discard. */
		link.onSeatChange(function (seat, connected) {
			const player = game.players[seat];
			if (!player || player.isBot === !connected) return;
			player.isBot = !connected;
			game.note(player.name + (connected ? ' is back' : ' dropped - a bot takes over'), 'warn');
			pushViews();
			if (updateCb) updateCb();
		});

		return {
			mode: 'host',
			authoritative: true,
			seat: mySeat,
			game: function () { return game; },
			send: function (action, args, cb) {
				const result = apply(game, mySeat, action, args);
				pushViews();
				if (cb) cb(result);
			},
			sync: pushViews,
			onUpdate: function (cb) { updateCb = cb; },
			close: function () { link.close(); }
		};
	}

	/* ---------------------------------------------------------------- guest */

	/* `link` must provide:
	 *   link.sendAct(msg)
	 *   link.onView(cb)     cb({ view, result, id })
	 *   link.close()
	 */
	function guest(mySeat, link) {
		let game = null;
		let updateCb = null;
		const pending = {};
		let nextId = 1;

		link.onView(function (payload) {
			if (payload.view) game = G.Game.fromJSON(payload.view);
			const cb = payload.id ? pending[payload.id] : null;
			if (cb) {
				delete pending[payload.id];
				cb(payload.result || { ok: true });
				return;
			}
			if (updateCb) updateCb();
		});

		return {
			mode: 'guest',
			authoritative: false,
			seat: mySeat,
			game: function () { return game; },
			send: function (action, args, cb) {
				const id = nextId++;
				if (cb) pending[id] = cb;
				link.sendAct({ id: id, action: action, args: args || [] });
			},
			sync: function () {},
			onUpdate: function (cb) { updateCb = cb; },
			close: function () { link.close(); }
		};
	}

	return { local: local, host: host, guest: guest, apply: apply, senderFor: senderFor };
})();
