'use strict';

const LS_PREFIX = 'walkYourCity_';
const CITIES = ['toronto', 'vancouver', 'montreal'];

const SUPABASE_URL = 'https://nzqistdhfkxvfjpkkhfl.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_lJ8UY3QatGlOcsqsVnVAKQ_LPsmTbW_';
const db = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const WALKED_COLOR = '#16a34a';
const WALKED_TODAY_COLOR = '#15803d';
const UNWALKED_COLOR = '#94a3b8';
const HIGHLIGHT_COLOR = '#f59e0b';
const HISTORY_COLOR = '#2563eb';
const ROUTE_COLOR = '#7c3aed';
const ROUTE_OVERLAP_COLOR = '#f43f5e';
const ROUTE_START_COLOR = '#f97316';
const ROUTE_PIN_COLOR = '#2563eb';
const ROUTE_BG_OPACITY = 0.15;
const WALKED_PENALTY = 5;

// --- State ---
let cityData = null;
let cityState = null;
// walks: Map<wayId, dateString ('YYYY-MM-DD')>
// a segment is walked if it appears here; value is the date it was marked
let walks = new Map();
let polylines = new Map();        // wayId -> Leaflet polyline (mark tab map)
let historyPolylines = new Map(); // wayId -> Leaflet polyline (history tab map)
let expandedStreets = new Set();
let currentCity = null;
let filterText = '';
let walkedFilter = 'all'; // 'all' | 'some' | 'full'
let activeDate = todayStr();
let historyDate = todayStr();
let activeTab = 'mark';
let map = null;
let mapHistory = null;
let mapRoute = null;
let currentUser = null;
let realtimeChannel = null;

// Route tab state
let routePolylines = new Map();
let routeHighlight = [];
let routeStartMarker = null;
let routeStartLatLon = null;
let routeStartWayId = null;
let routeGraph = null;
let lastRouteCity = null;
let lastRouteWayIds = [];
let lastTurnaroundNode = null;
let routePins = [];       // [{ lat, lon, wayId, marker }]
let routeMapMode = 'start'; // 'start' | 'pin'

// GPS tracking state
let gpsTracking = false;
let gpsWatchId = null;
let gpsMarker = null;
let gpsAccuracyCircle = null;
let gpsTrackPoints = [];
let gpsCoverage = new Map();   // wayId -> { minT, maxT }
let gpsSessionWalked = new Set();
let gpsSessionNewStreets = 0;
let gpsSessionKm = 0;
let gpsPrevLatLon = null;
let gpsControlBtn = null;      // ref to the Leaflet control button for state resets

// --- Helpers ---
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function invalidateAll() {
    setTimeout(() => { map.invalidateSize(); mapHistory.invalidateSize(); if (mapRoute) mapRoute.invalidateSize(); }, 0);
    setTimeout(() => { map.invalidateSize(); mapHistory.invalidateSize(); if (mapRoute) mapRoute.invalidateSize(); }, 250);
}

function formatLength(m) {
    if (m >= 1000) return (m / 1000).toFixed(1) + ' km';
    return Math.round(m) + ' m';
}

function saveMapPos(cityKey) {
    const { lat, lng } = map.getCenter();
    localStorage.setItem(`${LS_PREFIX}mapPos_${cityKey}`, JSON.stringify({ lat, lng, zoom: map.getZoom() }));
}

function loadMapPos(cityKey) {
    try {
        const raw = localStorage.getItem(`${LS_PREFIX}mapPos_${cityKey}`);
        return raw ? JSON.parse(raw) : null;
    } catch { return null; }
}

// --- Route tab helpers ---
function setRouteStatus(msg) {
    document.getElementById('routeStatus').textContent = msg;
}

function updateRouteTimeLabel() {
    const km = parseFloat(document.getElementById('routeDistanceInput').value) || 0;
    const mins = Math.round(km / 5 * 60);
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    document.getElementById('routeTimeLabel').textContent = `~${h}h ${m}m`;
}

function updatePinUI() {
    const hasPins = routePins.length > 0;
    const addBtn = document.getElementById('routeAddPinBtn');
    const clearBtn = document.getElementById('routeClearPinsBtn');
    const orderedLabel = document.getElementById('routePinsOrderedLabel');
    const countEl = document.getElementById('routePinCount');
    if (addBtn) addBtn.classList.toggle('route-btn-active', routeMapMode === 'pin');
    if (clearBtn) clearBtn.style.display = hasPins ? '' : 'none';
    if (orderedLabel) orderedLabel.style.display = hasPins ? '' : 'none';
    if (countEl) {
        countEl.style.display = hasPins ? '' : 'none';
        countEl.textContent = `${routePins.length} pin${routePins.length === 1 ? '' : 's'}`;
    }
}

function clearAllPins() {
    for (const p of routePins) mapRoute.removeLayer(p.marker);
    routePins = [];
    updatePinUI();
}

function clearRouteBackground() {
    for (const pl of routePolylines.values()) mapRoute.removeLayer(pl);
    routePolylines.clear();
}

// --- Mark tab search highlight ---
let markSearchHighlight = [];

function clearMarkSearch() {
    for (const pl of markSearchHighlight) map.removeLayer(pl);
    markSearchHighlight = [];
}

function applyMarkSearch() {
    clearMarkSearch();
    const query = document.getElementById('streetSearch').value.trim();
    const showOnMap = document.getElementById('streetSearchShowOnMap').checked;
    if (!cityState || !showOnMap || !query) return;
    const q = query.toLowerCase();
    const allCoords = [];
    for (const w of cityState.ways.values()) {
        if (w.name.toLowerCase().includes(q)) {
            const color = walks.has(w.id) ? WALKED_COLOR : ROUTE_OVERLAP_COLOR;
            const pl = L.polyline(w.geometry, { color, weight: 6, opacity: 0.95 }).addTo(map);
            markSearchHighlight.push(pl);
            for (const c of w.geometry) allCoords.push(c);
        }
    }
    if (allCoords.length) map.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });
}

function renderRouteBackground() {
    if (!cityState || !mapRoute) return;
    clearRouteBackground();
    for (const w of cityState.ways.values()) {
        const date = walks.get(w.id);
        const color = date === activeDate ? WALKED_TODAY_COLOR : date ? WALKED_COLOR : UNWALKED_COLOR;
        const opacity = date ? 0.7 : ROUTE_BG_OPACITY;
        const weight = date ? 4 : 3;
        const pl = L.polyline(w.geometry, { color, weight, opacity }).addTo(mapRoute);
        routePolylines.set(w.id, pl);
    }
}

function buildRouteGraph() {
    const nodeIndex = new Map();
    const nodeCoords = [];
    const adj = [];

    function getOrAddNode(lat, lon) {
        const key = lat.toFixed(6) + ',' + lon.toFixed(6);
        if (!nodeIndex.has(key)) {
            const id = nodeCoords.length;
            nodeIndex.set(key, id);
            nodeCoords.push({ lat, lon, key });
            adj.push([]);
        }
        return nodeIndex.get(key);
    }

    for (const w of cityState.ways.values()) {
        const geo = w.geometry;
        const a = getOrAddNode(geo[0][0], geo[0][1]);
        const b = getOrAddNode(geo[geo.length - 1][0], geo[geo.length - 1][1]);
        if (a === b) continue;
        adj[a].push({ to: b, wayId: w.id, cost: w.length_m });
        adj[b].push({ to: a, wayId: w.id, cost: w.length_m });
    }

    return { nodeIndex, nodeCoords, adj };
}

function findClosestWay(lat, lon) {
    const { wayId } = findClosestWayWithDist(lat, lon);
    return wayId;
}

function findClosestWayWithDist(lat, lon) {
    let bestDist = Infinity, bestId = null;
    for (const w of cityState.ways.values()) {
        const geo = w.geometry;
        for (let i = 0; i < geo.length - 1; i++) {
            const d = pointSegDistSq(lat, lon, geo[i][0], geo[i][1], geo[i + 1][0], geo[i + 1][1]);
            if (d < bestDist) { bestDist = d; bestId = w.id; }
        }
    }
    return { wayId: bestId, distSq: bestDist };
}

function pointSegDistSq(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) { const ex = px - ax, ey = py - ay; return ex * ex + ey * ey; }
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
    const cx = ax + t * dx, cy = ay + t * dy;
    const fx = px - cx, fy = py - cy;
    return fx * fx + fy * fy;
}

