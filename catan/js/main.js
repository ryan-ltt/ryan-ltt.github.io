/* Screen routing plus the new-game menu.
 *
 * Three screens live in the page at once and only one is visible: menu, editor
 * and game. A #map=... fragment (from a shared link) opens straight into the
 * editor with that map loaded. */
(function () {
	'use strict';

	const M = window.CatanMap;
	const R = window.CatanRender;

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
		message: ''
	};

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
			game: document.getElementById('screen-game'),
			setup: document.getElementById('menu-setup'),
			preview: document.getElementById('menu-preview')
		};
		els.setup.addEventListener('click', onMenuClick);
		els.setup.addEventListener('input', onMenuInput);

		const shared = readSharedMap();
		menu.map = M.standardMap();

		if (shared) {
			showScreen('editor');
			window.CatanEditor.open(shared, null, editorHooks());
		} else {
			showScreen('menu');
		}
		renderMenu();
	}

	function readSharedMap() {
		if (location.hash.indexOf('#map=') !== 0) return null;
		try {
			return M.decode(location.hash);
		} catch (err) {
			return null;
		}
	}

	function showScreen(name) {
		['menu', 'editor', 'game'].forEach(function (key) {
			els[key].classList.toggle('is-visible', key === name);
		});
		window.scrollTo(0, 0);
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
		if (act === 'start') {
			const report = M.validate(menu.map);
			if (!report.ok) {
				menu.message = report.errors[0];
				return renderMenu();
			}
			showScreen('game');
			window.CatanUI.start(menu.map, menu.players.map(function (p) {
				return { name: p.name || 'player', isBot: p.isBot };
			}), { targetVP: menu.targetVP || undefined }, {
				onExit: function () {
					showScreen('menu');
					renderMenu();
				}
			});
		}
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
			(menu.players.length >= 6 ? ' disabled' : '') + '>more</button></div></div>';

		const autoVP = menu.map.hexes.length > 24 ? 12 : 10;
		out += '<div class="block"><h3>points to win</h3><div class="btn-row btn-row--wrap">';
		[0, 8, 10, 12].forEach(function (value) {
			out += '<button class="btn btn--small' + (menu.targetVP === value ? ' is-active' : '') +
				'" data-act="vp" data-value="' + value + '">' + (value === 0 ? 'auto (' + autoVP + ')' : value) + '</button>';
		});
		out += '</div></div>';

		if (menu.message) out += '<p class="notice">' + esc(menu.message) + '</p>';
		out += '<button class="btn btn--primary btn--wide" data-act="start"' + (report.ok ? '' : ' disabled') + '>start the game</button>';
		return out;
	}

	document.addEventListener('DOMContentLoaded', init);
})();
