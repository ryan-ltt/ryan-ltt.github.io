/* SVG board rendering, shared by the map editor and the game screen.
 *
 * Everything is drawn in model units (hex radius = SIZE) and the viewBox is
 * fitted to the board, so the same markup scales to any container. Interactive
 * pieces carry data-hex / data-vertex / data-edge / data-port attributes and the
 * callers attach a single delegated click handler to the <svg>. */
window.CatanRender = (function () {
	'use strict';

	const H = window.CatanHex;
	const M = window.CatanMap;

	const SIZE = 100;
	const SEA = '#a8d8ea';

	function esc(text) {
		return String(text).replace(/[&<>"]/g, function (ch) {
			return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
		});
	}

	function polygon(points, attrs) {
		return '<polygon points="' + points + '" ' + attrs + '/>';
	}

	function bounds(map) {
		const xs = [];
		const ys = [];
		const cells = map.hexes.concat(M.seaRing(map));
		cells.forEach(function (h) {
			H.hexCorners(h.q, h.r, SIZE).forEach(function (p) {
				xs.push(p.x);
				ys.push(p.y);
			});
		});
		if (!xs.length) return { x: -SIZE, y: -SIZE, w: SIZE * 2, h: SIZE * 2 };
		const pad = SIZE * 0.35;
		const minX = Math.min.apply(null, xs) - pad;
		const minY = Math.min.apply(null, ys) - pad;
		return {
			x: minX,
			y: minY,
			w: Math.max.apply(null, xs) + pad - minX,
			h: Math.max.apply(null, ys) + pad - minY
		};
	}

	/* --------------------------------------------------------------- board bits */

	function seaLayer(map, opts) {
		return M.seaRing(map).map(function (cell) {
			const points = H.hexPoints(cell.q, cell.r, SIZE);
			const target = opts.addHexTargets
				? '<polygon points="' + points + '" class="c-add-hex" data-add="' + cell.q + ',' + cell.r + '"/>'
				: '';
			return polygon(points, 'class="c-sea"') + target;
		}).join('');
	}

	function hexLayer(board, opts) {
		return Object.keys(board.hexes).map(function (key) {
			const hex = board.hexes[key];
			const terrain = M.TERRAINS[hex.terrain] || M.TERRAINS.desert;
			const center = H.hexCenter(hex.q, hex.r, SIZE);
			const selected = opts.selectedHex === key ? ' c-hex--selected' : '';
			let out = polygon(H.hexPoints(hex.q, hex.r, SIZE),
				'class="c-hex' + selected + '" fill="' + terrain.color + '" data-hex="' + key + '"');

			if (hex.number) {
				const red = hex.number === 6 || hex.number === 8;
				out += '<circle cx="' + center.x.toFixed(1) + '" cy="' + center.y.toFixed(1) +
					'" r="' + (SIZE * 0.30).toFixed(1) + '" class="c-token"/>';
				out += '<text x="' + center.x.toFixed(1) + '" y="' + (center.y - SIZE * 0.02).toFixed(1) +
					'" class="c-token-num' + (red ? ' c-token-num--red' : '') + '">' + hex.number + '</text>';
				out += pipRow(center.x, center.y + SIZE * 0.19, M.pips(hex.number), red);
			}

			out += '<text x="' + center.x.toFixed(1) + '" y="' + (center.y + SIZE * 0.72).toFixed(1) +
				'" class="c-hex-label">' + esc(terrain.label) + '</text>';
			return out;
		}).join('');
	}

	function pipRow(cx, cy, count, red) {
		const gap = SIZE * 0.075;
		const start = cx - (count - 1) * gap / 2;
		let out = '';
		for (let i = 0; i < count; i++) {
			out += '<circle cx="' + (start + i * gap).toFixed(1) + '" cy="' + cy.toFixed(1) +
				'" r="' + (SIZE * 0.022).toFixed(1) + '" class="c-pip' + (red ? ' c-pip--red' : '') + '"/>';
		}
		return out;
	}

	function portLayer(map, opts) {
		return map.ports.map(function (port, index) {
			const edgeKey = H.hexEdgeKey(port.q, port.r, port.edge);
			const ends = H.edgeEnds(edgeKey);
			const a = H.vertexPoint(ends[0], SIZE);
			const b = H.vertexPoint(ends[1], SIZE);
			const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
			const from = H.hexCenter(port.q, port.r, SIZE);
			const dx = mid.x - from.x;
			const dy = mid.y - from.y;
			const len = Math.sqrt(dx * dx + dy * dy) || 1;
			const anchor = { x: mid.x + dx / len * SIZE * 0.52, y: mid.y + dy / len * SIZE * 0.52 };
			const label = port.type === '3:1' ? '3:1' : (M.RESOURCE_META[port.type].short + ' 2:1');

			let out = '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + anchor.x.toFixed(1) +
				'" y2="' + anchor.y.toFixed(1) + '" class="c-port-line"/>';
			out += '<line x1="' + b.x.toFixed(1) + '" y1="' + b.y.toFixed(1) + '" x2="' + anchor.x.toFixed(1) +
				'" y2="' + anchor.y.toFixed(1) + '" class="c-port-line"/>';
			const fill = port.type === '3:1' ? '#ffffff' : M.RESOURCE_META[port.type].color;
			out += '<rect x="' + (anchor.x - SIZE * 0.28).toFixed(1) + '" y="' + (anchor.y - SIZE * 0.17).toFixed(1) +
				'" width="' + (SIZE * 0.56).toFixed(1) + '" height="' + (SIZE * 0.34).toFixed(1) +
				'" class="c-port" fill="' + fill + '"' +
				(opts.portTargets ? ' data-port="' + index + '"' : '') + '/>';
			out += '<text x="' + anchor.x.toFixed(1) + '" y="' + (anchor.y + SIZE * 0.055).toFixed(1) +
				'" class="c-port-label">' + esc(label) + '</text>';
			return out;
		}).join('');
	}

	function robberLayer(hexKey) {
		const pos = H.parseHexKey(hexKey);
		const c = H.hexCenter(pos.q, pos.r, SIZE);
		const s = SIZE * 0.01;
		return '<g class="c-robber" transform="translate(' + c.x.toFixed(1) + ',' + c.y.toFixed(1) + ')">' +
			'<path d="M ' + (-22 * s) + ' ' + (30 * s) + ' Q ' + (-22 * s) + ' ' + (-2 * s) + ' ' + (-8 * s) + ' ' + (-8 * s) +
			' L ' + (8 * s) + ' ' + (-8 * s) + ' Q ' + (22 * s) + ' ' + (-2 * s) + ' ' + (22 * s) + ' ' + (30 * s) + ' Z"/>' +
			'<circle cx="0" cy="' + (-18 * s) + '" r="' + (12 * s) + '"/>' +
			'</g>';
	}

	/* --------------------------------------------------------------- game pieces */

	function roadLayer(game) {
		return Object.keys(game.roads).map(function (edgeKey) {
			const player = game.players[game.roads[edgeKey]];
			const ends = H.edgeEnds(edgeKey);
			const a = H.vertexPoint(ends[0], SIZE);
			const b = H.vertexPoint(ends[1], SIZE);
			const inset = 0.16;
			const x1 = a.x + (b.x - a.x) * inset;
			const y1 = a.y + (b.y - a.y) * inset;
			const x2 = b.x - (b.x - a.x) * inset;
			const y2 = b.y - (b.y - a.y) * inset;
			const coords = 'x1="' + x1.toFixed(1) + '" y1="' + y1.toFixed(1) +
				'" x2="' + x2.toFixed(1) + '" y2="' + y2.toFixed(1) + '"';
			// A black underlay keeps pale player colours readable on any terrain.
			return '<line ' + coords + ' class="c-road-edge"/>' +
				'<line ' + coords + ' class="c-road" stroke="' + player.fill + '"/>';
		}).join('');
	}

	function buildingLayer(game) {
		return Object.keys(game.buildings).map(function (vertexKey) {
			const building = game.buildings[vertexKey];
			const player = game.players[building.owner];
			const p = H.vertexPoint(vertexKey, SIZE);
			const s = SIZE * 0.30;
			const shape = building.type === 'city'
				? [[-0.9, 0.6], [-0.9, -0.15], [-0.4, -0.7], [0.1, -0.15], [0.1, 0.1], [0.9, 0.1], [0.9, 0.6]]
				: [[-0.6, 0.55], [-0.6, -0.1], [0, -0.7], [0.6, -0.1], [0.6, 0.55]];
			const points = shape.map(function (pt) {
				return (p.x + pt[0] * s).toFixed(1) + ',' + (p.y + pt[1] * s).toFixed(1);
			}).join(' ');
			return polygon(points, 'class="c-building" fill="' + player.fill + '"');
		}).join('');
	}

	/* -------------------------------------------------------------- interaction */

	function targetLayer(board, opts) {
		let out = '';

		(opts.hexTargets || []).forEach(function (key) {
			const pos = H.parseHexKey(key);
			out += '<polygon points="' + H.hexPoints(pos.q, pos.r, SIZE) + '" class="c-target-hex" data-hex="' + key + '"/>';
		});

		(opts.edgeTargets || []).forEach(function (key) {
			const ends = H.edgeEnds(key);
			const a = H.vertexPoint(ends[0], SIZE);
			const b = H.vertexPoint(ends[1], SIZE);
			out += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) +
				'" y2="' + b.y.toFixed(1) + '" class="c-target-edge" data-edge="' + esc(key) + '"/>';
		});

		(opts.vertexTargets || []).forEach(function (key) {
			const p = H.vertexPoint(key, SIZE);
			out += '<circle cx="' + p.x.toFixed(1) + '" cy="' + p.y.toFixed(1) + '" r="' + (SIZE * 0.20).toFixed(1) +
				'" class="c-target-vertex" data-vertex="' + esc(key) + '"/>';
		});

		if (opts.editHexes) {
			Object.keys(board.hexes).forEach(function (key) {
				const hex = board.hexes[key];
				out += '<polygon points="' + H.hexPoints(hex.q, hex.r, SIZE) + '" class="c-hit" data-hex="' + key + '"/>';
			});
		}

		if (opts.coastTargets) {
			opts.coastTargets.forEach(function (spot) {
				const ends = H.edgeEnds(H.hexEdgeKey(spot.q, spot.r, spot.edge));
				const a = H.vertexPoint(ends[0], SIZE);
				const b = H.vertexPoint(ends[1], SIZE);
				out += '<line x1="' + a.x.toFixed(1) + '" y1="' + a.y.toFixed(1) + '" x2="' + b.x.toFixed(1) +
					'" y2="' + b.y.toFixed(1) + '" class="c-target-coast" data-coast="' +
					spot.q + ',' + spot.r + ',' + spot.edge + '"/>';
			});
		}

		return out;
	}

	/* --------------------------------------------------------------------- entry */

	function draw(svg, board, options) {
		const opts = options || {};
		const map = board.map;
		const box = bounds(map);

		let markup = '<g class="c-board">';
		markup += seaLayer(map, opts);
		markup += hexLayer(board, opts);
		markup += portLayer(map, opts);
		if (opts.game) {
			markup += roadLayer(opts.game);
			markup += buildingLayer(opts.game);
		}
		markup += robberLayer(opts.robber || board.robber);
		markup += targetLayer(board, opts);
		markup += '</g>';

		svg.setAttribute('viewBox', [box.x, box.y, box.w, box.h].map(function (n) {
			return n.toFixed(1);
		}).join(' '));
		svg.innerHTML = markup;
	}

	return { draw: draw, SIZE: SIZE, SEA: SEA, bounds: bounds };
})();