async function geocodeAddress(address) {
    let viewbox = '';
    if (cityData) {
        const lats = cityData.ways.map(w => w.geometry.map(p => p[0])).flat();
        const lons = cityData.ways.map(w => w.geometry.map(p => p[1])).flat();
        viewbox = `&viewbox=${Math.min(...lons)},${Math.max(...lats)},${Math.max(...lons)},${Math.min(...lats)}&bounded=1`;
    }
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address)}&format=json&limit=1${viewbox}`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'walk-your-city/1.0' } });
    const results = await resp.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon) };
}

function dijkstra(graph, startNodeId, penaltyFactor, extraPenalised = null) {
    const n = graph.nodeCoords.length;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Array(n).fill(null);
    dist[startNodeId] = 0;

    // Binary min-heap storing [cost, nodeId]
    const heap = [[0, startNodeId]];
    const heapSwap = (i, j) => { const t = heap[i]; heap[i] = heap[j]; heap[j] = t; };
    const heapPush = (item) => {
        heap.push(item);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            heapSwap(i, p); i = p;
        }
    };
    const heapPop = () => {
        const top = heap[0];
        const last = heap.pop();
        if (heap.length) {
            heap[0] = last;
            let i = 0;
            while (true) {
                let s = i, l = 2 * i + 1, r = 2 * i + 2;
                if (l < heap.length && heap[l][0] < heap[s][0]) s = l;
                if (r < heap.length && heap[r][0] < heap[s][0]) s = r;
                if (s === i) break;
                heapSwap(i, s); i = s;
            }
        }
        return top;
    };

    while (heap.length) {
        const [d, u] = heapPop();
        if (d > dist[u]) continue;
        for (const edge of graph.adj[u]) {
            const penalised = walks.has(edge.wayId) || (extraPenalised && extraPenalised.has(edge.wayId));
            const cost = edge.cost * (penalised ? penaltyFactor : 1);
            const nd = dist[u] + cost;
            if (nd < dist[edge.to]) {
                dist[edge.to] = nd;
                prev[edge.to] = { parentNodeId: u, wayId: edge.wayId };
                heapPush([nd, edge.to]);
            }
        }
    }
    return { dist, prev };
}

function reconstructPath(prev, endNodeId) {
    const wayIds = [];
    let cur = endNodeId;
    while (prev[cur] !== null) {
        wayIds.push(prev[cur].wayId);
        cur = prev[cur].parentNodeId;
    }
    return wayIds.reverse();
}

function routeLength(wayIds) {
    return wayIds.reduce((s, id) => s + (cityState.ways.get(id)?.length_m ?? 0), 0);
}

function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function resolveNodeForLatLon(graph, lat, lon) {
    const wayId = findClosestWay(lat, lon);
    const w = cityState.ways.get(wayId);
    if (!w) return null;
    const geo = w.geometry;
    const endA = geo[0], endB = geo[geo.length - 1];
    function sq(a, b) { return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2; }
    const coord = sq(endA, [lat, lon]) < sq(endB, [lat, lon]) ? endA : endB;
    return graph.nodeIndex.get(coord[0].toFixed(6) + ',' + coord[1].toFixed(6)) ?? null;
}

// Chain Dijkstra legs through an ordered sequence of node IDs.
// Returns concatenated wayId arrays for each leg, using penalized costs.
// walkedSoFar accumulates ways used so far as extra-penalized for subsequent legs.
function chainLegs(graph, nodeSequence) {
    const wayIds = [];
    const walkedSoFar = new Set();
    for (let i = 0; i < nodeSequence.length - 1; i++) {
        const { prev } = dijkstra(graph, nodeSequence[i], WALKED_PENALTY, walkedSoFar);
        const leg = reconstructPath(prev, nodeSequence[i + 1]);
        for (const id of leg) walkedSoFar.add(id);
        wayIds.push(...leg);
    }
    return wayIds;
}

// Greedy nearest-neighbour ordering of pinNodeIds starting from startNodeId,
// using penalized Dijkstra distances as the "cost" (lower = more new streets).
function greedyPinOrder(graph, startNodeId, pinNodeIds) {
    const remaining = pinNodeIds.slice();
    const ordered = [startNodeId];
    let current = startNodeId;
    while (remaining.length) {
        const { dist } = dijkstra(graph, current, WALKED_PENALTY);
        let bestIdx = 0, bestDist = Infinity;
        for (let i = 0; i < remaining.length; i++) {
            if (dist[remaining[i]] < bestDist) { bestDist = dist[remaining[i]]; bestIdx = i; }
        }
        current = remaining.splice(bestIdx, 1)[0];
        ordered.push(current);
    }
    return ordered;
}

function buildLoopRoute(graph, startNodeId, targetM, excludeNode = null) {
    // 3 Dijkstra calls total, no per-candidate inner loops:
    // 1. Unpenalised from start — real geographic distances for the radius band.
    // 2. Penalised from start — preferred outbound path.
    // 3. Penalised from start again but treating outbound ways as walked — preferred return path.
    //    Since the graph is undirected, dist[node] from run 3 = cheapest penalised return from that node.
    //    We run run 3 after picking the turnaround so we can pass outbound ways as extraPenalised.
    const { dist: geoDist } = dijkstra(graph, startNodeId, 1);
    const { dist: penDistOut, prev: penPrevOut } = dijkstra(graph, startNodeId, WALKED_PENALTY);

    const targetRadius = targetM / (2 * Math.PI);
    const lo = targetRadius * 0.7, hi = targetRadius * 1.3;
    const band = shuffled(
        Array.from({ length: graph.nodeCoords.length }, (_, i) => i)
             .filter(i => i !== excludeNode && geoDist[i] >= lo && geoDist[i] <= hi)
    );
    if (!band.length) throw new Error('no reachable turnaround point — try a different start or distance');

    // Use penDistOut[node] as outbound cost proxy and pick the candidate
    // whose estimated round-trip (outbound + same-cost return) is closest to targetM.
    // Since the graph is undirected, penDistOut[node] approximates the return cost too.
    const tolerance = 0.10;
    let bestNode = band[0], bestDiff = Infinity;
    for (const node of band) {
        const estimated = penDistOut[node] * 2;
        const diff = Math.abs(estimated - targetM);
        if (diff < bestDiff) { bestDiff = diff; bestNode = node; }
        if (diff <= targetM * tolerance) break;
    }

    lastTurnaroundNode = bestNode;
    const outIds = reconstructPath(penPrevOut, bestNode);
    const outSet = new Set(outIds);
    const { prev: penPrevRet } = dijkstra(graph, bestNode, WALKED_PENALTY, outSet);
    const retIds = reconstructPath(penPrevRet, startNodeId);
    return [...outIds, ...retIds];
}

function buildLinearRoute(graph, startNodeId, targetM) {
    const { dist: geoDist } = dijkstra(graph, startNodeId, 1);
    const { prev: penPrev } = dijkstra(graph, startNodeId, WALKED_PENALTY);

    const lo = targetM * 0.7, hi = targetM * 1.3;
    const band = shuffled(
        Array.from({ length: graph.nodeCoords.length }, (_, i) => i)
             .filter(i => geoDist[i] >= lo && geoDist[i] <= hi)
    );
    if (!band.length) throw new Error('no reachable endpoint at that distance — try a different start or distance');

    const tolerance = 0.10;
    let best = null, bestDiff = Infinity;
    for (const node of band) {
        const wayIds = reconstructPath(penPrev, node);
        const total = routeLength(wayIds);
        const diff = Math.abs(total - targetM);
        if (diff < bestDiff) { bestDiff = diff; best = wayIds; }
        if (diff <= targetM * tolerance) break;
    }
    return best;
}

async function generateRoute() {
    if (!cityState) { setRouteStatus('load a city first'); return; }
    if (!routeStartWayId) { setRouteStatus('click the map or enter an address to set a start point'); return; }

    const targetM = (parseFloat(document.getElementById('routeDistanceInput').value) || 5) * 1000;
    const isLoop = document.getElementById('routeLoopToggle').checked;
    const isOrdered = document.getElementById('routePinsOrderedToggle').checked;
    const btn = document.getElementById('routeGenerateBtn');
    btn.disabled = true;
    setRouteStatus('generating...');

    await new Promise(r => setTimeout(r, 20));

    try {
        if (lastRouteCity !== currentCity) {
            routeGraph = buildRouteGraph();
            lastRouteCity = currentCity;
        }

        const startNodeId = resolveNodeForLatLon(routeGraph, routeStartLatLon.lat, routeStartLatLon.lon);
        if (startNodeId === null) throw new Error('start point not on graph');

        // Resolve pins to graph nodes, skip any that fail
        const pinNodeIds = routePins
            .map(p => resolveNodeForLatLon(routeGraph, p.lat, p.lon))
            .filter(n => n !== null);

        let wayIds;
        if (pinNodeIds.length === 0) {
            // No pins — original behaviour
            wayIds = isLoop
                ? buildLoopRoute(routeGraph, startNodeId, targetM, lastTurnaroundNode)
                : buildLinearRoute(routeGraph, startNodeId, targetM);
        } else {
            // Order the pins
            const orderedNodes = isOrdered
                ? [startNodeId, ...pinNodeIds]
                : greedyPinOrder(routeGraph, startNodeId, pinNodeIds);

            if (isLoop) {
                // Chain legs through pins, then a final leg back to start
                wayIds = chainLegs(routeGraph, [...orderedNodes, startNodeId]);
            } else {
                // Chain legs through pins; last pin is the endpoint
                wayIds = chainLegs(routeGraph, orderedNodes);
            }
        }

        lastRouteWayIds = wayIds;
        renderGeneratedRoute(wayIds);
        document.getElementById('routeExportGpxBtn').style.display = '';
    } catch (err) {
        setRouteStatus('error: ' + err.message);
    } finally {
        btn.disabled = false;
    }
}

function renderGeneratedRoute(wayIds) {
    for (const pl of routeHighlight) mapRoute.removeLayer(pl);
    routeHighlight = [];

    const wayObjects = wayIds.map(id => cityState.ways.get(id)).filter(Boolean);
    let totalM = 0;
    const allCoords = [];

    for (const w of wayObjects) {
        const color = walks.has(w.id) ? ROUTE_OVERLAP_COLOR : ROUTE_COLOR;
        const pl = L.polyline(w.geometry, { color, weight: 6, opacity: 0.9 }).addTo(mapRoute);
        routeHighlight.push(pl);
        totalM += w.length_m;
        for (const c of w.geometry) allCoords.push(c);
    }

    if (allCoords.length) mapRoute.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });

    const mins = Math.round(totalM / 1000 / 5 * 60);
    const h = Math.floor(mins / 60), m = mins % 60;
    const newCount = wayIds.filter(id => !walks.has(id)).length;
    const pctNew = wayIds.length ? Math.round(newCount / wayIds.length * 100) : 0;
    setRouteStatus(`${(totalM / 1000).toFixed(1)} km · ~${h}h ${m}m · ${pctNew}% new streets`);

    renderRouteSidebar(wayObjects);
}

function renderRouteSidebar(wayObjects) {
    const list = document.getElementById('sideListRoute');
    const frag = document.createDocumentFragment();

    wayObjects.forEach((w, i) => {
        const row = document.createElement('div');
        row.className = 'seg-row';
        row.style.paddingLeft = '10px';

        const num = document.createElement('span');
        num.className = 'route-seg-num';
        num.textContent = i + 1;

        const label = document.createElement('span');
        label.className = 'seg-label';
        label.textContent = w.name + (segLabel(w) !== `${Math.round(w.length_m)} m segment` ? ' · ' + segLabel(w) : '');
        label.title = label.textContent;

        const len = document.createElement('span');
        len.className = 'seg-len';
        len.textContent = formatLength(w.length_m);

        row.appendChild(num);
        row.appendChild(label);
        row.appendChild(len);

        row.addEventListener('click', () => {
            const pl = routeHighlight[i];
            if (!pl) return;
            mapRoute.flyToBounds(L.latLngBounds(w.geometry), { padding: [60, 60], maxZoom: 17, duration: 0.4 });
            const origColor = walks.has(w.id) ? ROUTE_OVERLAP_COLOR : ROUTE_COLOR;
            pl.setStyle({ color: ROUTE_START_COLOR, weight: 10, opacity: 1 });
            setTimeout(() => pl.setStyle({ color: origColor, weight: 6, opacity: 0.9 }), 1200);
        });

        frag.appendChild(row);
    });

    list.innerHTML = '';
    list.appendChild(frag);
}

function exportGpx() {
    if (!lastRouteWayIds.length) return;
    const segments = lastRouteWayIds.map(id => cityState.ways.get(id)).filter(Boolean);
    const trkpts = segments.map(w =>
        w.geometry.map(pt => `      <trkpt lat="${pt[0]}" lon="${pt[1]}"/>`).join('\n')
    ).join('\n');
    const gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="walk-your-city" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>Generated Route</name>
    <trkseg>
${trkpts}
    </trkseg>
  </trk>
</gpx>`;
    const blob = new Blob([gpx], { type: 'application/gpx+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `route-${currentCity}-${new Date().toISOString().slice(0, 10)}.gpx`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Init ---
async function init() {
    // Mark tab map
    map = L.map('map', { preferCanvas: true }).setView([43.6532, -79.3832], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
    }).addTo(map);
    map.on('zoomend', refreshMapStyles);
    map.on('moveend', () => { if (currentCity) saveMapPos(currentCity); });
    invalidateAll();

    // History tab map
    mapHistory = L.map('mapHistory', { preferCanvas: true }).setView([43.6532, -79.3832], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
    }).addTo(mapHistory);

    // Date inputs
    document.getElementById('activeDateInput').value = activeDate;
    document.getElementById('historyDateInput').value = historyDate;
    document.getElementById('activeDateInput').addEventListener('change', e => {
        activeDate = e.target.value;
    });
    document.getElementById('historyDateInput').addEventListener('change', e => {
        historyDate = e.target.value;
        renderHistoryTab();
    });

    // Tabs
    document.getElementById('tabMarkBtn').addEventListener('click', () => switchTab('mark'));
    document.getElementById('tabHistoryBtn').addEventListener('click', () => switchTab('history'));
    document.getElementById('tabRouteBtn').addEventListener('click', () => switchTab('route'));

    // Fullscreen
    const fsButtons = {};
    function enterFullscreen(layoutId, mapObj) {
        document.getElementById(layoutId).classList.add('fullscreen');
        if (fsButtons[layoutId]) { fsButtons[layoutId].innerHTML = '✕'; fsButtons[layoutId].title = 'Exit fullscreen'; }
        if (layoutId === 'mapLayoutMark' && gpsControlBtn) gpsControlBtn.style.display = 'flex';
        setTimeout(() => mapObj.invalidateSize(), 50);
    }
    function exitFullscreen(layoutId, mapObj) {
        document.getElementById(layoutId).classList.remove('fullscreen');
        if (fsButtons[layoutId]) { fsButtons[layoutId].innerHTML = '⛶'; fsButtons[layoutId].title = 'Enter fullscreen'; }
        if (layoutId === 'mapLayoutMark' && gpsControlBtn) gpsControlBtn.style.display = 'none';
        void document.getElementById(layoutId).offsetHeight; // sync reflow before Leaflet reads container size
        mapObj.invalidateSize({ animate: false });
        if (cityState) {
            if (mapObj === map) renderMap();
            else if (mapObj === mapHistory) renderHistoryTab();
            else if (mapObj === mapRoute) renderRouteBackground();
        }
    }
    function addFullscreenControl(mapObj, layoutId) {
        const Ctrl = L.Control.extend({
            onAdd() {
                const container = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
                const btn = L.DomUtil.create('a', 'fullscreen-map-btn', container);
                btn.href = '#';
                btn.title = 'Enter fullscreen';
                btn.innerHTML = '⛶';
                fsButtons[layoutId] = btn;
                L.DomEvent.disableClickPropagation(container);
                L.DomEvent.on(btn, 'click', L.DomEvent.preventDefault);
                L.DomEvent.on(btn, 'click', () => {
                    if (document.getElementById(layoutId).classList.contains('fullscreen')) {
                        exitFullscreen(layoutId, mapObj);
                    } else {
                        enterFullscreen(layoutId, mapObj);
                    }
                });
                return container;
            },
            onRemove() {}
        });
        new Ctrl({ position: 'topright' }).addTo(mapObj);
    }
    // Route tab map
    mapRoute = L.map('mapRoute', { preferCanvas: true }).setView([43.6532, -79.3832], 12);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxZoom: 19,
    }).addTo(mapRoute);
    mapRoute.on('click', async e => {
        const { lat, lng } = e.latlng;
        if (routeMapMode === 'pin') {
            const wayId = cityState ? findClosestWay(lat, lng) : null;
            const marker = L.circleMarker([lat, lng], {
                radius: 7, color: ROUTE_PIN_COLOR, fillColor: ROUTE_PIN_COLOR, fillOpacity: 1
            }).addTo(mapRoute);
            const pin = { lat, lon: lng, wayId, marker };
            routePins.push(pin);
            marker.on('click', e => {
                L.DomEvent.stopPropagation(e);
                mapRoute.removeLayer(pin.marker);
                routePins.splice(routePins.indexOf(pin), 1);
                updatePinUI();
            });
            updatePinUI();
        } else {
            routeStartLatLon = { lat, lon: lng };
            if (routeStartMarker) mapRoute.removeLayer(routeStartMarker);
            routeStartMarker = L.circleMarker([lat, lng], { radius: 8, color: ROUTE_START_COLOR, fillColor: ROUTE_START_COLOR, fillOpacity: 1 }).addTo(mapRoute);
            if (!cityState) return;
            routeStartWayId = findClosestWay(lat, lng);
            lastTurnaroundNode = null;
            const w = cityState.ways.get(routeStartWayId);
            setRouteStatus(w ? `start: ${w.name}` : 'start set');
        }
    });

    addFullscreenControl(map, 'mapLayoutMark');
    addFullscreenControl(mapHistory, 'mapLayoutHistory');
    addFullscreenControl(mapRoute, 'mapLayoutRoute');
    addGpsControl();
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            exitFullscreen('mapLayoutMark', map);
            exitFullscreen('mapLayoutHistory', mapHistory);
            exitFullscreen('mapLayoutRoute', mapRoute);
            if (gpsTracking) stopGpsTracking();
        }
    });

    // IO
    document.getElementById('citySelect').addEventListener('change', e => {
        localStorage.setItem(LS_PREFIX + 'lastCity', e.target.value);
        loadCity(e.target.value);
    });
    document.getElementById('exportBtn').addEventListener('click', exportProgress);
    document.getElementById('resetBtn').addEventListener('click', resetData);
    document.getElementById('importInput').addEventListener('change', importProgress);
    document.getElementById('stravaInput').addEventListener('change', importStrava);
    document.getElementById('streetSearch').addEventListener('input', e => {
        filterText = e.target.value.toLowerCase();
        renderList();
        applyMarkSearch();
    });
    document.getElementById('streetSearchShowOnMap').addEventListener('change', () => {
        applyMarkSearch();
    });
    document.querySelectorAll('.walked-filter-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            walkedFilter = btn.dataset.filter;
            document.querySelectorAll('.walked-filter-btn').forEach(b => b.classList.toggle('walked-filter-btn--active', b === btn));
            renderList();
        });
    });

    // Route controls
    document.getElementById('routeDistanceInput').addEventListener('input', updateRouteTimeLabel);
    document.getElementById('routeGenerateBtn').addEventListener('click', generateRoute);
    document.getElementById('routeExportGpxBtn').addEventListener('click', exportGpx);
    document.getElementById('routeAddPinBtn').addEventListener('click', () => {
        routeMapMode = routeMapMode === 'pin' ? 'start' : 'pin';
        updatePinUI();
    });
    document.getElementById('routeClearPinsBtn').addEventListener('click', clearAllPins);
    async function handleGeocode() {
        const addr = document.getElementById('routeAddressInput').value.trim();
        if (!addr) return;
        setRouteStatus('looking up address...');
        const result = await geocodeAddress(addr);
        if (!result) { setRouteStatus('address not found'); return; }
        routeStartLatLon = result;
        if (routeStartMarker) mapRoute.removeLayer(routeStartMarker);
        routeStartMarker = L.circleMarker([result.lat, result.lon], { radius: 8, color: ROUTE_START_COLOR, fillColor: ROUTE_START_COLOR, fillOpacity: 1 }).addTo(mapRoute);
        mapRoute.setView([result.lat, result.lon], 15);
        if (cityState) {
            routeStartWayId = findClosestWay(result.lat, result.lon);
            lastTurnaroundNode = null;
            const w = cityState.ways.get(routeStartWayId);
            setRouteStatus(w ? `start: ${w.name}` : 'start set');
        }
    }
    document.getElementById('routeGeocodeBtn').addEventListener('click', handleGeocode);
    document.getElementById('routeAddressInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleGeocode();
    });



    // Auth UI wiring
    let authMode = 'signin'; // 'signin' | 'signup'
    document.getElementById('signInBtn').addEventListener('click', () => {
        authMode = 'signin';
        document.getElementById('authModalTitle').textContent = 'sign in';
        document.getElementById('submitAuthBtn').textContent = 'sign in';
        document.getElementById('toggleAuthModeBtn').textContent = 'no account? sign up';
        document.getElementById('authModalError').style.display = 'none';
        document.getElementById('signInModal').style.display = 'flex';
    });
    document.getElementById('closeSignInBtn').addEventListener('click', () => {
        document.getElementById('signInModal').style.display = 'none';
    });
    document.getElementById('toggleAuthModeBtn').addEventListener('click', () => {
        authMode = authMode === 'signin' ? 'signup' : 'signin';
        const isSignUp = authMode === 'signup';
        document.getElementById('authModalTitle').textContent = isSignUp ? 'create account' : 'sign in';
        document.getElementById('submitAuthBtn').textContent = isSignUp ? 'sign up' : 'sign in';
        document.getElementById('toggleAuthModeBtn').textContent = isSignUp ? 'have an account? sign in' : 'no account? sign up';
        document.getElementById('authModalError').style.display = 'none';
    });
    document.getElementById('submitAuthBtn').addEventListener('click', async () => {
        const email = document.getElementById('signInEmail').value.trim();
        const password = document.getElementById('signInPassword').value;
        const errEl = document.getElementById('authModalError');
        if (!email || !password) { errEl.textContent = 'email and password required'; errEl.style.display = ''; return; }
        const btn = document.getElementById('submitAuthBtn');
        const origText = btn.textContent;
        btn.disabled = true;
        btn.innerHTML = `<span class="loading-spinner" style="border-top-color:white;vertical-align:middle;margin-right:5px"></span>${origText}...`;
        try {
            const { error } = authMode === 'signup'
                ? await db.auth.signUp({ email, password })
                : await db.auth.signInWithPassword({ email, password });
            if (error) { errEl.textContent = error.message; errEl.style.display = ''; return; }
            document.getElementById('signInModal').style.display = 'none';
        } finally {
            btn.disabled = false;
            btn.textContent = origText;
        }
    });
    document.getElementById('signOutBtn').addEventListener('click', () => db.auth.signOut());

    // Auth state
    const { data: { session } } = await db.auth.getSession();
    currentUser = session?.user ?? null;
    updateAuthUI(currentUser);
    db.auth.onAuthStateChange((event, session) => {
        currentUser = session?.user ?? null;
        updateAuthUI(currentUser);
        if (event === 'SIGNED_IN') {
            migrateLocalStorageIfNeeded();
            if (currentCity) loadCity(currentCity);
        }
        if (event === 'SIGNED_OUT') { walks = new Map(); renderMap(); renderList(); updateStatus(); }
    });

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/walk-your-city/sw.js');
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') invalidateAll();
    });

    const lastCity = localStorage.getItem(LS_PREFIX + 'lastCity') || 'toronto';
    document.getElementById('citySelect').value = lastCity;
    loadCity(lastCity);
}

