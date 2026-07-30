/* Hex geometry for pointy-top hexes in axial (q, r) coordinates.
 *
 * Direction / edge / corner indices all line up: edge i runs from corner i to
 * corner i+1, and DIRS[i] is the neighbouring hex across edge i.
 *
 *            corner 5
 *       corner 4    corner 0
 *       corner 3    corner 1
 *            corner 2
 */
window.CatanHex = (function () {
	'use strict';

	const SQRT3 = Math.sqrt(3);

	const DIRS = [[1, 0], [0, 1], [-1, 1], [-1, 0], [0, -1], [1, -1]];

	/* A corner's position is (xk * sqrt(3)/2 * size, yk * 1/2 * size). Both xk and
	 * yk always come out integral, so "xk,yk" is an exact identity key for a corner
	 * shared between hexes - no float rounding anywhere. */
	const CORNER_XK = [1, 1, 0, -1, -1, 0];
	const CORNER_YK = [-1, 1, 2, 1, -1, -2];

	/* The three corners adjacent to a corner depend only on where it falls in the
	 * 3-unit vertical period: yk % 3 === 1 points one way, yk % 3 === 2 the other. */
	const V_ADJ_A = [[0, -2], [-1, 1], [1, 1]];
	const V_ADJ_B = [[0, 2], [-1, -1], [1, -1]];

	function hexKey(q, r) {
		return q + ',' + r;
	}

	function parseHexKey(key) {
		const parts = key.split(',');
		return { q: Number(parts[0]), r: Number(parts[1]) };
	}

	function neighbour(q, r, dir) {
		return { q: q + DIRS[dir][0], r: r + DIRS[dir][1] };
	}

	function neighbourKey(q, r, dir) {
		return hexKey(q + DIRS[dir][0], r + DIRS[dir][1]);
	}

	function cornerKey(q, r, i) {
		return (2 * q + r + CORNER_XK[i]) + ',' + (3 * r + CORNER_YK[i]);
	}

	function cornerKeys(q, r) {
		const out = [];
		for (let i = 0; i < 6; i++) out.push(cornerKey(q, r, i));
		return out;
	}

	function edgeKey(a, b) {
		return a < b ? a + '|' + b : b + '|' + a;
	}

	function hexEdgeKey(q, r, i) {
		return edgeKey(cornerKey(q, r, i), cornerKey(q, r, (i + 1) % 6));
	}

	function edgeEnds(key) {
		return key.split('|');
	}

	function vertexAdjacent(key) {
		const parts = key.split(',');
		const xk = Number(parts[0]);
		const yk = Number(parts[1]);
		const deltas = (((yk % 3) + 3) % 3) === 1 ? V_ADJ_A : V_ADJ_B;
		return deltas.map(function (d) {
			return (xk + d[0]) + ',' + (yk + d[1]);
		});
	}

	function vertexPoint(key, size) {
		const parts = key.split(',');
		return {
			x: Number(parts[0]) * SQRT3 / 2 * size,
			y: Number(parts[1]) / 2 * size
		};
	}

	function hexCenter(q, r, size) {
		return { x: SQRT3 * size * (q + r / 2), y: 1.5 * size * r };
	}

	function hexCorners(q, r, size) {
		return cornerKeys(q, r).map(function (k) {
			return vertexPoint(k, size);
		});
	}

	function hexPoints(q, r, size) {
		return hexCorners(q, r, size).map(function (p) {
			return p.x.toFixed(2) + ',' + p.y.toFixed(2);
		}).join(' ');
	}

	function edgeMidpoint(key, size) {
		const ends = edgeEnds(key);
		const a = vertexPoint(ends[0], size);
		const b = vertexPoint(ends[1], size);
		return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
	}

	function distance(a, b) {
		const dq = a.q - b.q;
		const dr = a.r - b.r;
		return (Math.abs(dq) + Math.abs(dr) + Math.abs(dq + dr)) / 2;
	}

	return {
		SQRT3: SQRT3,
		DIRS: DIRS,
		hexKey: hexKey,
		parseHexKey: parseHexKey,
		neighbour: neighbour,
		neighbourKey: neighbourKey,
		cornerKey: cornerKey,
		cornerKeys: cornerKeys,
		edgeKey: edgeKey,
		hexEdgeKey: hexEdgeKey,
		edgeEnds: edgeEnds,
		vertexAdjacent: vertexAdjacent,
		vertexPoint: vertexPoint,
		hexCenter: hexCenter,
		hexCorners: hexCorners,
		hexPoints: hexPoints,
		edgeMidpoint: edgeMidpoint,
		distance: distance
	};
})();
