/* Map model, presets, validation and storage.
 *
 * A map is plain JSON so it can be saved, exported and shared:
 *
 *   { name, hexes: [{ q, r, terrain, number }], ports: [{ q, r, edge, type }],
 *     robber: "q,r" }
 *
 * Only land hexes are stored. The surrounding sea is implied: any empty
 * position touching a land hex is drawn as water, and a port is anchored to a
 * coastal land hex plus the edge index facing that water.
 */
window.CatanMap = (function () {
	'use strict';

	const H = window.CatanHex;

	const TERRAINS = {
		forest:    { label: 'forest',    resource: 'lumber', color: '#4a7c59' },
		hills:     { label: 'hills',     resource: 'brick',  color: '#b5651d' },
		pasture:   { label: 'pasture',   resource: 'wool',   color: '#9dc183' },
		fields:    { label: 'fields',    resource: 'grain',  color: '#e3c565' },
		mountains: { label: 'mountains', resource: 'ore',    color: '#8f99a3' },
		desert:    { label: 'desert',    resource: null,     color: '#e8dcb5' }
	};

	const TERRAIN_ORDER = ['forest', 'hills', 'pasture', 'fields', 'mountains', 'desert'];

	const RESOURCES = ['brick', 'lumber', 'wool', 'grain', 'ore'];

	const RESOURCE_META = {
		brick:  { label: 'brick',  short: 'B', color: '#b5651d' },
		lumber: { label: 'lumber', short: 'L', color: '#4a7c59' },
		wool:   { label: 'wool',   short: 'W', color: '#9dc183' },
		grain:  { label: 'grain',  short: 'G', color: '#e3c565' },
		ore:    { label: 'ore',    short: 'O', color: '#8f99a3' }
	};

	const PORT_TYPES = ['3:1', 'brick', 'lumber', 'wool', 'grain', 'ore'];

	const VALID_NUMBERS = [2, 3, 4, 5, 6, 8, 9, 10, 11, 12];

	function pips(n) {
		return n ? 6 - Math.abs(7 - n) : 0;
	}

	function shuffle(list, rng) {
		const out = list.slice();
		const rand = rng || Math.random;
		for (let i = out.length - 1; i > 0; i--) {
			const j = Math.floor(rand() * (i + 1));
			const t = out[i];
			out[i] = out[j];
			out[j] = t;
		}
		return out;
	}

	function bag(counts) {
		const out = [];
		Object.keys(counts).forEach(function (key) {
			for (let i = 0; i < counts[key]; i++) out.push(key);
		});
		return out;
	}

	/* ------------------------------------------------------------------ shapes */

	/* Rows of hexes, centred horizontally. `counts` is the hex count per row from
	 * top to bottom, e.g. [3, 4, 5, 4, 3] for the classic 19-hex board. */
	function rowsShape(counts) {
		const startR = -Math.floor(counts.length / 2);
		const cells = [];
		counts.forEach(function (n, index) {
			const r = startR + index;
			const q0 = Math.floor((1 - n - r) / 2);
			for (let i = 0; i < n; i++) cells.push({ q: q0 + i, r: r });
		});
		return cells;
	}

	/* ------------------------------------------------------------- map creation */

	function emptyMap(name) {
		return { name: name || 'untitled map', hexes: [], ports: [], robber: null };
	}

	function fromShape(name, cells) {
		return {
			name: name,
			hexes: cells.map(function (c) {
				return { q: c.q, r: c.r, terrain: 'desert', number: null };
			}),
			ports: [],
			robber: null
		};
	}

	function clone(map) {
		return JSON.parse(JSON.stringify(map));
	}

	function hexAt(map, q, r) {
		for (let i = 0; i < map.hexes.length; i++) {
			if (map.hexes[i].q === q && map.hexes[i].r === r) return map.hexes[i];
		}
		return null;
	}

	function hasHex(map, q, r) {
		return hexAt(map, q, r) !== null;
	}

	function addHex(map, q, r, terrain) {
		if (hasHex(map, q, r)) return null;
		const hex = { q: q, r: r, terrain: terrain || 'desert', number: null };
		map.hexes.push(hex);
		return hex;
	}

	function removeHex(map, q, r) {
		map.hexes = map.hexes.filter(function (h) {
			return !(h.q === q && h.r === r);
		});
		map.ports = map.ports.filter(function (p) {
			return !(p.q === q && p.r === r);
		});
		if (map.robber === H.hexKey(q, r)) map.robber = null;
	}

	/* Empty positions touching at least one land hex - the implied coastline, and
	 * also where the editor offers to grow the board. */
	function seaRing(map) {
		const land = {};
		map.hexes.forEach(function (h) {
			land[H.hexKey(h.q, h.r)] = true;
		});
		const seen = {};
		const out = [];
		map.hexes.forEach(function (h) {
			for (let d = 0; d < 6; d++) {
				const n = H.neighbour(h.q, h.r, d);
				const key = H.hexKey(n.q, n.r);
				if (land[key] || seen[key]) continue;
				seen[key] = true;
				out.push({ q: n.q, r: n.r });
			}
		});
		return out;
	}

	/* Coastal edges (land hex + edge index facing water), ordered clockwise from
	 * the top of the board so ports can be spread evenly around any shape. */
	function coastalEdges(map) {
		const land = {};
		map.hexes.forEach(function (h) {
			land[H.hexKey(h.q, h.r)] = true;
		});
		let cx = 0;
		let cy = 0;
		map.hexes.forEach(function (h) {
			const c = H.hexCenter(h.q, h.r, 1);
			cx += c.x;
			cy += c.y;
		});
		if (map.hexes.length) {
			cx /= map.hexes.length;
			cy /= map.hexes.length;
		}
		const out = [];
		map.hexes.forEach(function (h) {
			for (let d = 0; d < 6; d++) {
				if (land[H.neighbourKey(h.q, h.r, d)]) continue;
				const mid = H.edgeMidpoint(H.hexEdgeKey(h.q, h.r, d), 1);
				// Clockwise on screen (y grows downwards) starting from straight up.
				let angle = Math.atan2(mid.x - cx, -(mid.y - cy));
				if (angle < 0) angle += Math.PI * 2;
				out.push({ q: h.q, r: h.r, edge: d, angle: angle });
			}
		});
		out.sort(function (a, b) {
			return a.angle - b.angle;
		});
		return out;
	}

	/* ------------------------------------------------------- generation helpers */

	function assignTerrain(map, counts) {
		const tiles = shuffle(bag(counts));
		map.hexes.forEach(function (h, i) {
			h.terrain = tiles[i % tiles.length];
			if (h.terrain === 'desert') h.number = null;
		});
		return map;
	}

	/* Deal number tokens to every non-desert hex, retrying until no two "red"
	 * numbers (6 and 8) end up next to each other - the standard fairness rule. */
	function assignNumbers(map, tokens) {
		const targets = map.hexes.filter(function (h) {
			return h.terrain !== 'desert';
		});
		map.hexes.forEach(function (h) {
			if (h.terrain === 'desert') h.number = null;
		});
		if (!targets.length) return map;

		let pool = tokens ? tokens.slice() : defaultTokens(targets.length);
		while (pool.length < targets.length) pool = pool.concat(defaultTokens(targets.length - pool.length));
		pool = pool.slice(0, targets.length);

		for (let attempt = 0; attempt < 400; attempt++) {
			const deal = shuffle(pool);
			targets.forEach(function (h, i) {
				h.number = deal[i];
			});
			if (!hasAdjacentReds(map)) return map;
		}
		return map;
	}

	function hasAdjacentReds(map) {
		const byKey = {};
		map.hexes.forEach(function (h) {
			byKey[H.hexKey(h.q, h.r)] = h;
		});
		for (let i = 0; i < map.hexes.length; i++) {
			const h = map.hexes[i];
			if (h.number !== 6 && h.number !== 8) continue;
			for (let d = 0; d < 6; d++) {
				const n = byKey[H.neighbourKey(h.q, h.r, d)];
				if (n && (n.number === 6 || n.number === 8)) return true;
			}
		}
		return false;
	}

	/* A balanced spread of tokens for boards of any size: repeat the classic
	 * 2..12 distribution (one 2 and one 12 per eighteen tiles) as needed. */
	function defaultTokens(count) {
		const base = [5, 2, 6, 3, 8, 10, 9, 12, 11, 4, 8, 10, 9, 4, 5, 6, 3, 11];
		const out = [];
		while (out.length < count) out.push(base[out.length % base.length]);
		return out.slice(0, count);
	}

	function autoPorts(map, count) {
		const coast = coastalEdges(map);
		map.ports = [];
		if (!coast.length) return map;

		const wanted = count || Math.max(2, Math.round(coast.length / 3.3));
		const types = shuffle(portTypesFor(wanted));
		const step = coast.length / wanted;
		for (let i = 0; i < wanted; i++) {
			const spot = coast[Math.floor(i * step) % coast.length];
			map.ports.push({ q: spot.q, r: spot.r, edge: spot.edge, type: types[i] });
		}
		return map;
	}

	/* Classic ratio: a little over half generic 3:1, the rest one 2:1 per resource. */
	function portTypesFor(count) {
		const out = [];
		let i = 0;
		while (out.length < count) {
			out.push(RESOURCES[i % RESOURCES.length]);
			i++;
			if (out.length < count) out.push('3:1');
		}
		return out.slice(0, count);
	}

	function pickRobber(map) {
		const desert = map.hexes.filter(function (h) {
			return h.terrain === 'desert';
		})[0];
		map.robber = desert ? H.hexKey(desert.q, desert.r) : null;
		return map;
	}

	/* ----------------------------------------------------------------- presets */

	function standardMap() {
		const map = fromShape('standard (3-4 players)', rowsShape([3, 4, 5, 4, 3]));
		assignTerrain(map, { forest: 4, fields: 4, pasture: 4, hills: 3, mountains: 3, desert: 1 });
		assignNumbers(map, [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12]);
		autoPorts(map, 9);
		pickRobber(map);
		return map;
	}

	function largeMap() {
		const map = fromShape('large (5-6 players)', rowsShape([3, 4, 5, 6, 5, 4, 3]));
		assignTerrain(map, { forest: 6, fields: 6, pasture: 6, hills: 5, mountains: 5, desert: 2 });
		assignNumbers(map, [
			2, 2, 3, 3, 3, 4, 4, 4, 5, 5, 5, 6, 6, 6,
			8, 8, 8, 9, 9, 9, 10, 10, 10, 11, 11, 11, 12, 12
		]);
		autoPorts(map, 11);
		pickRobber(map);
		return map;
	}

	function smallMap() {
		const map = fromShape('small (fast game)', rowsShape([2, 3, 2]));
		assignTerrain(map, { forest: 2, fields: 2, pasture: 1, hills: 1, mountains: 1 });
		assignNumbers(map);
		autoPorts(map, 4);
		pickRobber(map);
		return map;
	}

	const PRESETS = [
		{ id: 'standard', label: 'standard - 19 hexes, 3-4 players', build: standardMap },
		{ id: 'large', label: 'large - 30 hexes, 5-6 players', build: largeMap },
		{ id: 'small', label: 'small - 7 hexes, quick game', build: smallMap }
	];

	/* -------------------------------------------------------------- validation */

	function validate(map) {
		const errors = [];
		const warnings = [];

		if (!map.hexes.length) {
			errors.push('the map has no hexes');
			return { errors: errors, warnings: warnings, ok: false };
		}
		if (map.hexes.length < 4) errors.push('a playable map needs at least 4 hexes');

		if (!isConnected(map)) errors.push('all hexes must touch - the map is split into separate islands');

		const missing = map.hexes.filter(function (h) {
			return h.terrain !== 'desert' && !h.number;
		});
		if (missing.length) {
			errors.push(missing.length + ' hex' + (missing.length === 1 ? '' : 'es') + ' still need a number token');
		}

		const producing = map.hexes.filter(function (h) {
			return h.terrain !== 'desert';
		});
		const resources = {};
		producing.forEach(function (h) {
			resources[TERRAINS[h.terrain].resource] = true;
		});
		const absent = RESOURCES.filter(function (res) {
			return !resources[res];
		});
		if (absent.length) {
			errors.push('no hex produces ' + absent.join(' or ') + ' - every resource needs a source');
		}

		if (!map.robber) warnings.push('no robber start hex set - it will start on the first desert (or the first hex)');
		if (hasAdjacentReds(map)) warnings.push('two red numbers (6 or 8) are next to each other');
		if (!map.ports.length) warnings.push('the map has no ports');

		const seen = {};
		map.ports.forEach(function (p) {
			const key = H.hexEdgeKey(p.q, p.r, p.edge);
			if (seen[key]) warnings.push('two ports share the same edge');
			seen[key] = true;
		});

		return { errors: errors, warnings: warnings, ok: errors.length === 0 };
	}

	function isConnected(map) {
		if (!map.hexes.length) return true;
		const land = {};
		map.hexes.forEach(function (h) {
			land[H.hexKey(h.q, h.r)] = true;
		});
		const start = H.hexKey(map.hexes[0].q, map.hexes[0].r);
		const seen = {};
		const stack = [start];
		seen[start] = true;
		let count = 0;
		while (stack.length) {
			const key = stack.pop();
			count++;
			const pos = H.parseHexKey(key);
			for (let d = 0; d < 6; d++) {
				const nk = H.neighbourKey(pos.q, pos.r, d);
				if (land[nk] && !seen[nk]) {
					seen[nk] = true;
					stack.push(nk);
				}
			}
		}
		return count === map.hexes.length;
	}

	/* ------------------------------------------------------------------- board
	 * The playable graph derived from a map: every hex, every corner that touches
	 * land (a settlement spot) and every edge between two such corners (a road). */

	function buildBoard(map) {
		const hexes = {};
		const vertices = {};
		const edges = {};

		map.hexes.forEach(function (h) {
			const key = H.hexKey(h.q, h.r);
			hexes[key] = {
				key: key,
				q: h.q,
				r: h.r,
				terrain: h.terrain,
				resource: TERRAINS[h.terrain] ? TERRAINS[h.terrain].resource : null,
				number: h.terrain === 'desert' ? null : h.number,
				corners: H.cornerKeys(h.q, h.r)
			};
		});

		Object.keys(hexes).forEach(function (hk) {
			const hex = hexes[hk];
			hex.corners.forEach(function (vk) {
				if (!vertices[vk]) vertices[vk] = { key: vk, hexes: [], edges: [], adjacent: [], port: null };
				vertices[vk].hexes.push(hk);
			});
			for (let d = 0; d < 6; d++) {
				const ek = H.hexEdgeKey(hex.q, hex.r, d);
				if (!edges[ek]) {
					const ends = H.edgeEnds(ek);
					edges[ek] = { key: ek, ends: ends, hexes: [] };
				}
				edges[ek].hexes.push(hk);
			}
		});

		Object.keys(edges).forEach(function (ek) {
			const edge = edges[ek];
			edge.ends.forEach(function (vk) {
				if (!vertices[vk]) return;
				vertices[vk].edges.push(ek);
				const other = edge.ends[0] === vk ? edge.ends[1] : edge.ends[0];
				if (vertices[other]) vertices[vk].adjacent.push(other);
			});
		});

		map.ports.forEach(function (p) {
			const ek = H.hexEdgeKey(p.q, p.r, p.edge);
			H.edgeEnds(ek).forEach(function (vk) {
				if (vertices[vk]) vertices[vk].port = p.type;
			});
		});

		let robber = map.robber;
		if (!robber || !hexes[robber]) {
			const desert = Object.keys(hexes).filter(function (k) {
				return hexes[k].terrain === 'desert';
			})[0];
			robber = desert || Object.keys(hexes)[0];
		}

		return { map: map, hexes: hexes, vertices: vertices, edges: edges, robber: robber, sea: seaRing(map) };
	}

	/* ------------------------------------------------------------------ storage */

	const STORE_KEY = 'catan-maps';

	function loadAll() {
		try {
			const raw = localStorage.getItem(STORE_KEY);
			const parsed = raw ? JSON.parse(raw) : [];
			return Array.isArray(parsed) ? parsed : [];
		} catch (err) {
			return [];
		}
	}

	function saveAll(list) {
		try {
			localStorage.setItem(STORE_KEY, JSON.stringify(list));
			return true;
		} catch (err) {
			return false;
		}
	}

	function saveMap(map, id) {
		const list = loadAll();
		const record = {
			id: id || 'map-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
			name: map.name,
			updated: new Date().toISOString().slice(0, 10),
			map: clone(map)
		};
		const index = list.findIndex(function (entry) {
			return entry.id === record.id;
		});
		if (index >= 0) list[index] = record;
		else list.push(record);
		saveAll(list);
		return record;
	}

	function deleteMap(id) {
		saveAll(loadAll().filter(function (entry) {
			return entry.id !== id;
		}));
	}

	function getMap(id) {
		return loadAll().filter(function (entry) {
			return entry.id === id;
		})[0] || null;
	}

	/* --------------------------------------------------------- share / transfer */

	function encode(map) {
		const json = JSON.stringify(compact(map));
		return btoa(unescape(encodeURIComponent(json))).replace(/=+$/, '');
	}

	function decode(text) {
		let trimmed = (text || '').trim();
		// Accept a whole shared link as readily as the bare code.
		const marker = trimmed.indexOf('#map=');
		if (marker >= 0) trimmed = trimmed.slice(marker + 5).trim();
		if (!trimmed) throw new Error('nothing to import');
		let json = trimmed;
		if (trimmed[0] !== '{') {
			const padded = trimmed + '==='.slice((trimmed.length + 3) % 4);
			json = decodeURIComponent(escape(atob(padded)));
		}
		return expand(JSON.parse(json));
	}

	/* Short field names keep shared links to a sane length. */
	function compact(map) {
		return {
			n: map.name,
			h: map.hexes.map(function (h) {
				return [h.q, h.r, TERRAIN_ORDER.indexOf(h.terrain), h.number || 0];
			}),
			p: map.ports.map(function (p) {
				return [p.q, p.r, p.edge, PORT_TYPES.indexOf(p.type)];
			}),
			r: map.robber || ''
		};
	}

	function expand(data) {
		if (data && data.hexes) return normalise(data);
		return normalise({
			name: data.n || 'imported map',
			hexes: (data.h || []).map(function (h) {
				return { q: h[0], r: h[1], terrain: TERRAIN_ORDER[h[2]] || 'desert', number: h[3] || null };
			}),
			ports: (data.p || []).map(function (p) {
				return { q: p[0], r: p[1], edge: p[2], type: PORT_TYPES[p[3]] || '3:1' };
			}),
			robber: data.r || null
		});
	}

	function normalise(map) {
		const out = emptyMap(String(map.name || 'imported map').slice(0, 60));
		const seen = {};
		(map.hexes || []).forEach(function (h) {
			const q = Math.round(Number(h.q));
			const r = Math.round(Number(h.r));
			if (!isFinite(q) || !isFinite(r)) return;
			const key = H.hexKey(q, r);
			if (seen[key]) return;
			seen[key] = true;
			const terrain = TERRAINS[h.terrain] ? h.terrain : 'desert';
			const number = VALID_NUMBERS.indexOf(Number(h.number)) >= 0 ? Number(h.number) : null;
			out.hexes.push({ q: q, r: r, terrain: terrain, number: terrain === 'desert' ? null : number });
		});
		(map.ports || []).forEach(function (p) {
			const q = Math.round(Number(p.q));
			const r = Math.round(Number(p.r));
			const edge = Math.round(Number(p.edge));
			if (!seen[H.hexKey(q, r)] || !(edge >= 0 && edge < 6)) return;
			out.ports.push({ q: q, r: r, edge: edge, type: PORT_TYPES.indexOf(p.type) >= 0 ? p.type : '3:1' });
		});
		if (map.robber && seen[map.robber]) out.robber = map.robber;
		return out;
	}

	return {
		TERRAINS: TERRAINS,
		TERRAIN_ORDER: TERRAIN_ORDER,
		RESOURCES: RESOURCES,
		RESOURCE_META: RESOURCE_META,
		PORT_TYPES: PORT_TYPES,
		VALID_NUMBERS: VALID_NUMBERS,
		PRESETS: PRESETS,
		pips: pips,
		shuffle: shuffle,
		rowsShape: rowsShape,
		emptyMap: emptyMap,
		fromShape: fromShape,
		clone: clone,
		hexAt: hexAt,
		hasHex: hasHex,
		addHex: addHex,
		removeHex: removeHex,
		seaRing: seaRing,
		coastalEdges: coastalEdges,
		assignTerrain: assignTerrain,
		assignNumbers: assignNumbers,
		autoPorts: autoPorts,
		pickRobber: pickRobber,
		standardMap: standardMap,
		largeMap: largeMap,
		smallMap: smallMap,
		validate: validate,
		buildBoard: buildBoard,
		loadAll: loadAll,
		saveMap: saveMap,
		deleteMap: deleteMap,
		getMap: getMap,
		encode: encode,
		decode: decode
	};
})();