// --- Tab switching ---
function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tabMark').style.display = tab === 'mark' ? '' : 'none';
    document.getElementById('tabHistory').style.display = tab === 'history' ? '' : 'none';
    document.getElementById('tabRoute').style.display = tab === 'route' ? '' : 'none';
    document.getElementById('tabMarkBtn').classList.toggle('active', tab === 'mark');
    document.getElementById('tabHistoryBtn').classList.toggle('active', tab === 'history');
    document.getElementById('tabRouteBtn').classList.toggle('active', tab === 'route');
    if (tab === 'history') renderHistoryTab();
    if (tab === 'route' && cityState) renderRouteBackground();
    invalidateAll();
}

// --- Load city ---
async function loadCity(cityKey) {
    currentCity = null; // suppress saveMapPos during transition
    walks = loadProgress(cityKey);

    if (currentUser) {
        setSidebarLoading('loading your walks...');
        walks = await loadProgressFromDB(cityKey);
        saveProgress(cityKey);
    }

    expandedStreets.clear();
    filterText = '';
    walkedFilter = 'all';
    document.getElementById('streetSearch').value = '';
    document.querySelectorAll('.walked-filter-btn').forEach(b => b.classList.toggle('walked-filter-btn--active', b.dataset.filter === 'all'));
    clearMarkSearch();

    setStatus('loading...');
    clearMap();
    clearHistoryMap();
    clearRouteBackground();
    routeGraph = null; lastRouteCity = null;
    for (const pl of routeHighlight) mapRoute.removeLayer(pl);
    routeHighlight = []; lastRouteWayIds = [];
    if (routeStartMarker) { mapRoute.removeLayer(routeStartMarker); routeStartMarker = null; }
    routeStartWayId = null; routeStartLatLon = null; lastTurnaroundNode = null;
    clearAllPins();
    routeMapMode = 'start';
    document.getElementById('routeExportGpxBtn').style.display = 'none';
    setRouteStatus('');
    setSidebarLoading('loading street data...');
    document.getElementById('sideListHistory').innerHTML = '';
    document.getElementById('sideListRoute').innerHTML = '';

    let data;
    try {
        const resp = await fetch(`data/${cityKey}.json`);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        data = await resp.json();
    } catch (err) {
        setStatus(`error loading ${cityKey}: ${err.message}`);
        document.getElementById('sideList').innerHTML = `<div class="loading-msg">failed to load data.</div>`;
        return;
    }

    cityData = data;
    cityState = buildState(data);

    currentCity = cityKey;
    const savedPos = loadMapPos(cityKey);
    const center = savedPos ? [savedPos.lat, savedPos.lng] : data.center;
    const zoom = savedPos ? savedPos.zoom : data.zoom;
    map.setView(center, zoom);
    mapHistory.setView(center, zoom);
    mapRoute.setView(center, zoom);
    renderMap();
    subscribeRealtime(cityKey);
    renderList();
    updateStatus();
    if (activeTab === 'history') renderHistoryTab();
    if (activeTab === 'route') renderRouteBackground();
    invalidateAll();
}

