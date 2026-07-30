/* Map editor. Pick a tool, click the board.
 *
 * The map being edited is the same plain-JSON shape the game consumes, so
 * "play this map" hands the object straight to the engine with no conversion. */
window.CatanEditor = (function () {
	'use strict';

	const H = window.CatanHex;
	const M = window.CatanMap;
	const R = window.CatanRender;

	const TOOLS = [
		{ id: 'terrain', label: 'terrain', hint: 'click a hex to paint it, or click the water to grow the board' },
		{ id: 'number', label: 'numbers', hint: 'click a hex to give it the selected number token' },
		{ id: 'port', label: 'ports', hint: 'click a coastline edge to put a port there' },
		{ id: 'robber', label: 'robber', hint: 'click a hex to choose where the robber starts' },
		{ id: 'erase', label: 'erase', hint: 'click a hex to remove it from the map' }
	];

	let state = null;
	let hooks = {};
	let els = {};

	function esc(text) {
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function open(map, savedId, callbacks) {
		hooks = callbacks || {};
		state = {
			map: M.clone(map),
			savedId: savedId || null,
			tool: 'terrain',
			terrain: 'forest',
			number: 6,
			portType: '3:1',
			modal: null,
			message: ''
		};
		els = {
			board: document.getElementById('editor-board'),
			panel: document.getElementById('editor-panel'),
			modal: document.getElementById('editor-modal')
		};
		if (!els.board.dataset.wired) {
			els.board.addEventListener('click', onBoardClick);
			els.panel.addEventListener('click', onPanelClick);
			els.panel.addEventListener('input', onPanelInput);
			els.modal.addEventListener('click', onModalClick);
			els.board.dataset.wired = 'yes';
		}
		render();
	}

	/* ---------------------------------------------------------------- board input */

	function onBoardClick(event) {
		const target = event.target.closest('[data-hex],[data-add],[data-coast],[data-port]');
		if (!target || !state) return;
		state.message = '';

		if (target.dataset.add) {
			const pos = H.parseHexKey(target.dataset.add);
			if (state.tool === 'erase') return;
			M.addHex(state.map, pos.q, pos.r, state.tool === 'terrain' ? state.terrain : 'desert');
			return render();
		}
		if (target.dataset.coast) {
			const parts = target.dataset.coast.split(',').map(Number);
			return setPort(parts[0], parts[1], parts[2]);
		}
		if (target.dataset.port !== undefined && state.tool === 'port') {
			const port = state.map.ports[Number(target.dataset.port)];
			if (port) setPort(port.q, port.r, port.edge);
			return;
		}
		if (target.dataset.hex) return onHex(target.dataset.hex);
	}

	function onHex(key) {
		const pos = H.parseHexKey(key);
		const hex = M.hexAt(state.map, pos.q, pos.r);
		if (!hex) return;

		if (state.tool === 'terrain') {
			hex.terrain = state.terrain;
			if (hex.terrain === 'desert') hex.number = null;
			if (hex.terrain !== 'desert' && !hex.number) hex.number = state.number;
		} else if (state.tool === 'number') {
			if (hex.terrain === 'desert') state.message = 'deserts never produce, so they carry no number';
			else hex.number = state.number;
		} else if (state.tool === 'robber') {
			state.map.robber = key;
		} else if (state.tool === 'erase') {
			M.removeHex(state.map, pos.q, pos.r);
		}
		render();
	}

	function setPort(q, r, edge) {
		state.map.ports = state.map.ports.filter(function (p) {
			return H.hexEdgeKey(p.q, p.r, p.edge) !== H.hexEdgeKey(q, r, edge);
		});
		if (state.portType !== 'none') state.map.ports.push({ q: q, r: r, edge: edge, type: state.portType });
		render();
	}

	/* ---------------------------------------------------------------- panel input */

	function onPanelInput(event) {
		if (event.target.id === 'map-name') state.map.name = event.target.value.slice(0, 60) || 'untitled map';
	}

	function onPanelClick(event) {
		const button = event.target.closest('[data-act]');
		if (!button || !state) return;
		const act = button.dataset.act;
		const value = button.dataset.value;
		state.message = '';

		if (act === 'back') {
			if (hooks.onExit) hooks.onExit();
			return;
		}
		if (act === 'tool') {
			state.tool = value;
			return render();
		}
		if (act === 'terrain') {
			state.terrain = value;
			return render();
		}
		if (act === 'number') {
			state.number = value === 'none' ? null : Number(value);
			return render();
		}
		if (act === 'port-type') {
			state.portType = value;
			return render();
		}
		if (act === 'preset') {
			const preset = M.PRESETS.filter(function (p) {
				return p.id === value;
			})[0];
			if (preset) {
				const name = state.map.name;
				state.map = preset.build();
				state.map.name = name === 'untitled map' ? state.map.name : name;
				state.savedId = null;
			}
			return render();
		}
		if (act === 'blank') {
			const blank = M.fromShape(state.map.name, M.rowsShape([2, 3, 2]));
			state.map = blank;
			state.savedId = null;
			return render();
		}
		if (act === 'shuffle-terrain') {
			randomiseTerrain(state.map);
			return render();
		}
		if (act === 'auto-numbers') {
			M.assignNumbers(state.map);
			return render();
		}
		if (act === 'auto-ports') {
			M.autoPorts(state.map);
			return render();
		}
		if (act === 'clear-ports') {
			state.map.ports = [];
			return render();
		}
		if (act === 'auto-robber') {
			M.pickRobber(state.map);
			return render();
		}
		if (act === 'save') {
			const record = M.saveMap(state.map, state.savedId);
			state.savedId = record.id;
			state.message = 'saved "' + record.name + '"';
			return render();
		}
		if (act === 'save-copy') {
			const record = M.saveMap(state.map, null);
			state.savedId = record.id;
			state.message = 'saved a copy';
			return render();
		}
		if (act === 'load') {
			const record = M.getMap(value);
			if (record) {
				state.map = M.clone(record.map);
				state.savedId = record.id;
			}
			return render();
		}
		if (act === 'delete') {
			M.deleteMap(value);
			if (state.savedId === value) state.savedId = null;
			return render();
		}
		if (act === 'share') {
			state.modal = { kind: 'share' };
			return render();
		}
		if (act === 'import') {
			state.modal = { kind: 'import' };
			return render();
		}
		if (act === 'play') {
			const report = M.validate(state.map);
			if (!report.ok) {
				state.message = report.errors[0];
				return render();
			}
			if (hooks.onPlay) hooks.onPlay(M.clone(state.map));
		}
	}

	/* Keep the mix of terrain roughly proportional to the classic board. */
	function randomiseTerrain(map) {
		const total = map.hexes.length;
		const counts = {
			forest: Math.round(total * 4 / 19),
			fields: Math.round(total * 4 / 19),
			pasture: Math.round(total * 4 / 19),
			hills: Math.round(total * 3 / 19),
			mountains: Math.round(total * 3 / 19)
		};
		let assigned = Object.keys(counts).reduce(function (sum, key) {
			return sum + counts[key];
		}, 0);
		counts.desert = Math.max(0, total - assigned);
		while (assigned + counts.desert > total) {
			counts.forest = Math.max(0, counts.forest - 1);
			assigned--;
		}
		M.assignTerrain(map, counts);
		M.assignNumbers(map);
		M.pickRobber(map);
	}

	/* -------------------------------------------------------------------- modals */

	function onModalClick(event) {
		const button = event.target.closest('[data-modal]');
		if (!button || !state) return;
		const act = button.dataset.modal;

		if (act === 'close') {
			state.modal = null;
			return render();
		}
		if (act === 'copy') {
			const field = document.getElementById('share-text');
			field.select();
			try {
				document.execCommand('copy');
				state.message = 'copied to the clipboard';
			} catch (err) {
				state.message = 'select the text and copy it manually';
			}
			state.modal = null;
			return render();
		}
		if (act === 'do-import') {
			const field = document.getElementById('import-text');
			try {
				const imported = M.decode(field.value);
				if (!imported.hexes.length) throw new Error('that map has no hexes');
				state.map = imported;
				state.savedId = null;
				state.modal = null;
				state.message = 'imported "' + imported.name + '"';
			} catch (err) {
				state.message = 'could not read that map - ' + err.message;
			}
			return render();
		}
	}

	/* ------------------------------------------------------------------- drawing */

	function render() {
		drawBoard();
		els.panel.innerHTML = panelMarkup();
		els.modal.innerHTML = modalMarkup();
		els.modal.classList.toggle('is-open', !!state.modal);
	}

	function drawBoard() {
		const board = M.buildBoard(state.map);
		R.draw(els.board, board, {
			robber: state.map.robber || board.robber,
			editHexes: true,
			addHexTargets: state.tool === 'terrain',
			portTargets: state.tool === 'port',
			coastTargets: state.tool === 'port' ? M.coastalEdges(state.map) : null
		});
	}

	function panelMarkup() {
		const report = M.validate(state.map);
		const tool = TOOLS.filter(function (t) {
			return t.id === state.tool;
		})[0];

		let out = '<div class="panel-head">' +
			'<button class="btn btn--ghost" data-act="back">back</button>' +
			'<span class="panel-head-vp">' + state.map.hexes.length + ' hexes &middot; ' + state.map.ports.length + ' ports</span>' +
			'</div>';

		out += '<div class="block"><label class="field">map name' +
			'<input id="map-name" type="text" value="' + esc(state.map.name) + '" maxlength="60"></label></div>';

		if (state.message) out += '<p class="notice">' + esc(state.message) + '</p>';

		out += '<div class="block"><h3>tool</h3><div class="btn-row btn-row--wrap">';
		TOOLS.forEach(function (t) {
			out += '<button class="btn btn--small' + (state.tool === t.id ? ' is-active' : '') +
				'" data-act="tool" data-value="' + t.id + '">' + esc(t.label) + '</button>';
		});
		out += '</div><p class="hint">' + esc(tool.hint) + '</p>';
		out += palette();
		out += '</div>';

		out += '<div class="block"><h3>fill it in for me</h3><div class="btn-row btn-row--wrap">' +
			'<button class="btn btn--small" data-act="shuffle-terrain">shuffle terrain</button>' +
			'<button class="btn btn--small" data-act="auto-numbers">deal numbers</button>' +
			'<button class="btn btn--small" data-act="auto-ports">place ports</button>' +
			'<button class="btn btn--small" data-act="clear-ports">clear ports</button>' +
			'<button class="btn btn--small" data-act="auto-robber">robber to desert</button>' +
			'</div></div>';

		out += '<div class="block"><h3>start over from</h3><div class="btn-row btn-row--wrap">' +
			'<button class="btn btn--small" data-act="blank">a blank 7 hexes</button>';
		M.PRESETS.forEach(function (preset) {
			out += '<button class="btn btn--small" data-act="preset" data-value="' + preset.id + '">' +
				esc(preset.id) + '</button>';
		});
		out += '</div></div>';

		out += '<div class="block"><h3>checks</h3>' + reportMarkup(report) + '</div>';

		out += '<div class="block"><h3>saved maps</h3>' + savedMarkup() + '</div>';

		out += '<div class="block"><div class="btn-row btn-row--wrap">' +
			'<button class="btn btn--small" data-act="save">' + (state.savedId ? 'save' : 'save to this browser') + '</button>' +
			(state.savedId ? '<button class="btn btn--small" data-act="save-copy">save a copy</button>' : '') +
			'<button class="btn btn--small" data-act="share">share / export</button>' +
			'<button class="btn btn--small" data-act="import">import</button>' +
			'</div>' +
			'<button class="btn btn--primary btn--wide" data-act="play"' + (report.ok ? '' : ' disabled') + '>play this map</button>' +
			'</div>';

		return out;
	}

	function palette() {
		if (state.tool === 'terrain') {
			return '<div class="pick-row pick-row--wrap">' + M.TERRAIN_ORDER.map(function (key) {
				const terrain = M.TERRAINS[key];
				return '<button class="pick' + (state.terrain === key ? ' is-active' : '') +
					'" data-act="terrain" data-value="' + key + '">' +
					'<span class="chip-dot" style="background:' + terrain.color + '"></span>' + esc(terrain.label) +
					(terrain.resource ? '<i>' + esc(terrain.resource) + '</i>' : '') + '</button>';
			}).join('') + '</div>';
		}
		if (state.tool === 'number') {
			return '<div class="pick-row pick-row--wrap">' + M.VALID_NUMBERS.map(function (n) {
				const red = n === 6 || n === 8;
				return '<button class="pick pick--num' + (state.number === n ? ' is-active' : '') +
					(red ? ' pick--red' : '') + '" data-act="number" data-value="' + n + '">' + n +
					'<i>' + M.pips(n) + '</i></button>';
			}).join('') + '<button class="pick pick--num' + (state.number === null ? ' is-active' : '') +
				'" data-act="number" data-value="none">none</button></div>';
		}
		if (state.tool === 'port') {
			const types = M.PORT_TYPES.concat(['none']);
			return '<div class="pick-row pick-row--wrap">' + types.map(function (type) {
				const meta = M.RESOURCE_META[type];
				const label = type === '3:1' ? 'any 3:1' : type === 'none' ? 'remove' : type + ' 2:1';
				return '<button class="pick' + (state.portType === type ? ' is-active' : '') +
					'" data-act="port-type" data-value="' + type + '">' +
					(meta ? '<span class="chip-dot" style="background:' + meta.color + '"></span>' : '') +
					esc(label) + '</button>';
			}).join('') + '</div>';
		}
		return '';
	}

	function reportMarkup(report) {
		if (report.ok && !report.warnings.length) return '<p class="hint ok">the map is ready to play</p>';
		let out = '';
		report.errors.forEach(function (text) {
			out += '<p class="hint bad">' + esc(text) + '</p>';
		});
		report.warnings.forEach(function (text) {
			out += '<p class="hint warn">' + esc(text) + '</p>';
		});
		return out;
	}

	function savedMarkup() {
		const saved = M.loadAll();
		if (!saved.length) return '<p class="hint">nothing saved yet - maps live in this browser only</p>';
		return saved.map(function (record) {
			return '<div class="card-row"><span>' + esc(record.name) +
				' <small>' + record.map.hexes.length + ' hexes &middot; ' + esc(record.updated) + '</small></span>' +
				'<span><button class="btn btn--small" data-act="load" data-value="' + record.id + '">open</button>' +
				'<button class="btn btn--small" data-act="delete" data-value="' + record.id + '">delete</button></span></div>';
		}).join('');
	}

	function modalMarkup() {
		if (!state.modal) return '';
		if (state.modal.kind === 'share') {
			const code = M.encode(state.map);
			const link = location.origin + location.pathname + '#map=' + code;
			return '<div class="dialog"><h2>share this map</h2>' +
				'<p class="hint">anyone opening this link gets your map loaded straight into the editor.</p>' +
				'<textarea id="share-text" rows="5" readonly>' + esc(link) + '</textarea>' +
				'<div class="btn-row"><button class="btn btn--primary" data-modal="copy">copy</button>' +
				'<button class="btn" data-modal="close">close</button></div></div>';
		}
		if (state.modal.kind === 'import') {
			return '<div class="dialog"><h2>import a map</h2>' +
				'<p class="hint">paste a shared link, its code, or raw map JSON.</p>' +
				'<textarea id="import-text" rows="5" placeholder="paste here"></textarea>' +
				'<div class="btn-row"><button class="btn btn--primary" data-modal="do-import">import</button>' +
				'<button class="btn" data-modal="close">close</button></div></div>';
		}
		return '';
	}

	return { open: open };
})();
