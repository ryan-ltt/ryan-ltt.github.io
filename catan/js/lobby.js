/* The lobby: a room code, a link to send friends, a roster that fills in, and
 * the handover into the game screen.
 *
 * The host is the authority. It holds the Game, seats arrivals, runs the bots
 * and pushes every other player a view with only their own cards in it. Guests
 * hold nothing until the first view lands.
 *
 * Identity is a token in localStorage, not a peer id - peer ids are regenerated
 * on every page load, so a refresh mid-game would otherwise arrive as a stranger
 * and be handed a new seat. With the token the host recognises them and hands
 * back the seat they left. */
window.CatanLobby = (function () {
	'use strict';

	const M = window.CatanMap;
	const G = window.CatanGame;
	const R = window.CatanRender;
	const Net = window.CatanNet;

	/* No 0/O/1/I - the code gets read aloud and typed in. */
	const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
	const CODE_LENGTH = 6;
	const TOKEN_KEY = 'catan-player-token';
	const NAME_KEY = 'catan-player-name';
	const MAX_SEATS = 6;
	const BOT_NAMES = ['ada', 'bram', 'cleo', 'dmitri', 'esther'];

	let state = null;
	let els = {};
	let hooks = {};

	function esc(text) {
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function store(key, value) {
		try {
			if (value === undefined) return localStorage.getItem(key);
			localStorage.setItem(key, value);
			return value;
		} catch (err) {
			return null;
		}
	}

	function token() {
		let value = store(TOKEN_KEY);
		if (!value) {
			value = 'p-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
			store(TOKEN_KEY, value);
		}
		return value;
	}

	function savedName() {
		return store(NAME_KEY) || '';
	}

	function newCode() {
		let out = '';
		const bytes = new Uint8Array(CODE_LENGTH);
		(window.crypto || window.msCrypto).getRandomValues(bytes);
		for (let i = 0; i < CODE_LENGTH; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
		return out;
	}

	function normaliseCode(raw) {
		return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LENGTH);
	}

	function joinLink(code) {
		return location.origin + location.pathname + '#join=' + code;
	}

	function available() {
		return !!(window.CatanTransport && window.CatanTransport.available);
	}

	/* Kept in step with seatsFor in main.js: a board runs out of settlement spots
	 * long before it runs out of hexes. */
	function seatsFor(map) {
		const hexes = map.hexes.length;
		if (hexes >= 30) return 6;
		if (hexes >= 19) return 4;
		if (hexes >= 12) return 3;
		return 2;
	}

	/* -------------------------------------------------------------- attaching */

	function attach(callbacks) {
		hooks = callbacks || {};
		els = {
			screen: document.getElementById('screen-lobby'),
			panel: document.getElementById('lobby-panel'),
			preview: document.getElementById('lobby-preview')
		};
		els.panel.addEventListener('click', onClick);
		els.panel.addEventListener('input', onInput);
	}

	/* Debug aid: the live room, so the console can inspect peer state. */
	function room() {
		return state && state.room;
	}

	function leave() {
		if (state && state.room) state.room.leave();
		state = null;
	}

	/* ------------------------------------------------------------------- host */

	function host(map, options, name) {
		if (!available()) return fail('multiplayer could not load - check your connection and reload');
		const code = newCode();
		const hostName = (name || savedName() || 'host').slice(0, 16);
		store(NAME_KEY, hostName);

		state = {
			role: 'host',
			code: code,
			map: M.clone(map),
			options: options || {},
			seats: [{ name: hostName, isBot: false, token: token(), peerId: null, connected: true }],
			peerSeats: {},
			started: false,
			net: null,
			actCb: null,
			seatChangeCb: null,
			message: 'share the link - the game starts when you say so',
			room: null
		};
		// Two open seats to begin with; the host can turn either into a bot.
		state.seats.push(openSeat(), openSeat());

		state.room = window.CatanTransport.open(code);
		state.room.on('hello', onHello);
		state.room.on('act', onAct);
		state.room.onPeerLeave(onPeerLeave);

		hooks.onScreen();
		render();
	}

	function openSeat() {
		return { name: '', isBot: false, token: null, peerId: null, connected: false };
	}

	function botSeat(index) {
		return {
			name: BOT_NAMES[(index - 1) % BOT_NAMES.length],
			isBot: true, token: null, peerId: null, connected: false
		};
	}

	function seatLabel(entry, index) {
		if (index === 0) return entry.name + ' (you, hosting)';
		if (entry.isBot) return entry.name + ' (bot)';
		if (entry.token) return entry.name + (entry.connected ? '' : ' - disconnected');
		return 'open - waiting for a friend';
	}

	/* A guest announcing itself, either for the first time or after a refresh. */
	function onHello(msg, peerId) {
		if (!state || state.role !== 'host' || !msg) return;
		const name = String(msg.name || 'player').slice(0, 16);
		let seat = seatForToken(msg.token, peerId);

		if (seat === null) {
			if (state.started) return sendRoster(peerId, null);
			seat = state.seats.findIndex(function (entry, i) {
				return i > 0 && !entry.isBot && !entry.token;
			});
			if (seat < 0) return sendRoster(peerId, null);
			state.seats[seat].token = claimToken(msg.token, peerId);
		}

		const entry = state.seats[seat];
		const alreadyHere = entry.connected;   // a duplicate hello, not a return
		entry.name = name;
		entry.peerId = peerId;
		entry.connected = true;
		state.peerSeats[peerId] = seat;

		sendRoster(peerId, seat);
		broadcastRoster();

		if (state.started) {
			// Undo the bot takeover from when they dropped, then catch them up.
			if (state.seatChangeCb && !alreadyHere) state.seatChangeCb(seat, true);
			if (state.net) state.net.sync();
		}
		render();
	}

	/* Which seat, if any, this hello is a *return* to.
	 *
	 * Two guards, both of which cost a game if they are missing. Seat 0 is the
	 * host's own seat and can never belong to a peer - it holds the host's token,
	 * so without this a guest sharing the host's browser profile is handed the
	 * host's seat and then never receives a view, because views only go to remote
	 * seats. And a token arriving from a second peer while the first is still
	 * connected is another tab, not a refresh, so it needs a seat of its own. */
	function seatForToken(value, peerId) {
		if (!value) return null;
		const index = state.seats.findIndex(function (entry, i) {
			if (i === 0 || entry.token !== value) return false;
			return !(entry.connected && entry.peerId && entry.peerId !== peerId);
		});
		return index < 0 ? null : index;
	}

	/* Keep tokens unique per seat, so the disambiguated one still reconnects. */
	function claimToken(value, peerId) {
		if (!value) return 'anon-' + peerId;
		const taken = state.seats.some(function (entry, i) {
			return i > 0 && entry.token === value;
		});
		return taken ? value + '#' + peerId : value;
	}

	function onAct(msg, peerId) {
		if (!state || state.role !== 'host' || !state.actCb) return;
		const seat = state.peerSeats[peerId];
		if (seat === undefined) return;
		state.actCb(seat, msg || {});
	}

	function onPeerLeave(peerId) {
		if (!state) return;
		if (state.role === 'guest') {
			if (peerId !== state.hostPeer) return;
			state.message = 'the host disconnected';
			// Mid-game the lobby panel is not on screen, so say it where they are
			// looking - otherwise the table just goes quiet and nobody knows why.
			if (state.inGame && hooks.onNotice) hooks.onNotice('the host closed their tab - this game is over');
			return render();
		}
		const seat = state.peerSeats[peerId];
		if (seat === undefined) return;
		delete state.peerSeats[peerId];
		const entry = state.seats[seat];
		entry.connected = false;
		entry.peerId = null;
		if (state.started) {
			if (state.seatChangeCb) state.seatChangeCb(seat, false);
		} else {
			// Nothing has started yet, so free the seat up again.
			entry.token = null;
			entry.name = '';
		}
		broadcastRoster();
		render();
	}

	function rosterPayload(seat) {
		return {
			code: state.code,
			hostName: state.seats[0].name,
			mapName: state.map.name,
			map: state.map,
			rules: rulesLabel(),
			started: state.started,
			seat: seat === undefined ? null : seat,
			seats: state.seats.map(function (entry, i) {
				return { name: seatLabel(entry, i), isBot: entry.isBot, connected: entry.connected || i === 0 };
			})
		};
	}

	/* What the table is playing, in one line, so guests are not surprised by the
	 * special build phase turning up between turns. */
	function rulesLabel() {
		const opts = state.options || {};
		const special = opts.specialBuild === undefined || opts.specialBuild === null
			? state.seats.length >= 5
			: !!opts.specialBuild;
		const vp = opts.targetVP || 10;
		return 'first to ' + vp + (special ? ' - special build phase on' : '');
	}

	function sendRoster(peerId, seat) {
		state.room.send('roster', rosterPayload(seat), peerId);
	}

	function broadcastRoster() {
		Object.keys(state.peerSeats).forEach(function (peerId) {
			sendRoster(peerId, state.peerSeats[peerId]);
		});
	}

	/* Seats that can actually receive a view: connected humans other than the
	 * host, who is looking at the real thing. */
	function remoteSeats() {
		return state.seats.map(function (entry, i) {
			return entry.connected && entry.peerId && i > 0 ? i : -1;
		}).filter(function (i) {
			return i >= 0;
		});
	}

	function startGame() {
		const report = M.validate(state.map);
		if (!report.ok) {
			state.message = report.errors[0];
			return render();
		}

		// An open seat nobody claimed becomes a bot rather than a phantom player.
		state.seats.forEach(function (entry, i) {
			if (i > 0 && !entry.isBot && !entry.token) {
				state.seats[i] = botSeat(i);
			}
		});

		const configs = state.seats.map(function (entry) {
			return { name: entry.name || 'player', isBot: entry.isBot };
		});
		const game = new G.Game(state.map, configs, state.options);

		// Anyone who claimed a seat but is not connected right now plays as a bot
		// until they turn up - same rule as a mid-game disconnect.
		state.seats.forEach(function (entry, i) {
			if (i > 0 && !entry.isBot && !entry.connected) game.players[i].isBot = true;
		});

		const link = {
			onAct: function (cb) { state.actCb = cb; },
			onSeatChange: function (cb) { state.seatChangeCb = cb; },
			sendView: function (seat, payload) {
				const entry = state.seats[seat];
				if (entry && entry.peerId) state.room.send('view', payload, entry.peerId);
			},
			seats: remoteSeats,
			close: leave
		};

		state.started = true;
		state.net = Net.host(game, 0, link);
		broadcastRoster();
		state.net.sync();

		hooks.onGame(state.net, { code: state.code, host: state.seats[0].name });
	}

	/* ------------------------------------------------------------------ guest */

	function join(code, name) {
		if (!available()) return fail('multiplayer could not load - check your connection and reload');

		state = {
			role: 'guest',
			code: normaliseCode(code),
			name: (name || savedName() || '').slice(0, 16),
			seat: null,
			roster: null,
			map: null,
			hostPeer: null,
			hostName: '',
			inGame: false,
			viewHandler: null,
			message: '',
			room: null
		};

		hooks.onScreen();

		if (!state.name || state.code.length !== CODE_LENGTH) return render();
		connect();
	}

	function connect() {
		store(NAME_KEY, state.name);
		state.message = 'looking for the room...';
		state.room = window.CatanTransport.open(state.code);
		state.room.on('roster', onRoster);
		state.room.on('view', onView);
		state.room.onPeerJoin(function () { sayHello(); });
		state.room.onPeerLeave(onPeerLeave);
		sayHello();
		render();
	}

	function sayHello() {
		if (!state || state.role !== 'guest' || !state.room) return;
		state.room.send('hello', { token: token(), name: state.name });
	}

	function onRoster(data, peerId) {
		if (!state || state.role !== 'guest' || !data) return;
		state.hostPeer = peerId;
		state.hostName = data.hostName;
		state.roster = data.seats;
		state.map = data.map;
		state.rules = data.rules;
		state.seat = data.seat === null || data.seat === undefined ? null : Number(data.seat);
		if (state.seat === null) {
			state.message = data.started ? 'that game has already started' : 'the table is full';
		} else {
			state.message = data.started ? 'joining...' : 'waiting for ' + data.hostName + ' to start';
		}
		if (!state.inGame) render();
	}

	/* The first view is also the "we have started" signal - it carries everything
	 * a guest needs, including the map, so there is nothing else to wait for. And
	 * on a mid-game refresh it is the reconnect too, with no special casing. */
	function onView(payload, peerId) {
		if (!state || state.role !== 'guest' || !payload) return;
		state.hostPeer = peerId;
		if (!state.inGame) enterGame();
		if (state.viewHandler) state.viewHandler(payload);
	}

	function enterGame() {
		const link = {
			sendAct: function (msg) { state.room.send('act', msg, state.hostPeer); },
			onView: function (cb) { state.viewHandler = cb; },
			close: leave
		};
		const net = Net.guest(state.seat, link);
		state.inGame = true;
		hooks.onGame(net, { code: state.code, host: state.hostName });
	}

	function fail(message) {
		state = { role: 'error', message: message, code: '', room: null };
		hooks.onScreen();
		render();
	}

	/* ------------------------------------------------------------------ input */

	function onInput(event) {
		if (!state) return;
		const field = event.target;
		if (field.dataset.field === 'name') state.name = field.value.slice(0, 16);
		if (field.dataset.field === 'code') state.code = normaliseCode(field.value);
	}

	function onClick(event) {
		const button = event.target.closest('[data-lobby]');
		if (!button || !state) return;
		const action = button.dataset.lobby;
		const value = button.dataset.value;

		if (action === 'exit') {
			leave();
			return hooks.onExit();
		}
		if (action === 'copy') {
			copy(joinLink(state.code));
			state.message = 'link copied';
			return render();
		}
		if (action === 'join-now') {
			if (state.code.length !== CODE_LENGTH) {
				state.message = 'a room code is ' + CODE_LENGTH + ' characters';
				return render();
			}
			if (!state.name) {
				state.message = 'a name first';
				return render();
			}
			return connect();
		}
		if (state.role !== 'host' || state.started) return;

		if (action === 'add-seat') {
			if (state.seats.length >= MAX_SEATS) return;
			state.seats.push(openSeat());
			broadcastRoster();
			return render();
		}
		if (action === 'drop-seat') {
			if (state.seats.length <= 2) return;
			const last = state.seats[state.seats.length - 1];
			if (last.token) return;
			state.seats.pop();
			broadcastRoster();
			return render();
		}
		if (action === 'toggle-seat') {
			const index = Number(value);
			const entry = state.seats[index];
			if (!entry || index === 0 || entry.token) return;
			state.seats[index] = entry.isBot ? openSeat() : botSeat(index);
			broadcastRoster();
			return render();
		}
		if (action === 'start') return startGame();
	}

	function copy(text) {
		if (navigator.clipboard) return navigator.clipboard.writeText(text).catch(function () {});
		const field = document.createElement('textarea');
		field.value = text;
		document.body.appendChild(field);
		field.select();
		try { document.execCommand('copy'); } catch (err) { /* nothing to do */ }
		document.body.removeChild(field);
	}

	/* ---------------------------------------------------------------- drawing */

	function render() {
		if (!state || !els.panel) return;
		const map = state.map;
		els.screen.classList.toggle('is-bare', !map);
		if (map) R.draw(els.preview, M.buildBoard(map), { robber: map.robber || undefined });
		else els.preview.innerHTML = '';
		els.panel.innerHTML = state.role === 'host' ? hostMarkup() : guestMarkup();
	}

	function linkBlock() {
		return '<div class="block"><h3>room code</h3>' +
			'<p class="room-code">' + esc(state.code) + '</p>' +
			'<p class="hint">' + esc(joinLink(state.code)) + '</p>' +
			'<button class="btn btn--wide" data-lobby="copy">copy the invite link</button></div>';
	}

	function hostMarkup() {
		let out = '<div class="panel-head">' +
			'<button class="btn btn--ghost" data-lobby="exit">back</button>' +
			'<span class="panel-head-vp">' + esc(state.map.name) + '</span></div>';
		out += linkBlock();

		out += '<div class="block"><h3>table</h3>';
		state.seats.forEach(function (entry, index) {
			const color = G.PLAYER_COLORS[index % G.PLAYER_COLORS.length];
			const locked = index === 0 || !!entry.token;
			out += '<div class="player-setup">' +
				'<span class="swatch" style="background:' + color.fill + '"></span>' +
				'<span class="seat-name' + (entry.token || index === 0 ? '' : ' seat-name--open') + '">' +
				esc(seatLabel(entry, index)) + '</span>' +
				(locked ? '' : '<button class="btn btn--small" data-lobby="toggle-seat" data-value="' + index + '">' +
					(entry.isBot ? 'bot' : 'open') + '</button>') +
				'</div>';
		});
		out += '<div class="btn-row">' +
			'<button class="btn btn--small" data-lobby="drop-seat"' + (state.seats.length <= 2 ? ' disabled' : '') + '>fewer</button>' +
			'<button class="btn btn--small" data-lobby="add-seat"' + (state.seats.length >= MAX_SEATS ? ' disabled' : '') + '>more</button>' +
			'</div>';
		out += '<p class="hint">' + esc(rulesLabel()) + '</p>';
		const seats = seatsFor(state.map);
		if (state.seats.length > seats) {
			out += '<p class="hint warn">this board comfortably seats ' + seats +
				' - go back and pick the large one for 5 or 6.</p>';
		}
		out += '</div>';

		out += '<p class="hint">you are hosting, so this tab runs the game: keep it open, ' +
			'and be aware it can see everyone&#39;s cards. background tabs get throttled by ' +
			'the browser, which will slow the bots to a crawl.</p>';
		if (state.message) out += '<p class="notice">' + esc(state.message) + '</p>';
		out += '<button class="btn btn--primary btn--wide" data-lobby="start">start the game</button>';
		return out;
	}

	function guestMarkup() {
		let out = '<div class="panel-head">' +
			'<button class="btn btn--ghost" data-lobby="exit">back</button>' +
			'<span class="panel-head-vp">' + esc(state.code || 'join a game') + '</span></div>';

		if (state.role === 'error') {
			return out + '<p class="notice">' + esc(state.message) + '</p>';
		}

		if (!state.room) {
			out += '<div class="block"><h3>join a game</h3>' +
				'<div class="player-setup"><input type="text" data-field="code" value="' +
				esc(state.code) + '" maxlength="6" placeholder="room code" class="code-input"></div>' +
				'<div class="player-setup"><input type="text" data-field="name" value="' +
				esc(state.name) + '" maxlength="16" placeholder="your name"></div>' +
				'<button class="btn btn--primary btn--wide" data-lobby="join-now">join</button></div>';
			if (state.message) out += '<p class="notice">' + esc(state.message) + '</p>';
			return out;
		}

		out += '<div class="block"><h3>table</h3>';
		if (!state.roster) {
			out += '<p class="hint">connecting to ' + esc(state.code) + '...</p>';
		} else {
			state.roster.forEach(function (entry, index) {
				const color = G.PLAYER_COLORS[index % G.PLAYER_COLORS.length];
				out += '<div class="player-setup">' +
					'<span class="swatch" style="background:' + color.fill + '"></span>' +
					'<span class="seat-name">' + esc(entry.name) +
					(index === state.seat ? ' - you' : '') + '</span></div>';
			});
		}
		if (state.rules) out += '<p class="hint">' + esc(state.rules) + '</p>';
		out += '</div>';
		if (state.message) out += '<p class="notice">' + esc(state.message) + '</p>';
		out += '<p class="hint">the host holds the game. if they close their tab, the game ends.</p>';
		return out;
	}

	return {
		attach: attach,
		host: host,
		join: join,
		leave: leave,
		available: available,
		room: room,
		joinLink: joinLink,
		savedName: savedName
	};
})();