// --- Build state ---
function buildState(data) {
    const ways = new Map();
    for (const w of data.ways) ways.set(w.id, w);

    const streets = new Map();
    for (const w of data.ways) {
        const key = 'street_' + w.name.trim().toLowerCase()
            .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (!streets.has(key)) {
            streets.set(key, { key, name: w.name, wayIds: [], totalLengthM: 0 });
        }
        const s = streets.get(key);
        s.wayIds.push(w.id);
        s.totalLengthM += w.length_m;
    }
    for (const s of streets.values()) s.totalLengthM = Math.round(s.totalLengthM);

    const streetList = [...streets.values()].sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    const totalStreets = streetList.length;
    const totalLengthM = streetList.reduce((s, st) => s + st.totalLengthM, 0);

    return { ways, streets, streetList, totalStreets, totalLengthM };
}

// --- Map rendering (mark tab) ---
function clearMap() {
    for (const pl of polylines.values()) map.removeLayer(pl);
    polylines.clear();
}

function renderMap() {
    clearMap();
    for (const w of cityState.ways.values()) {
        const date = walks.get(w.id);
        const pl = L.polyline(w.geometry, styleForMark(date)).addTo(map);
        pl.on('click', () => toggleWay(w.id));
        polylines.set(w.id, pl);
    }
}

