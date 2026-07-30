/* Screen routing plus the new-game menu.
 *
 * Four screens live in the page at once and only one is visible: menu, editor,
 * lobby and game. The fragment says which one to open on load - #map=... (a
 * shared board) goes to the editor, #join=CODE goes to the lobby. */
(function () {
	'use strict';

	const M = window.CatanMap;
	const R = window.CatanRender;
	const Net = window.CatanNet;
	const Lobby = window.CatanLobby;

	const BOT_NAMES = ['ada', 'bram', 'cleo', 'dmitri', 'esther'];

	const menu = {
		choice: { kind: 'preset', id: 'standard' },
		map: null,
		players: [
			{ name: 'you', isBot: false },
			{ name: BOT_NAMES[0], isBot: true },
			{ name: BOT_NAMES[1], isBot: true }
		],
		targetVP: 0,
		specialBuild: null,   // null = auto (on from five players)
		message: ''
	};

	/* How many players a board can actually seat. The two-apart rule means a board
	 * runs out of settlement spots long before it runs out of hexes, and a table
	 * that outgrows its board does not just get cramped - it can deadlock with
	 * everyone a point or two short and nowhere left to build. */
	function seatsFor(map) {
		const hexes = map.hexes.length;
		if (hexes >= 30) return 6;
		if (hexes >= 19) return 4;
		if (hexes >= 12) return 3;
		return 2;
	}

	let els = {};

	function esc(text) {
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function init() {
		els = {
			menu: document.getElementById('screen-menu'),
			editor: document.getElementById('screen-editor'),
			lobby: document.getElementById('screen-lobby'),
			game: document.getElementById('screen-game'),
			setup: document.getElementById('menu-setup'),
			preview: document.getElementById('menu-preview')
		};
		els.setup.addEventListener('click', onMenuClick);
		els.setup.addEventListener('input', onMenuInput);
		Lobby.attach(lobbyHooks());

		const route = parseHash();
		menu.map = M.standardMap();
		if (menu.players[0].name === 'you' && Lobby.savedName()) menu.players[0].name = Lobby.savedName();

		if (route.kind === 'map') {
			showScreen('editor');
			window.CatanEditor.open(route.map, null, editorHooks());
		} else if (route.kind === 'join') {
			Lobby.join(route.code, Lobby.savedName());
		} else {
			showScreen('menu');
		}
		renderMenu();
		window.addEventListener('hashchange', onHashChange);
	}

	/* Pasting an invite link into the address bar of a page that is already open
	 * only changes the fragment - the document never reloads - so without this the
	 * link silently does nothing. Same for the back button. */
	function onHashChange() {
		const route = parseHash();
		if (route.kind === 'join' && route.code) {
			window.CatanUI.stop();
			Lobby.leave();
			return Lobby.join(route.code, Lobby.savedName());
		}
		if (route.kind === 'map') {
			window.CatanUI.stop();
			Lobby.leave();
			showScreen('editor');
			return window.CatanEditor.open(route.map, null, editorHooks());
		}
		if (!location.hash) {
			window.CatanUI.stop();
			Lobby.leave();
			showScreen('menu');
			renderMenu();
		}
	}

	/* One fragment, several meanings. Worth a real parse rather than a stack of
	 * indexOf checks - #replay= is the obvious next one. */
	function parseHash() {
		const hash = location.hash || '';
		if (hash.indexOf('#map=') === 0) {
			try {
				return { kind: 'map', map: M.decode(hash) };
			} catch (err) {
				return { kind: 'menu' };
			}
		}
		if (hash.indexOf('#join=') === 0) return { kind: 'join', code: hash.slice(6) };
		return { kind: 'menu' };
	}

	function showScreen(name) {
		['menu', 'editor', 'lobby', 'game'].forEach(function (key) {
			els[key].classList.toggle('is-visible', key === name);
		});
		window.scrollTo(0, 0);
	}

	function toMenu() {
		if (location.hash) history.replaceState(null, '', location.pathname + location.search);
		showScreen('menu');
		renderMenu();
	}

	function lobbyHooks() {
		return {
			onScreen: function () {
				showScreen('lobby');
			},
			onExit: toMenu,
			onNotice: function (text) {
				window.CatanUI.notice(text);
			},
			onGame: function (net, room) {
				showScreen('game');
				window.CatanUI.start(net, { onExit: toMenu, room: room });
			}
		};
	}

	function editorHooks() {
		return {
			onExit: function () {
				showScreen('menu');
				renderMenu();
			},
			onPlay: function (map) {
				menu.choice = { kind: 'custom', id: null };
				menu.map = map;
				showScreen('menu');
				menu.message = 'loaded "' + map.name + '" - pick your players and start';
				renderMenu();
			}
		};
	}

	/* ------------------------------------------------------------------ menu input */

	function onMenuInput(event) {
		const field = event.target;
		if (field.dataset.playerName !== undefined) {
			menu.players[Number(field.dataset.playerName)].name = field.value.slice(0, 16);
		}
	}

	function onMenuClick(event) {
		const button = event.target.closest('[data-act]');
		if (!button) return;
		const act = button.dataset.act;
		const value = button.dataset.value;
		menu.message = '';

		if (act === 'preset') {
			const preset = M.PRESETS.filter(function (p) {
				return p.id === value;
			})[0];
			menu.choice = { kind: 'preset', id: value };
			menu.map = preset.build();
			return renderMenu();
		}
		if (act === 'saved') {
			const record = M.getMap(value);
			if (record) {
				menu.choice = { kind: 'saved', id: value };
				menu.map = M.clone(record.map);
			}
			return renderMenu();
		}
		if (act === 'reroll') {
			if (menu.choice.kind === 'preset') {
				const preset = M.PRESETS.filter(function (p) {
					return p.id === menu.choice.id;
				})[0];
				menu.map = preset.build();
			} else {
				M.assignNumbers(menu.map);
			}
			return renderMenu();
		}
		if (act === 'edit') {
			showScreen('editor');
			window.CatanEditor.open(menu.map, menu.choice.kind === 'saved' ? menu.choice.id : null, editorHooks());
			return;
		}
		if (act === 'new-map') {
			showScreen('editor');
			window.CatanEditor.open(M.fromShape('my map', M.rowsShape([2, 3, 2])), null, editorHooks());
			return;
		}
		if (act === 'add-player') {
			if (menu.players.length >= 6) return;
			menu.players.push({ name: BOT_NAMES[(menu.players.length - 1) % BOT_NAMES.length], isBot: true });
			return renderMenu();
		}
		if (act === 'drop-player') {
			if (menu.players.length <= 2) return;
			menu.players.pop();
			return renderMenu();
		}
		if (act === 'toggle-bot') {
			const player = menu.players[Number(value)];
			player.isBot = !player.isBot;
			return renderMenu();
		}
		if (act === 'vp') {
			menu.targetVP = Number(value);
			return renderMenu();
		}
		if (act === 'special-build') {
			menu.specialBuild = value === 'auto' ? null : value === 'on';
			return renderMenu();
		}
		if (act === 'start') {
			const report = M.validate(menu.map);
			if (!report.ok) {
				menu.message = report.errors[0];
				return renderMenu();
			}
			showScreen('game');
			const net = Net.local(menu.map, menu.players.map(function (p) {
				return { name: p.name || 'player', isBot: p.isBot };
			}), gameOptions());
			window.CatanUI.start(net, { onExit: toMenu });
		}
		if (act === 'host') {
			const report = M.validate(menu.map);
			if (!report.ok) {
				menu.message = report.errors[0];
				return renderMenu();
			}
			return Lobby.host(menu.map, gameOptions(), menu.players[0].name);
		}
		if (act === 'join') return Lobby.join('', menu.players[0].name);
	}

	function gameOptions() {
		return { targetVP: menu.targetVP || undefined, specialBuild: menu.specialBuild };
	}

	/* ---------------------------------------------------------------- menu drawing */

	function renderMenu() {
		if (!menu.map) menu.map = M.standardMap();
		R.draw(els.preview, M.buildBoard(menu.map), { robber: menu.map.robber || undefined });
		els.setup.innerHTML = setupMarkup();
	}

	function setupMarkup() {
		const saved = M.loadAll();
		const report = M.validate(menu.map);
		let out = '';

		out += '<div class="block"><h3>board</h3><div class="btn-row btn-row--wrap">';
		M.PRESETS.forEach(function (preset) {
			const active = menu.choice.kind === 'preset' && menu.choice.id === preset.id;
			out += '<button class="btn btn--small' + (active ? ' is-active' : '') +
				'" data-act="preset" data-value="' + preset.id + '">' + esc(preset.id) + '</button>';
		});
		out += '</div>';
		if (saved.length) {
			out += '<p class="hint">your maps</p><div class="btn-row btn-row--wrap">';
			saved.forEach(function (record) {
				const active = menu.choice.kind === 'saved' && menu.choice.id === record.id;
				out += '<button class="btn btn--small' + (active ? ' is-active' : '') +
					'" data-act="saved" data-value="' + record.id + '">' + esc(record.name) + '</button>';
			});
			out += '</div>';
		}
		out += '<p class="hint">' + esc(menu.map.name) + ' &middot; ' + menu.map.hexes.length + ' hexes &middot; ' +
			menu.map.ports.length + ' ports</p>';
		out += '<div class="btn-row btn-row--wrap">' +
			'<button class="btn btn--small" data-act="reroll">reroll the numbers</button>' +
			'<button class="btn btn--small" data-act="edit">edit this map</button>' +
			'<button class="btn btn--small" data-act="new-map">draw a new map</button>' +
			'</div>';
		if (!report.ok) out += '<p class="hint bad">' + esc(report.errors[0]) + '</p>';
		out += '</div>';

		out += '<div class="block"><h3>players</h3>';
		menu.players.forEach(function (player, index) {
			const color = window.CatanGame.PLAYER_COLORS[index % window.CatanGame.PLAYER_COLORS.length];
			out += '<div class="player-setup">' +
				'<span class="swatch" style="background:' + color.fill + '"></span>' +
				'<input type="text" data-player-name="' + index + '" value="' + esc(player.name) + '" maxlength="16">' +
				'<button class="btn btn--small" data-act="toggle-bot" data-value="' + index + '">' +
				(player.isBot ? 'bot' : 'human') + '</button></div>';
		});
		out += '<div class="btn-row"><button class="btn btn--small" data-act="drop-player"' +
			(menu.players.length <= 2 ? ' disabled' : '') + '>fewer</button>' +
			'<button class="btn btn--small" data-act="add-player"' +
			(menu.players.length >= 6 ? ' disabled' : '') + '>more</button></div>';

		const seats = seatsFor(menu.map);
		if (menu.players.length > seats) {
			out += '<p class="hint warn">this board comfortably seats ' + seats + '. with ' +
				menu.players.length + ' the spots run out, and a game can stall with everyone ' +
				'a point or two short - the large board is the one for 5 and 6.</p>';
		}
		out += '</div>';

		out += '<div class="block"><h3>points to win</h3><div class="btn-row btn-row--wrap">';
		[0, 8, 10, 12].forEach(function (value) {
			out += '<button class="btn btn--small' + (menu.targetVP === value ? ' is-active' : '') +
				'" data-act="vp" data-value="' + value + '">' + (value === 0 ? 'auto (10)' : value) + '</button>';
		});
		out += '</div>';
		if (menu.targetVP === 12 && menu.players.length >= 5) {
			out += '<p class="hint warn">with five or six players the board fills before anyone ' +
				'gets near twelve - the game can end up unwinnable. ten is the rule for a big table.</p>';
		}
		out += '</div>';

		// The 5-6 player extension rule. Auto is what you want almost always; the
		// override is there because it plays well at four too.
		const autoOn = menu.players.length >= 5;
		const effective = menu.specialBuild === null ? autoOn : menu.specialBuild;
		out += '<div class="block"><h3>special build phase</h3><div class="btn-row btn-row--wrap">';
		[['auto', 'auto (' + (autoOn ? 'on' : 'off') + ')'], ['on', 'always'], ['off', 'never']].forEach(function (pair) {
			const active = pair[0] === 'auto' ? menu.specialBuild === null : menu.specialBuild === (pair[0] === 'on');
			out += '<button class="btn btn--small' + (active ? ' is-active' : '') +
				'" data-act="special-build" data-value="' + pair[0] + '">' + esc(pair[1]) + '</button>';
		});
		out += '</div><p class="hint">' + (effective
			? 'between turns, everyone else may build or buy before the next roll. no trading.'
			: 'off - you may only build on your own turn.') + '</p></div>';

		if (menu.message) out += '<p class="notice">' + esc(menu.message) + '</p>';
		out += '<button class="btn btn--primary btn--wide" data-act="start"' + (report.ok ? '' : ' disabled') + '>start the game</button>';

		// The map travels with the invite, so a board you drew is the board your
		// friends load - nothing to import at the other end.
		out += '<div class="block"><h3>play with friends</h3>' +
			(Lobby.available()
				? '<div class="btn-row">' +
					'<button class="btn btn--wide" data-act="host"' + (report.ok ? '' : ' disabled') + '>host a room</button>' +
					'<button class="btn btn--wide" data-act="join">join with a code</button></div>' +
					'<p class="hint">hosting sends friends a link with this board baked in. your browser ' +
					'runs the game, so keep the tab open.</p>'
				: '<p class="hint bad">multiplayer could not load - it needs a network connection ' +
					'and a page served over http, not opened from disk.</p>') +
			'</div>';
		return out;
	}

	document.addEventListener('DOMContentLoaded', init);
})();
