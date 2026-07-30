/* Game screen: draws the board and side panel from engine state and turns
 * clicks back into net calls. All rules live in game.js - this file only decides
 * what is worth showing and when the bots get to move.
 *
 * Nothing here mutates the game directly. Every action goes out through
 * `net.send`, which either applies it in this tab (single player, or hosting) or
 * posts it to whoever is hosting. `game` is therefore a *view*: the real thing
 * when authoritative, a redacted copy when a guest. */
window.CatanUI = (function () {
	'use strict';

	const M = window.CatanMap;
	const G = window.CatanGame;
	const AI = window.CatanAI;
	const R = window.CatanRender;

	const BOT_DELAY = 420;
	const MAX_BOT_STEPS = 60;

	let game = null;
	let net = null;
	let seat = null;       // the seat this browser plays, or null for hot seat
	let hooks = {};
	let els = {};
	let timer = null;
	let botSteps = 0;

	let ui = {
		mode: null,          // 'road' | 'settlement' | 'city' | null
		panel: null,         // 'trade' | 'cards' | null
		bankGive: null,
		bankGet: null,
		offer: { give: G.emptyResources(), want: G.emptyResources() },
		modal: null,
		message: ''
	};

	function esc(text) {
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function start(connection, callbacks) {
		hooks = callbacks || {};
		net = connection;
		seat = net.seat;
		game = net.game();
		ui = {
			mode: null, panel: null, bankGive: null, bankGet: null,
			offer: { give: G.emptyResources(), want: G.emptyResources() },
			modal: null, message: ''
		};
		els = {
			board: document.getElementById('game-board'),
			panel: document.getElementById('game-panel'),
			modal: document.getElementById('game-modal')
		};
		els.board.addEventListener('click', onBoardClick);
		els.panel.addEventListener('click', onPanelClick);
		els.modal.addEventListener('click', onModalClick);

		net.onUpdate(function () {
			update();
			if (net.authoritative) schedule(120);
		});

		update();
		schedule();
		return game;
	}

	function stop() {
		if (timer) clearTimeout(timer);
		timer = null;
		if (net) net.close();
		net = null;
		game = null;
	}

	/* Bots, and therefore the timer, only exist where the real state does. */
	function schedule(delay) {
		if (timer) clearTimeout(timer);
		timer = null;
		if (!net || !net.authoritative) return;
		timer = setTimeout(tick, delay === undefined ? BOT_DELAY : delay);
	}

	/* Send an intent and re-render on the answer. Guests answer over the network,
	 * so the callback may land a round trip later - or never, if the tab has
	 * moved on by then. */
	function send(action, args, cb) {
		if (!net) return;
		net.send(action, args, function (result) {
			if (!net) return;
			if (cb) cb(result || { ok: true });
			else report(result);
		});
	}

	/* Guests hold no state of their own, so a new view has to be picked up and
	 * anything it implies (a discard due, a finished game) acted on. Hosts run
	 * that logic in tick() instead, where the bots also live. */
	function update() {
		if (!net) return;
		if (!net.authoritative) {
			game = net.game();
			if (!game) return;
			if (!mine(game.current().id)) ui.mode = null;
			if (!ui.modal) {
				if (game.phase === 'over') ui.modal = { kind: 'gameover' };
				else openMyDiscard();
			}
		}
		render();
	}

	/* Whether this browser may act for a seat. Hot seat: anyone not a bot, which
	 * is exactly today's behaviour. Online: your own seat and nobody else's. */
	function mine(playerId) {
		if (!game || !game.players[playerId]) return false;
		if (seat === null) return !game.players[playerId].isBot;
		return playerId === seat;
	}

	/* Something happened outside the game worth saying out loud - the host closing
	 * their tab, mostly, which otherwise just looks like everyone going quiet. */
	function notice(text) {
		if (!net) return;
		ui.message = text;
		render();
	}

	function openMyDiscard() {
		if (!game || game.phase !== 'discard' || ui.modal) return false;
		const owed = Object.keys(game.pendingDiscards).map(Number).filter(mine);
		if (!owed.length) return false;
		ui.modal = { kind: 'discard', playerId: owed[0], picks: G.emptyResources() };
		return true;
	}

	/* --------------------------------------------------------------- bot driving */

	/* Bots act on the state directly rather than through net.send: they are the
	 * host's own code, running where the real hands are, so there is nobody to
	 * authorise them against. Each step is followed by a push to the guests. */
	function refresh() {
		net.sync();
		render();
	}

	function tick() {
		timer = null;
		if (!game || game.phase === 'over') {
			if (game && game.phase === 'over') openModal('gameover');
			return;
		}

		if (game.phase === 'discard') {
			const bot = Object.keys(game.pendingDiscards).map(Number).filter(function (id) {
				return game.players[id].isBot;
			})[0];
			if (bot !== undefined) {
				game.discard(bot, AI.discard(game, bot));
				refresh();
				schedule();
				return;
			}
			// Remote humans discard for themselves; their action reschedules us.
			if (openMyDiscard()) {
				render();
				return;
			}
			render();
			return;
		}

		const player = game.current();
		if (!player.isBot) {
			render();
			return;
		}

		if (game.phase === 'setup') {
			if (game.setupStep === 'settlement') game.placeSetupSettlement(AI.setupSettlement(game));
			else game.placeSetupRoad(AI.setupRoad(game));
			refresh();
			schedule();
			return;
		}

		if (game.phase === 'robber') {
			const choice = AI.robberChoice(game);
			game.moveRobber(choice.hex, choice.victim);
			refresh();
			schedule();
			return;
		}

		// 'build' is the special build phase between turns, where endTurn means
		// "done building" rather than "next player".
		if (game.phase === 'roll' || game.phase === 'main' || game.phase === 'build') {
			botSteps++;
			const wantsMore = botSteps < MAX_BOT_STEPS && AI.step(game);
			if (!wantsMore && game.canBuildNow()) {
				game.endTurn();
				botSteps = 0;
			}
			refresh();
			schedule();
			return;
		}

		render();
	}

	/* ---------------------------------------------------------------- board input */

	function onBoardClick(event) {
		const target = event.target.closest('[data-hex],[data-vertex],[data-edge]');
		if (!target || !game) return;
		if (!mine(game.current().id) && game.phase !== 'discard') return;

		if (target.dataset.vertex) handleVertex(target.dataset.vertex);
		else if (target.dataset.edge) handleEdge(target.dataset.edge);
		else if (target.dataset.hex) handleHex(target.dataset.hex);
	}

	function handleVertex(key) {
		if (game.phase === 'setup') return send('placeSetupSettlement', [key]);
		if (ui.mode === 'settlement' || ui.mode === 'city') {
			const action = ui.mode === 'city' ? 'buildCity' : 'buildSettlement';
			return send(action, [key], function (result) {
				if (result.ok) ui.mode = null;
				report(result);
			});
		}
	}

	function handleEdge(key) {
		if (game.phase === 'setup') return send('placeSetupRoad', [key]);
		if (ui.mode === 'road') {
			return send('buildRoad', [key], function (result) {
				if (result.ok && game.freeRoads === 0) ui.mode = null;
				report(result);
			});
		}
	}

	function handleHex(key) {
		if (game.phase !== 'robber') return;
		send('moveRobber', [key], function (result) {
			if (result.ok && result.chooseVictim) {
				openModal('steal', { candidates: result.chooseVictim });
				return;
			}
			report(result);
		});
	}

	function report(result) {
		if (!net) return;
		ui.message = result && !result.ok ? result.error : '';
		update();
		if (net.authoritative && result && result.ok) schedule(120);
	}

	/* ---------------------------------------------------------------- panel input */

	function onPanelClick(event) {
		const button = event.target.closest('[data-act]');
		if (!button || !game) return;
		const act = button.dataset.act;
		const value = button.dataset.value;

		if (act === 'quit') {
			stop();
			if (hooks.onExit) hooks.onExit();
			return;
		}
		if (act === 'roll') return send('rollDice');
		if (act === 'end-turn') {
			ui.mode = null;
			ui.panel = null;
			return send('endTurn');
		}
		if (act === 'mode') {
			ui.mode = ui.mode === value ? null : value;
			ui.message = '';
			return render();
		}
		if (act === 'panel') {
			ui.panel = ui.panel === value ? null : value;
			return render();
		}
		if (act === 'buy-dev') return send('buyDev');
		if (act === 'play-card') {
			if (value === 'yearOfPlenty') return openModal('yearOfPlenty', { picks: [] });
			if (value === 'monopoly') return openModal('monopoly');
			return send('playDev', [value], function (result) {
				if (result.ok && value === 'roadBuilding') ui.mode = 'road';
				report(result);
			});
		}
		if (act === 'bank-give') {
			ui.bankGive = ui.bankGive === value ? null : value;
			return render();
		}
		if (act === 'bank-get') {
			ui.bankGet = ui.bankGet === value ? null : value;
			return render();
		}
		if (act === 'bank-trade') {
			return send('tradeBank', [ui.bankGive, ui.bankGet], function (result) {
				if (result.ok) {
					ui.bankGive = null;
					ui.bankGet = null;
				}
				report(result);
			});
		}
		if (act === 'offer-adjust') {
			const parts = value.split(':');
			const side = ui.offer[parts[0]];
			side[parts[1]] = Math.max(0, Math.min(19, side[parts[1]] + Number(parts[2])));
			return render();
		}
		// Bot replies are the host's job now - see botsRespond in net.js.
		if (act === 'offer-send') return send('openOffer', [clone(ui.offer.give), clone(ui.offer.want)]);
		if (act === 'offer-cancel') {
			ui.offer = { give: G.emptyResources(), want: G.emptyResources() };
			return send('cancelOffer');
		}
		if (act === 'offer-respond') {
			const parts = value.split(':');
			return send('respondToOffer', [Number(parts[0]), parts[1] === 'yes']);
		}
		if (act === 'offer-accept') {
			return send('acceptTradeWith', [Number(value)], function (result) {
				if (result.ok) ui.offer = { give: G.emptyResources(), want: G.emptyResources() };
				report(result);
			});
		}
	}

	function clone(obj) {
		return JSON.parse(JSON.stringify(obj));
	}

	/* -------------------------------------------------------------------- modals */

	function openModal(kind, data) {
		ui.modal = Object.assign({ kind: kind }, data || {});
		render();
	}

	function closeModal() {
		ui.modal = null;
		render();
		schedule(120);
	}

	function onModalClick(event) {
		const button = event.target.closest('[data-modal]');
		if (!button || !ui.modal) return;
		const act = button.dataset.modal;
		const value = button.dataset.value;

		if (act === 'discard-adjust') {
			const parts = value.split(':');
			const player = game.players[ui.modal.playerId];
			const next = ui.modal.picks[parts[0]] + Number(parts[1]);
			if (next >= 0 && next <= player.resources[parts[0]]) ui.modal.picks[parts[0]] = next;
			return render();
		}
		if (act === 'discard-confirm') {
			return send('discard', [ui.modal.playerId, clone(ui.modal.picks)], function (result) {
				if (!result.ok) {
					ui.message = result.error;
					return render();
				}
				return closeModal();
			});
		}
		if (act === 'steal') {
			return send('chooseVictim', [Number(value)], function () {
				closeModal();
			});
		}
		if (act === 'monopoly') {
			return send('playDev', ['monopoly', { resource: value }], function () {
				closeModal();
			});
		}
		if (act === 'yop-pick') {
			ui.modal.picks.push(value);
			if (ui.modal.picks.length < 2) return render();
			const picks = ui.modal.picks;
			return send('playDev', ['yearOfPlenty', { resources: picks }], function (result) {
				if (!result.ok) {
					ui.message = result.error;
					if (ui.modal) ui.modal.picks = [];
					return render();
				}
				return closeModal();
			});
		}
		if (act === 'yop-cancel') return closeModal();
		if (act === 'exit') {
			stop();
			if (hooks.onExit) hooks.onExit();
		}
	}

	/* -------------------------------------------------------------------- drawing */

	function render() {
		if (!game) return;
		drawBoard();
		els.panel.innerHTML = panelMarkup();
		els.modal.innerHTML = modalMarkup();
		els.modal.classList.toggle('is-open', !!ui.modal);
	}

	function drawBoard() {
		const player = game.current();
		const human = mine(player.id);
		const opts = { robber: game.robber, game: game };

		if (game.phase === 'setup' && human) {
			if (game.setupStep === 'settlement') opts.vertexTargets = game.legalSetupSettlements();
			else opts.edgeTargets = game.legalSetupRoads();
		} else if (game.phase === 'robber' && human) {
			opts.hexTargets = Object.keys(game.board.hexes).filter(function (key) {
				return key !== game.robber;
			});
		} else if (human && game.canBuildNow()) {
			if (ui.mode === 'road') opts.edgeTargets = game.legalRoads(player.id);
			if (ui.mode === 'settlement') opts.vertexTargets = game.legalSettlements(player.id);
			if (ui.mode === 'city') opts.vertexTargets = game.legalCities(player.id);
		}

		R.draw(els.board, game.board, opts);
	}

	function panelMarkup() {
		const player = game.current();
		return [
			'<div class="panel-head">',
			'<button class="btn btn--ghost" data-act="quit">leave game</button>',
			roomMarkup(),
			'<span class="panel-head-vp">first to ' + game.targetVP + '</span>',
			'</div>',
			turnMarkup(player),
			ui.message ? '<p class="notice">' + esc(ui.message) + '</p>' : '',
			handBlock(player),
			mine(player.id) ? actionsMarkup(player) : '',
			offerMarkup(),
			playersMarkup(),
			logMarkup()
		].join('');
	}

	/* Hosting is worth stating plainly: the host's browser holds every hand, and
	 * closing the tab ends the game for everyone. */
	function roomMarkup() {
		if (!hooks.room) return '';
		return '<span class="panel-head-room" title="' +
			(net.mode === 'host'
				? 'you are hosting - keep this tab open, and you can see everyone&#39;s cards'
				: 'hosted by ' + esc(hooks.room.host || 'another player')) + '">' +
			esc(hooks.room.code) + (net.mode === 'host' ? ' &middot; hosting' : '') + '</span>';
	}

	function turnMarkup(player) {
		const dice = game.dice
			? '<span class="dice">' + game.dice[0] + ' + ' + game.dice[1] + ' = ' + (game.dice[0] + game.dice[1]) + '</span>'
			: '';
		// During the special build phase the turn bar follows whoever is building,
		// so it has to say whose turn it still actually is.
		const aside = game.phase === 'build'
			? '<span class="turn-tag">special build &middot; ' + esc(game.activePlayer().name) + "'s turn</span>"
			: '';
		return '<div class="turn-bar" style="border-left-color:' + player.fill + '">' +
			'<span class="swatch" style="background:' + player.fill + '"></span>' +
			'<span class="turn-name">' + esc(player.name) + (player.isBot ? ' <em>(bot)</em>' : '') + '</span>' +
			dice + aside +
			'<span class="turn-prompt">' + esc(prompt(player)) + '</span>' +
			'</div>';
	}

	function prompt(player) {
		const yours = mine(player.id);
		if (game.phase === 'over') return game.players[game.winner].name + ' wins';
		if (game.phase === 'discard') {
			if (seat === null) return 'discarding down to half';
			return game.pendingDiscards[seat] ? 'pick cards to discard' : 'waiting on the discards';
		}
		if (game.phase === 'robber') return yours ? 'click a hex to move the robber' : 'moving the robber';
		if (game.phase === 'setup') {
			if (!yours) return 'setting up';
			return game.setupStep === 'settlement' ? 'click a spot to settle' : 'click an edge for your first road';
		}
		if (game.phase === 'roll') return yours ? 'roll the dice' : (player.isBot ? 'thinking' : 'waiting on the roll');
		if (yours && ui.mode) return 'click a highlighted spot to build a ' + ui.mode;
		if (game.phase === 'build') {
			if (yours) return 'build or buy before the next roll - no trading';
			return player.isBot ? 'considering a build' : 'taking their special build';
		}
		if (yours) return 'build, trade, or end your turn';
		return player.isBot ? 'taking a turn' : 'taking their turn';
	}

	/* Online you always look at your own hand. At one keyboard a lone human still
	 * wants theirs while the bots play, but with several humans nothing is shown
	 * off-turn so hands stay private. */
	function handBlock(player) {
		if (seat !== null) return handMarkup(game.players[seat], 'your hand');
		if (!player.isBot) return handMarkup(player, 'your hand');
		const humans = game.players.filter(function (p) {
			return !p.isBot;
		});
		if (humans.length !== 1) return '';
		return handMarkup(humans[0], esc(humans[0].name) + "'s hand");
	}

	function handMarkup(player, title) {
		const chips = M.RESOURCES.map(function (res) {
			const meta = M.RESOURCE_META[res];
			const count = player.resources[res];
			const ratio = game.tradeRatio(player, res);
			return '<span class="chip' + (count ? '' : ' chip--empty') + '" title="' + res + ' - trades ' + ratio + ':1">' +
				'<span class="chip-dot" style="background:' + meta.color + '"></span>' +
				esc(res) + ' <b>' + count + '</b>' +
				(ratio < 4 ? '<i>' + ratio + ':1</i>' : '') +
				'</span>';
		}).join('');
		return '<div class="block"><h3>' + title + ' <small>' + G.countCards(player.resources) + ' cards</small></h3>' +
			'<div class="chips">' + chips + '</div></div>';
	}

	function actionsMarkup(player) {
		if (game.phase === 'over') {
			return '<div class="block"><button class="btn btn--primary" data-act="quit">back to the menu</button></div>';
		}
		if (game.phase === 'setup' || game.phase === 'discard') return '';
		if (game.phase === 'robber') return '';

		let out = '<div class="block">';
		if (game.phase === 'roll') {
			out += '<button class="btn btn--primary btn--wide" data-act="roll">roll the dice</button>';
			if (player.dev.knight > 0 && !game.playedDevThisTurn) {
				out += '<button class="btn btn--wide" data-act="play-card" data-value="knight">play a knight first</button>';
			}
			return out + '</div>';
		}

		// The special build phase buys the same four things and nothing else: no
		// trading, no playing cards, so those controls are simply absent rather
		// than present and refusing.
		const special = game.phase === 'build';
		if (special) {
			out += '<p class="hint">special build - you can buy, but not trade or play cards. ' +
				'anything you buy now is playable on your own turn.</p>';
		}

		const buildable = [
			{ mode: 'road', label: 'road', cost: G.COSTS.road, free: !special && game.freeRoads > 0 },
			{ mode: 'settlement', label: 'settlement', cost: G.COSTS.settlement },
			{ mode: 'city', label: 'city', cost: G.COSTS.city }
		];
		out += '<div class="btn-grid">';
		buildable.forEach(function (item) {
			const affordable = item.free || G.canAfford(player.resources, item.cost);
			const active = ui.mode === item.mode ? ' is-active' : '';
			out += '<button class="btn btn--build' + active + '" data-act="mode" data-value="' + item.mode + '"' +
				(affordable ? '' : ' disabled') + '>' +
				esc(item.label) + '<small>' + (item.free ? 'free' : esc(G.costLabel(item.cost))) + '</small></button>';
		});
		const canBuy = game.deckCount() && G.canAfford(player.resources, G.COSTS.dev);
		out += '<button class="btn btn--build" data-act="buy-dev"' + (canBuy ? '' : ' disabled') + '>' +
			'card<small>' + esc(G.costLabel(G.COSTS.dev)) + '</small></button>';
		out += '</div>';

		out += '<div class="btn-row">';
		if (!special) {
			out += '<button class="btn' + (ui.panel === 'trade' ? ' is-active' : '') + '" data-act="panel" data-value="trade">trade</button>';
			out += '<button class="btn' + (ui.panel === 'cards' ? ' is-active' : '') + '" data-act="panel" data-value="cards">' +
				'cards <b>' + G.devTotal(player) + '</b></button>';
		}
		out += '<button class="btn btn--primary" data-act="end-turn">' +
			(special ? 'done building' : 'end turn') + '</button>';
		out += '</div>';

		if (!special && ui.panel === 'trade') out += tradeMarkup(player);
		if (!special && ui.panel === 'cards') out += cardsMarkup(player);
		return out + '</div>';
	}

	function tradeMarkup(player) {
		let out = '<div class="sub-block"><h4>trade with the bank</h4><p class="hint">give</p><div class="pick-row">';
		M.RESOURCES.forEach(function (res) {
			const ratio = game.tradeRatio(player, res);
			const enabled = player.resources[res] >= ratio;
			out += '<button class="pick' + (ui.bankGive === res ? ' is-active' : '') + '" data-act="bank-give" data-value="' +
				res + '"' + (enabled ? '' : ' disabled') + '>' +
				'<span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' +
				esc(res) + '<i>' + ratio + ':1</i></button>';
		});
		out += '</div><p class="hint">receive</p><div class="pick-row">';
		M.RESOURCES.forEach(function (res) {
			out += '<button class="pick' + (ui.bankGet === res ? ' is-active' : '') + '" data-act="bank-get" data-value="' +
				res + '"' + (game.bank[res] ? '' : ' disabled') + '>' +
				'<span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' +
				esc(res) + '</button>';
		});
		out += '</div><button class="btn btn--wide" data-act="bank-trade"' +
			(ui.bankGive && ui.bankGet && ui.bankGive !== ui.bankGet ? '' : ' disabled') + '>make the trade</button>';

		out += '<h4>offer a trade</h4><table class="trade-table"><tr><th></th><th>you give</th><th>you want</th></tr>';
		M.RESOURCES.forEach(function (res) {
			out += '<tr><td><span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' + esc(res) + '</td>';
			['give', 'want'].forEach(function (side) {
				out += '<td class="stepper">' +
					'<button data-act="offer-adjust" data-value="' + side + ':' + res + ':-1">-</button>' +
					'<b>' + ui.offer[side][res] + '</b>' +
					'<button data-act="offer-adjust" data-value="' + side + ':' + res + ':1">+</button></td>';
			});
			out += '</tr>';
		});
		out += '</table><button class="btn btn--wide" data-act="offer-send">send the offer</button></div>';
		return out;
	}

	function cardsMarkup(player) {
		const rows = Object.keys(G.DEV_LABELS).map(function (key) {
			const ready = player.dev[key];
			const pending = player.devPending[key];
			if (!ready && !pending) return '';
			const label = G.DEV_LABELS[key];
			let line = '<div class="card-row"><span>' + esc(label) + ' <b>x' + (ready + pending) + '</b></span>';
			if (key === 'victoryPoint') line += '<em>counts towards victory</em>';
			else if (pending && !ready) line += '<em>playable next turn</em>';
			else if (game.playedDevThisTurn) line += '<em>one card per turn</em>';
			else line += '<button class="btn btn--small" data-act="play-card" data-value="' + key + '">play</button>';
			return line + '</div>';
		}).join('');
		return '<div class="sub-block"><h4>development cards</h4>' +
			(rows || '<p class="hint">no cards yet</p>') +
			'<p class="hint">' + game.deckCount() + ' left in the deck</p></div>';
	}

	function offerMarkup() {
		const offer = game.offer;
		if (!offer) return '';
		const from = game.players[offer.from];
		let out = '<div class="block block--offer"><h3>open offer</h3>' +
			'<p>' + esc(from.name) + ' gives <b>' + esc(G.describe(offer.give)) + '</b> for <b>' +
			esc(G.describe(offer.want)) + '</b></p>';

		Object.keys(offer.responses).map(Number).forEach(function (id) {
			const other = game.players[id];
			const state = offer.responses[id];
			out += '<div class="card-row"><span><span class="swatch" style="background:' + other.fill + '"></span>' +
				esc(other.name) + '</span>';
			if (state === 'pending' && mine(id)) {
				out += '<span><button class="btn btn--small" data-act="offer-respond" data-value="' + id + ':yes">accept</button>' +
					'<button class="btn btn--small" data-act="offer-respond" data-value="' + id + ':no">pass</button></span>';
			} else if (state === 'accept') {
				// Only the player who made the offer gets to close it.
				out += mine(offer.from)
					? '<button class="btn btn--small btn--primary" data-act="offer-accept" data-value="' + id + '">trade</button>'
					: '<em>accepted</em>';
			} else {
				out += '<em>' + (state === 'pending' ? 'waiting' : 'passed') + '</em>';
			}
			out += '</div>';
		});
		if (mine(offer.from)) out += '<button class="btn btn--small" data-act="offer-cancel">withdraw</button>';
		return out + '</div>';
	}

	function playersMarkup() {
		const rows = game.players.map(function (p) {
			const isCurrent = p.id === game.current().id;
			const badges = [];
			if (game.longestRoadHolder === p.id) badges.push('longest road');
			if (game.largestArmy === p.id) badges.push('largest army');
			return '<div class="player-row' + (isCurrent ? ' is-current' : '') + '">' +
				'<span class="swatch" style="background:' + p.fill + '"></span>' +
				'<span class="player-name">' + esc(p.name) +
				(p.id === seat ? ' <em>(you)</em>' : p.isBot ? ' <em>(bot)</em>' : '') + '</span>' +
				'<span class="player-stats">' +
				'<b title="victory points">' + game.publicPoints(p) + ' vp</b>' +
				'<i title="resource cards">' + G.handSize(p) + ' cards</i>' +
				'<i title="knights played">' + p.knightsPlayed + ' kn</i>' +
				'<i title="longest road">' + p.longestRoad + ' rd</i>' +
				'</span>' +
				(badges.length ? '<span class="badges">' + badges.map(esc).join(' &middot; ') + '</span>' : '') +
				'</div>';
		}).join('');
		return '<div class="block"><h3>players</h3>' + rows +
			'<p class="hint">points shown exclude hidden victory point cards</p></div>';
	}

	function logMarkup() {
		const entries = game.log.slice(-40).reverse().map(function (entry) {
			return '<li class="log-' + entry.kind + '">' + esc(entry.text) + '</li>';
		}).join('');
		return '<div class="block"><h3>log</h3><ul class="log">' + entries + '</ul></div>';
	}

	/* -------------------------------------------------------------- modal markup */

	function modalMarkup() {
		if (!ui.modal) return '';
		const kind = ui.modal.kind;

		if (kind === 'discard') {
			const player = game.players[ui.modal.playerId];
			const needed = game.pendingDiscards[ui.modal.playerId];
			const chosen = G.countCards(ui.modal.picks);
			let rows = '';
			M.RESOURCES.forEach(function (res) {
				rows += '<tr><td><span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' +
					esc(res) + ' <small>have ' + player.resources[res] + '</small></td>' +
					'<td class="stepper"><button data-modal="discard-adjust" data-value="' + res + ':-1">-</button>' +
					'<b>' + ui.modal.picks[res] + '</b>' +
					'<button data-modal="discard-adjust" data-value="' + res + ':1">+</button></td></tr>';
			});
			return dialog('the robber takes his cut',
				'<p>' + esc(player.name) + ' must discard <b>' + needed + '</b> of ' +
				G.countCards(player.resources) + ' cards.</p><table class="trade-table">' + rows + '</table>' +
				'<button class="btn btn--primary btn--wide" data-modal="discard-confirm"' +
				(chosen === needed ? '' : ' disabled') + '>discard ' + chosen + ' / ' + needed + '</button>');
		}

		if (kind === 'steal') {
			const buttons = ui.modal.candidates.map(function (id) {
				const p = game.players[id];
				return '<button class="btn btn--wide" data-modal="steal" data-value="' + id + '">' +
					'<span class="swatch" style="background:' + p.fill + '"></span>' + esc(p.name) +
					' <small>' + G.handSize(p) + ' cards</small></button>';
			}).join('');
			return dialog('steal from whom?', buttons);
		}

		if (kind === 'monopoly') {
			const buttons = M.RESOURCES.map(function (res) {
				return '<button class="btn btn--wide" data-modal="monopoly" data-value="' + res + '">' +
					'<span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' + esc(res) + '</button>';
			}).join('');
			return dialog('monopoly - take every card of one kind', buttons);
		}

		if (kind === 'yearOfPlenty') {
			const buttons = M.RESOURCES.map(function (res) {
				return '<button class="btn btn--wide" data-modal="yop-pick" data-value="' + res + '"' +
					(game.bank[res] ? '' : ' disabled') + '>' +
					'<span class="chip-dot" style="background:' + M.RESOURCE_META[res].color + '"></span>' + esc(res) +
					' <small>' + game.bank[res] + ' in the bank</small></button>';
			}).join('');
			return dialog('year of plenty - pick two cards',
				'<p class="hint">picked: ' + (ui.modal.picks.join(', ') || 'nothing yet') + '</p>' + buttons +
				'<button class="btn" data-modal="yop-cancel">cancel</button>');
		}

		if (kind === 'gameover') {
			const winner = game.players[game.winner];
			const table = game.players.slice().sort(function (a, b) {
				return game.points(b) - game.points(a);
			}).map(function (p) {
				return '<div class="card-row"><span><span class="swatch" style="background:' + p.fill + '"></span>' +
					esc(p.name) + '</span><b>' + game.points(p) + ' vp</b></div>';
			}).join('');
			return dialog(winner.name + ' wins', table +
				'<button class="btn btn--primary btn--wide" data-modal="exit">back to the menu</button>');
		}

		return '';
	}

	function dialog(title, body) {
		return '<div class="dialog"><h2>' + esc(title) + '</h2>' + body + '</div>';
	}

	return { start: start, stop: stop, notice: notice };
})();