// Rescale all polyline styles when zoom changes, without recreating them.
function refreshMapStyles() {
    if (!cityState) return;
    for (const [wayId, pl] of polylines) {
        pl.setStyle(styleForMark(walks.get(wayId)));
    }
}

function styleForMark(date) {
    const z = map ? map.getZoom() : 12;
    // Weight: thin at city-overview zoom, thick enough to click when zoomed in
    const weight = z <= 12 ? 2 : z <= 14 ? 4 : z <= 15 ? 6 : 8;
    if (!date) return { color: UNWALKED_COLOR, weight, opacity: z <= 12 ? 0.15 : 0.35 };
    if (date === activeDate) return { color: WALKED_TODAY_COLOR, weight: Math.max(weight, 4), opacity: 1 };
    return { color: WALKED_COLOR, weight: Math.max(weight, 3), opacity: z <= 12 ? 0.6 : 0.85 };
}

// --- History tab rendering ---
function clearHistoryMap() {
    for (const pl of historyPolylines.values()) mapHistory.removeLayer(pl);
    historyPolylines.clear();
}

function renderHistoryTab() {
    if (!cityState) return;
    clearHistoryMap();

    const segsOnDay = [];
    for (const w of cityState.ways.values()) {
        if (walks.get(w.id) === historyDate) segsOnDay.push(w);
    }

    // Draw all ways faintly, highlight the day's walks
    for (const w of cityState.ways.values()) {
        const isDay = walks.get(w.id) === historyDate;
        const pl = L.polyline(w.geometry, isDay
            ? { color: HISTORY_COLOR, weight: 8, opacity: 1 }
            : { color: UNWALKED_COLOR, weight: 3, opacity: 0.2 }
        ).addTo(mapHistory);
        historyPolylines.set(w.id, pl);
    }

    // Fit map to day's walks if any
    if (segsOnDay.length > 0) {
        const allCoords = segsOnDay.flatMap(w => w.geometry);
        mapHistory.fitBounds(L.latLngBounds(allCoords), { padding: [40, 40] });
    }

    renderHistoryList(segsOnDay);
    updateHistoryStatus(segsOnDay);
}

function renderHistoryList(segsOnDay) {
    const list = document.getElementById('sideListHistory');
    if (segsOnDay.length === 0) {
        list.innerHTML = '<div class="loading-msg">no walks recorded for this day</div>';
        return;
    }

    // Group by street name
    const byStreet = new Map();
    for (const w of segsOnDay) {
        const key = 'street_' + w.name.trim().toLowerCase()
            .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        if (!byStreet.has(key)) byStreet.set(key, { name: w.name, segs: [] });
        byStreet.get(key).segs.push(w);
    }

    const frag = document.createDocumentFragment();
    const sorted = [...byStreet.values()].sort(
        (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );

    for (const { name, segs } of sorted) {
        const groupEl = document.createElement('div');
        groupEl.className = 'street-group';

        const header = document.createElement('div');
        header.className = 'street-header some-walked';

        const nameEl = document.createElement('span');
        nameEl.className = 'street-name';
        nameEl.textContent = name;
        nameEl.title = name;

        const lenEl = document.createElement('span');
        lenEl.className = 'street-prog';
        lenEl.textContent = formatLength(segs.reduce((s, w) => s + w.length_m, 0));

        header.appendChild(nameEl);
        header.appendChild(lenEl);
        groupEl.appendChild(header);

        for (const w of segs) {
            const row = document.createElement('div');
            row.className = 'seg-row walked';

            const check = document.createElement('span');
            check.className = 'seg-check';
            check.textContent = '✓';

            const label = document.createElement('span');
            label.className = 'seg-label';
            label.textContent = segLabel(w);
            label.title = label.textContent;

            const len = document.createElement('span');
            len.className = 'seg-len';
            len.textContent = formatLength(w.length_m);

            row.appendChild(check);
            row.appendChild(label);
            row.appendChild(len);

            row.addEventListener('click', () => {
                const pl = historyPolylines.get(w.id);
                if (!pl) return;
                const bounds = L.latLngBounds(w.geometry);
                mapHistory.flyToBounds(bounds, { padding: [60, 60], maxZoom: 17, duration: 0.4 });
                const orig = { color: HISTORY_COLOR, weight: 5, opacity: 1 };
                pl.setStyle({ color: HIGHLIGHT_COLOR, weight: 10, opacity: 1 });
                setTimeout(() => pl.setStyle(orig), 1200);
            });

            groupEl.appendChild(row);
        }

        frag.appendChild(groupEl);
    }

    list.innerHTML = '';
    list.appendChild(frag);
}

function updateHistoryStatus(segsOnDay) {
    const totalLen = segsOnDay.reduce((s, w) => s + w.length_m, 0);
    const msg = segsOnDay.length > 0
        ? `${segsOnDay.length} segment${segsOnDay.length === 1 ? '' : 's'} · ${formatLength(totalLen)}`
        : 'no walks';
    document.getElementById('historyStatus').textContent = msg;
}

// --- List rendering (mark tab) ---
function renderList() {
    const list = document.getElementById('sideList');
    if (!cityState) return;

    let streets = filterText
        ? cityState.streetList.filter(s => s.name.toLowerCase().includes(filterText))
        : cityState.streetList;

    if (walkedFilter === 'some') {
        streets = streets.filter(s => s.wayIds.some(id => walks.has(id)));
    } else if (walkedFilter === 'full') {
        streets = streets.filter(s => s.wayIds.every(id => walks.has(id)));
    } else {
        streets = [...streets].sort((a, b) => {
            const aWalked = a.wayIds.some(id => walks.has(id)) ? 0 : 1;
            const bWalked = b.wayIds.some(id => walks.has(id)) ? 0 : 1;
            return aWalked - bWalked;
        });
    }

    if (streets.length === 0) {
        list.innerHTML = '<div class="loading-msg">no streets match</div>';
        return;
    }

    const frag = document.createDocumentFragment();
    for (const street of streets) frag.appendChild(buildStreetRow(street));
    list.innerHTML = '';
    list.appendChild(frag);
}

function buildStreetRow(street) {
    const { ways } = cityState;
    const walkedSegs = street.wayIds.filter(id => walks.has(id));
    const walkedLen = walkedSegs.reduce((s, id) => s + (ways.get(id)?.length_m ?? 0), 0);
    const isExpanded = expandedStreets.has(street.key);
    const allWalked = walkedSegs.length === street.wayIds.length;
    const someWalked = walkedSegs.length > 0;

    const wrap = document.createElement('div');
    wrap.className = 'street-group';
    wrap.dataset.streetKey = street.key;

    const header = document.createElement('div');
    header.className = 'street-header' + (allWalked ? ' all-walked' : someWalked ? ' some-walked' : '');

    const arrow = document.createElement('span');
    arrow.className = 'street-arrow';
    arrow.textContent = isExpanded ? '▾' : '▸';

    const name = document.createElement('span');
    name.className = 'street-name';
    name.textContent = street.name;
    name.title = street.name;

    const prog = document.createElement('span');
    prog.className = 'street-prog';
    prog.textContent = formatLength(walkedLen) + ' / ' + formatLength(street.totalLengthM);

    header.appendChild(arrow);
    header.appendChild(name);
    header.appendChild(prog);

    header.addEventListener('click', () => {
        if (expandedStreets.has(street.key)) {
            expandedStreets.delete(street.key);
        } else {
            expandedStreets.add(street.key);
        }
        const segList = wrap.querySelector('.seg-list');
        if (segList) { segList.remove(); arrow.textContent = '▸'; }
        else { wrap.appendChild(buildSegList(street)); arrow.textContent = '▾'; }
    });

    wrap.appendChild(header);
    if (isExpanded) wrap.appendChild(buildSegList(street));
    return wrap;
}

function buildSegList(street) {
    const { ways } = cityState;
    const segList = document.createElement('div');
    segList.className = 'seg-list';

    for (const wayId of street.wayIds) {
        const w = ways.get(wayId);
        if (!w) continue;
        const date = walks.get(wayId);
        const walked = !!date;
        const row = document.createElement('div');
        row.className = 'seg-row' + (walked ? ' walked' : '');
        row.dataset.wayId = wayId;

        const check = document.createElement('span');
        check.className = 'seg-check';
        check.textContent = walked ? '✓' : '';

        const label = document.createElement('span');
        label.className = 'seg-label';
        label.textContent = segLabel(w);
        label.title = label.textContent;

        const meta = document.createElement('span');
        meta.className = 'seg-len';
        meta.textContent = date ? date : formatLength(w.length_m);

        row.appendChild(check);
        row.appendChild(label);
        row.appendChild(meta);

        row.addEventListener('click', e => {
            e.stopPropagation();
            toggleWay(wayId);
            flyToWay(wayId);
        });

        segList.appendChild(row);
    }

    return segList;
}

function segLabel(w) {
    const from = w.from || '';
    const to = w.to || '';
    if (from && to) return `${from} → ${to}`;
    if (from) return `from ${from}`;
    if (to) return `to ${to}`;
    return `${formatLength(w.length_m)} segment`;
}

// --- Toggle a single way segment ---
async function toggleWay(wayId) {
    const nowWalked = !walks.has(wayId);
    if (nowWalked) {
        walks.set(wayId, activeDate);
    } else {
        walks.delete(wayId);
    }
    saveProgress(currentCity);

    if (currentUser) {
        if (nowWalked) {
            const { error } = await db.from('walks').upsert(
                { user_id: currentUser.id, city: currentCity, way_id: wayId, walked_on: activeDate },
                { onConflict: 'user_id,city,way_id' }
            );
            if (error) console.error('upsert failed', error);
        } else {
            const { error } = await db.from('walks').delete()
                .match({ user_id: currentUser.id, city: currentCity, way_id: wayId });
            if (error) console.error('delete failed', error);
        }
    }

    const pl = polylines.get(wayId);
    if (pl) pl.setStyle(styleForMark(walks.get(wayId)));

    const routePl = routePolylines.get(wayId);
    if (routePl) {
        const date = walks.get(wayId);
        const color = date === activeDate ? WALKED_TODAY_COLOR : date ? WALKED_COLOR : UNWALKED_COLOR;
        const opacity = date ? 0.7 : ROUTE_BG_OPACITY;
        const weight = date ? 4 : 3;
        routePl.setStyle({ color, weight, opacity });
    }

    const segRow = document.querySelector(`.seg-row[data-way-id="${CSS.escape(wayId)}"]`);
    if (segRow) {
        const date = walks.get(wayId);
        const walked = !!date;
        segRow.className = 'seg-row' + (walked ? ' walked' : '');
        segRow.querySelector('.seg-check').textContent = walked ? '✓' : '';
        const meta = segRow.querySelector('.seg-len');
        if (meta) {
            const w = cityState.ways.get(wayId);
            meta.textContent = walked ? date : (w ? formatLength(w.length_m) : '');
        }
    }

    renderList();
    updateStatus();
}

function refreshStreetHeader(streetKey) {
    const wrap = document.querySelector(`.street-group[data-street-key="${CSS.escape(streetKey)}"]`);
    if (!wrap) return;
    const street = cityState.streets.get(streetKey);
    if (!street) return;

    const { ways } = cityState;
    const walkedSegs = street.wayIds.filter(id => walks.has(id));
    const walkedLen = walkedSegs.reduce((s, id) => s + (ways.get(id)?.length_m ?? 0), 0);
    const allWalked = walkedSegs.length === street.wayIds.length;
    const someWalked = walkedSegs.length > 0;

    const header = wrap.querySelector('.street-header');
    header.className = 'street-header' + (allWalked ? ' all-walked' : someWalked ? ' some-walked' : '');
    header.querySelector('.street-prog').textContent =
        formatLength(walkedLen) + ' / ' + formatLength(street.totalLengthM);
}

// --- Fly to segment (mark tab) ---
function flyToWay(wayId) {
    const w = cityState.ways.get(wayId);
    if (!w) return;
    map.flyToBounds(L.latLngBounds(w.geometry), { padding: [60, 60], maxZoom: 17, duration: 0.4 });
    const pl = polylines.get(wayId);
    if (!pl) return;
    pl.setStyle({ color: HIGHLIGHT_COLOR, weight: 10, opacity: 1 });
    setTimeout(() => pl.setStyle(styleForMark(walks.get(wayId))), 1200);
}

// --- Status bar ---
function updateStatus() {
    if (!cityState) return;
    const { totalStreets, totalLengthM, streetList, ways } = cityState;
    let walkedStreets = 0, walkedLengthM = 0;
    for (const s of streetList) {
        if (s.wayIds.length > 0 && s.wayIds.every(id => walks.has(id))) walkedStreets++;
        for (const id of s.wayIds) {
            if (walks.has(id)) walkedLengthM += ways.get(id)?.length_m ?? 0;
        }
    }
    const pct = totalStreets > 0 ? (walkedStreets / totalStreets * 100) : 0;
    setStatus(
        `${walkedStreets} / ${totalStreets} streets  ` +
        `(${formatLength(walkedLengthM)} / ${formatLength(totalLengthM)} — ${pct.toFixed(1)}%)`
    );
    document.getElementById('progressFill').style.width = pct.toFixed(2) + '%';
}

function setStatus(msg) {
    document.getElementById('statusLine').textContent = msg;
}

function setSidebarLoading(title, sub) {
    const subHtml = sub ? `<div class="loading-msg-sub">${sub}</div>` : '';
    document.getElementById('sideList').innerHTML =
        `<div class="loading-msg"><span class="loading-spinner"></span><div class="loading-msg-text">${title}</div>${subHtml}</div>`;
}

// --- Persistence ---
// Storage format v2: { version: 2, city, walks: { wayId: 'YYYY-MM-DD' } }
// Migrates v1 (walkedIds array) on load.
function saveProgress(cityKey) {
    const data = {
        version: 2,
        city: cityKey,
        walks: Object.fromEntries(walks),
    };
    try { localStorage.setItem(LS_PREFIX + cityKey, JSON.stringify(data)); } catch (_) {}
}

function loadProgress(cityKey) {
    try {
        const raw = localStorage.getItem(LS_PREFIX + cityKey);
        if (!raw) return new Map();
        const data = JSON.parse(raw);
        // Migrate v1: walkedIds array → Map with null date
        if (data.version === 1 && Array.isArray(data.walkedIds)) {
            return new Map(data.walkedIds.map(id => [id, '']));
        }
        if (data.version === 2 && data.walks) {
            return new Map(Object.entries(data.walks));
        }
        return new Map();
    } catch (_) { return new Map(); }
}

// --- Auth UI ---
function updateAuthUI(user) {
    document.getElementById('signInBtn').style.display = user ? 'none' : '';
    document.getElementById('signOutBtn').style.display = user ? '' : 'none';
    const emailEl = document.getElementById('authEmail');
    emailEl.style.display = user ? '' : 'none';
    emailEl.textContent = user?.email ?? '';
}

// --- Supabase DB ---
async function loadProgressFromDB(cityKey) {
    const { data, error } = await db.from('walks')
        .select('way_id, walked_on')
        .eq('city', cityKey);
    if (error) { console.error('load from db failed', error); return loadProgress(cityKey); }
    return new Map(data.map(r => [r.way_id, r.walked_on]));
}

function subscribeRealtime(cityKey) {
    if (realtimeChannel) db.removeChannel(realtimeChannel);
    if (!currentUser) return;
    realtimeChannel = db.channel('walks-' + cityKey)
        .on('postgres_changes',
            { event: '*', schema: 'public', table: 'walks', filter: `city=eq.${cityKey}` },
            payload => applyRealtimeChange(payload)
        )
        .subscribe();
}

function applyRealtimeChange(payload) {
    const { eventType, new: newRow, old: oldRow } = payload;
    if (eventType === 'INSERT' || eventType === 'UPDATE') {
        walks.set(newRow.way_id, newRow.walked_on);
    } else if (eventType === 'DELETE') {
        walks.delete(oldRow.way_id);
    }
    const wayId = (newRow?.way_id ?? oldRow?.way_id);
    const pl = polylines.get(wayId);
    if (pl) pl.setStyle(styleForMark(walks.get(wayId)));
    updateStatus();
}

async function migrateLocalStorageIfNeeded() {
    if (!currentUser) return;
    const migKey = 'walkYourCity_migrated_' + currentUser.id;
    if (localStorage.getItem(migKey)) return;

    const rows = [];
    for (const cityKey of CITIES) {
        for (const [wayId, date] of loadProgress(cityKey).entries()) {
            if (wayId && date) rows.push({
                user_id: currentUser.id, city: cityKey, way_id: wayId, walked_on: date
            });
        }
    }

    if (rows.length > 0) {
        setSidebarLoading('syncing existing walks...', `0 / ${rows.length}`);
        for (let i = 0; i < rows.length; i += 500) {
            const { error } = await db.from('walks').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,city,way_id' });
            if (error) { console.error('migration failed', error); return; }
            setSidebarLoading('syncing existing walks...', `${Math.min(i + 500, rows.length)} / ${rows.length}`);
        }
    }

    localStorage.setItem(migKey, '1');
    if (rows.length > 0) setStatus(`synced ${rows.length} existing walks to your account`);
}

// --- Export ---
function exportProgress() {
    if (!currentCity) return;
    const data = { version: 2, city: currentCity, walks: Object.fromEntries(walks) };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `walk-your-city-${currentCity}-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// --- Reset ---
function resetData() {
    const msg = currentUser
        ? 'Clear all walked segments for every city? This cannot be undone.'
        : 'Clear all walked segments for every city? This cannot be undone.\n\nNote: you are not signed in, only locally stored data will be cleared.';
    if (!confirm(msg)) return;
    for (const key of CITIES) {
        localStorage.removeItem(LS_PREFIX + key);
    }
    walks = new Map();
    renderMap();
    renderList();
    updateStatus();
    if (activeTab === 'history') renderHistoryTab();
}

// --- Import ---
function importProgress(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    const reader = new FileReader();
    reader.onload = ev => {
        let data;
        try { data = JSON.parse(ev.target.result); }
        catch (_) { alert('Invalid JSON file.'); return; }

        if (data.city && data.city !== currentCity) {
            const ok = confirm(
                `This file is for "${data.city}" but you're viewing "${currentCity}".\nSwitch to ${data.city} and import?`
            );
            if (!ok) return;
            document.getElementById('citySelect').value = data.city;
            loadCity(data.city).then(() => mergeImport(data));
            return;
        }
        mergeImport(data);
    };
    reader.readAsText(file);
}

async function mergeImport(data) {
    // Accept v1 (walkedIds) or v2 (walks)
    if (data.version === 2 && data.walks) {
        for (const [id, date] of Object.entries(data.walks)) walks.set(id, date);
    } else if (Array.isArray(data.walkedIds)) {
        for (const id of data.walkedIds) if (!walks.has(id)) walks.set(id, '');
    } else {
        alert('Unrecognized format.');
        return;
    }
    saveProgress(currentCity);
    if (currentUser) {
        const rows = [];
        for (const [wayId, date] of walks.entries()) {
            if (wayId && date) rows.push({ user_id: currentUser.id, city: currentCity, way_id: wayId, walked_on: date });
        }
        for (let i = 0; i < rows.length; i += 500) {
            await db.from('walks').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,city,way_id' });
        }
    }
    renderMap();
    renderList();
    updateStatus();
}

// --- GPS Live Tracking ---

function markWayWalked(wayId, date) {
    if (walks.has(wayId)) return; // already walked, don't overwrite
    walks.set(wayId, date);
    saveProgress(currentCity);

    if (currentUser) {
        db.from('walks').upsert(
            { user_id: currentUser.id, city: currentCity, way_id: wayId, walked_on: date },
            { onConflict: 'user_id,city,way_id' }
        ).then(({ error }) => { if (error) console.error('gps upsert failed', error); });
    }

    const pl = polylines.get(wayId);
    if (pl) pl.setStyle(styleForMark(date));

    const routePl = routePolylines.get(wayId);
    if (routePl) {
        const color = date === activeDate ? WALKED_TODAY_COLOR : WALKED_COLOR;
        routePl.setStyle({ color, weight: 4, opacity: 0.7 });
    }

    const segRow = document.querySelector(`.seg-row[data-way-id="${CSS.escape(wayId)}"]`);
    if (segRow) {
        segRow.className = 'seg-row walked';
        segRow.querySelector('.seg-check').textContent = '✓';
        const meta = segRow.querySelector('.seg-len');
        if (meta) meta.textContent = date;
    }
}

function snapLivePoint(lat, lon) {
    const MAX_DIST_SQ = (30 / 111111) ** 2;
    const { wayId, distSq } = findClosestWayWithDist(lat, lon);
    if (!wayId || distSq > MAX_DIST_SQ) return;

    const way = cityState.ways.get(wayId);
    const { t } = projectOntoWay(lat, lon, way.geometry);

    if (gpsCoverage.has(wayId)) {
        const c = gpsCoverage.get(wayId);
        if (t < c.minT) c.minT = t;
        if (t > c.maxT) c.maxT = t;
    } else {
        gpsCoverage.set(wayId, { minT: t, maxT: t });
    }

    const { minT, maxT } = gpsCoverage.get(wayId);
    const coveredM = (maxT - minT) * way.length_m;
    if ((coveredM >= 40 || coveredM >= 0.5 * way.length_m) && !gpsSessionWalked.has(wayId) && !walks.has(wayId)) {
        const today = todayStr();
        gpsSessionWalked.add(wayId);

        // Count new full streets
        const streetKey = 'street_' + way.name.trim().toLowerCase()
            .replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
        const street = cityState.streets.get(streetKey);
        if (street) {
            const prevAllWalked = street.wayIds.every(id => walks.has(id));
            markWayWalked(wayId, today);
            const nowAllWalked = street.wayIds.every(id => walks.has(id));
            if (!prevAllWalked && nowAllWalked) gpsSessionNewStreets++;
        } else {
            markWayWalked(wayId, today);
        }

        updateGpsStats();
        renderList();
        updateStatus();
    }
}

function updateGpsStats() {
    document.getElementById('gpsStatWays').textContent = gpsSessionWalked.size;
    document.getElementById('gpsStatKm').textContent = gpsSessionKm.toFixed(2);
    document.getElementById('gpsStatStreets').textContent = gpsSessionNewStreets;
}

function onGpsPosition(pos) {
    const { latitude: lat, longitude: lon, accuracy } = pos.coords;

    // Update km walked
    if (gpsPrevLatLon) {
        const dlat = lat - gpsPrevLatLon.lat;
        const dlon = lon - gpsPrevLatLon.lon;
        const distM = Math.sqrt(dlat * dlat + dlon * dlon) * 111111;
        if (distM < 200) gpsSessionKm += distM / 1000; // ignore GPS jumps > 200m
    }
    gpsPrevLatLon = { lat, lon };

    // Update position marker
    if (!gpsMarker) {
        gpsMarker = L.circleMarker([lat, lon], {
            radius: 9, color: 'white', weight: 2,
            fillColor: '#2563eb', fillOpacity: 1,
            zIndexOffset: 1000
        }).addTo(map);
        gpsAccuracyCircle = L.circle([lat, lon], {
            radius: accuracy,
            color: '#2563eb', weight: 1,
            fillColor: '#2563eb', fillOpacity: 0.12
        }).addTo(map);
    } else {
        gpsMarker.setLatLng([lat, lon]);
        gpsAccuracyCircle.setLatLng([lat, lon]);
        gpsAccuracyCircle.setRadius(accuracy);
    }

    map.panTo([lat, lon], { animate: true, duration: 0.5 });

    if (cityState) snapLivePoint(lat, lon);
    updateGpsStats();
}

function onGpsError(err) {
    const msgs = {
        1: 'Location permission denied. Enable it in your browser settings.',
        2: 'Location unavailable. Check your GPS signal.',
        3: 'Location request timed out. Try again.'
    };
    if (gpsTracking) {
        document.getElementById('gpsStatWays').textContent = '—';
        document.getElementById('gpsStatKm').textContent = msgs[err.code] || 'GPS error';
        document.getElementById('gpsStatStreets').textContent = '—';
    }
    if (err.code === 1) stopGpsTracking();
}

function startGpsTracking() {
    if (!navigator.geolocation) {
        alert('Geolocation is not supported by your browser.');
        return;
    }
    gpsTracking = true;
    gpsTrackPoints = [];
    gpsCoverage = new Map();
    gpsSessionWalked = new Set();
    gpsSessionNewStreets = 0;
    gpsSessionKm = 0;
    gpsPrevLatLon = null;

    document.getElementById('gpsStatsOverlay').classList.add('gps-active');
    updateGpsStats();

    if (!document.getElementById('mapLayoutMark').classList.contains('fullscreen')) {
        enterFullscreen('mapLayoutMark', map);
    }

    gpsWatchId = navigator.geolocation.watchPosition(onGpsPosition, onGpsError, {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000
    });
}

function stopGpsTracking() {
    gpsTracking = false;
    if (gpsWatchId !== null) {
        navigator.geolocation.clearWatch(gpsWatchId);
        gpsWatchId = null;
    }
    if (gpsMarker) { map.removeLayer(gpsMarker); gpsMarker = null; }
    if (gpsAccuracyCircle) { map.removeLayer(gpsAccuracyCircle); gpsAccuracyCircle = null; }
    document.getElementById('gpsStatsOverlay').classList.remove('gps-active');
    gpsPrevLatLon = null;
    if (gpsControlBtn) {
        gpsControlBtn.classList.remove('gps-btn-active');
        gpsControlBtn.innerHTML = '⊙';
        gpsControlBtn.title = 'Start GPS walk';
        gpsControlBtn.style.animation = '';
    }
}

function addGpsControl() {
    const btn = document.createElement('button');
    btn.className = 'gps-track-btn';
    btn.title = 'Start GPS walk';
    btn.innerHTML = '⊙';
    btn.style.display = 'none';
    gpsControlBtn = btn;
    btn.addEventListener('click', e => {
        e.stopPropagation();
        if (gpsTracking) {
            stopGpsTracking();
        } else {
            startGpsTracking();
            btn.classList.add('gps-btn-active');
            btn.innerHTML = '●';
            btn.title = 'Stop GPS walk';
            btn.style.animation = 'gps-pulse 1.2s ease-in-out infinite';
        }
    });
    document.getElementById('mapLayoutMark').appendChild(btn);
}

// --- Strava GPX/TCX Import ---

function parseGpxFile(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const trkpts = doc.querySelectorAll('trkpt');
    const points = [];
    for (const pt of trkpts) {
        const lat = parseFloat(pt.getAttribute('lat'));
        const lon = parseFloat(pt.getAttribute('lon'));
        if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon });
    }
    const timeEl = doc.querySelector('metadata > time') || doc.querySelector('trkpt > time');
    const date = timeEl ? timeEl.textContent.trim().slice(0, 10) : null;
    return { points, date };
}

function parseTcxFile(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    const trackpoints = doc.querySelectorAll('Trackpoint');
    const points = [];
    for (const tp of trackpoints) {
        const latEl = tp.querySelector('LatitudeDegrees');
        const lonEl = tp.querySelector('LongitudeDegrees');
        if (!latEl || !lonEl) continue;
        const lat = parseFloat(latEl.textContent);
        const lon = parseFloat(lonEl.textContent);
        if (!isNaN(lat) && !isNaN(lon)) points.push({ lat, lon });
    }
    const timeEl = doc.querySelector('Activity > Id') || doc.querySelector('Trackpoint > Time');
    const date = timeEl ? timeEl.textContent.trim().slice(0, 10) : null;
    return { points, date };
}

// Returns the t parameter (0–1) of the closest point on the polyline to (lat, lon),
// where 0 = start of way and 1 = end, weighted by segment lengths.
function projectOntoWay(lat, lon, geo) {
    let bestDistSq = Infinity, bestT = 0, totalLen = 0;
    // Compute total length in degree-space to convert segment t to global t
    const segLens = [];
    for (let i = 0; i < geo.length - 1; i++) {
        const dx = geo[i+1][1] - geo[i][1], dy = geo[i+1][0] - geo[i][0];
        segLens.push(Math.sqrt(dx*dx + dy*dy));
        totalLen += segLens[i];
    }
    let accumulated = 0;
    for (let i = 0; i < geo.length - 1; i++) {
        const ax = geo[i][0], ay = geo[i][1], bx = geo[i+1][0], by = geo[i+1][1];
        const dx = bx - ax, dy = by - ay;
        const lenSq = dx*dx + dy*dy;
        let segT = 0;
        if (lenSq > 0) segT = Math.max(0, Math.min(1, ((lat-ax)*dx + (lon-ay)*dy) / lenSq));
        const cx = ax + segT*dx, cy = ay + segT*dy;
        const fx = lat-cx, fy = lon-cy;
        const d = fx*fx + fy*fy;
        if (d < bestDistSq) {
            bestDistSq = d;
            bestT = totalLen > 0 ? (accumulated + segT * segLens[i]) / totalLen : 0;
        }
        accumulated += segLens[i];
    }
    return { t: bestT, distSq: bestDistSq };
}

async function snapTrackToWays(points, date, onProgress) {
    const MAX_DIST_SQ = (30 / 111111) ** 2;
    const wayCoverage = new Map();
    const CHUNK = 400; // process 200 sampled points (every other) per chunk

    for (let i = 0; i < points.length; i += CHUNK) {
        const end = Math.min(i + CHUNK, points.length);
        for (let j = i; j < end; j += 2) {
            const { lat, lon } = points[j];
            const { wayId, distSq } = findClosestWayWithDist(lat, lon);
            if (!wayId || distSq > MAX_DIST_SQ) continue;

            const way = cityState.ways.get(wayId);
            const { t } = projectOntoWay(lat, lon, way.geometry);
            if (wayCoverage.has(wayId)) {
                const c = wayCoverage.get(wayId);
                if (t < c.minT) c.minT = t;
                if (t > c.maxT) c.maxT = t;
            } else {
                wayCoverage.set(wayId, { minT: t, maxT: t });
            }
        }
        if (onProgress) onProgress(Math.min(end, points.length), points.length);
        await new Promise(r => setTimeout(r, 0));
    }

    const walkDate = date || todayStr();
    const result = new Map();
    for (const [wayId, { minT, maxT }] of wayCoverage) {
        const way = cityState.ways.get(wayId);
        const coveredM = (maxT - minT) * way.length_m;
        if (coveredM >= 40 || coveredM >= 0.5 * way.length_m) {
            result.set(wayId, walkDate);
        }
    }
    return result;
}

async function importStrava(e) {
    const file = e.target.files[0];
    if (!file) return;
    e.target.value = '';
    if (!cityState) { alert('Load a city first.'); return; }

    const text = await file.text();
    const ext = file.name.split('.').pop().toLowerCase();
    let parsed;
    try {
        parsed = ext === 'tcx' ? parseTcxFile(text) : parseGpxFile(text);
    } catch (_) { alert('Could not parse file.'); return; }

    if (!parsed.points.length) { alert('No GPS trackpoints found in file.'); return; }

    const total = parsed.points.length;
    setSidebarLoading('matching streets...', `0 / ${Math.ceil(total / 2)} points`);
    const matched = await snapTrackToWays(parsed.points, parsed.date, (done, all) => {
        setSidebarLoading('matching streets...', `${Math.ceil(done / 2)} / ${Math.ceil(all / 2)} points`);
    });
    if (!matched.size) { alert('No streets matched. Make sure the activity is in the currently selected city.'); return; }

    const newOnly = new Map();
    for (const [wayId, date] of matched) {
        if (!walks.has(wayId)) { walks.set(wayId, date); newOnly.set(wayId, date); }
    }
    saveProgress(currentCity);

    if (currentUser) {
        const rows = [];
        for (const [wayId, date] of newOnly) {
            if (wayId && date) rows.push({ user_id: currentUser.id, city: currentCity, way_id: wayId, walked_on: date });
        }
        if (rows.length > 0) {
            setSidebarLoading('saving to account...', `0 / ${rows.length} streets`);
            for (let i = 0; i < rows.length; i += 500) {
                await db.from('walks').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,city,way_id' });
                setSidebarLoading('saving to account...', `${Math.min(i + 500, rows.length)} / ${rows.length} streets`);
            }
        }
    }

    setSidebarLoading('updating map...');
    await new Promise(r => setTimeout(r, 0));

    renderMap();
    renderList();
    updateStatus();
    const skipped = matched.size - newOnly.size;
    const skipNote = skipped > 0 ? `${skipped} already claimed, skipped` : '';
    const sideList = document.getElementById('sideList');
    const banner = document.createElement('div');
    banner.className = 'import-banner';
    banner.innerHTML = `<span class="import-banner-title">imported ${newOnly.size} street${newOnly.size === 1 ? '' : 's'}</span>`
        + `<span class="import-banner-sub">from ${file.name}</span>`
        + (skipNote ? `<span class="import-banner-sub">${skipNote}</span>` : '');
    sideList.prepend(banner);
    setTimeout(() => {
        banner.classList.add('dismissed');
        banner.addEventListener('transitionend', () => banner.remove(), { once: true });
    }, 3000);
}

init();
