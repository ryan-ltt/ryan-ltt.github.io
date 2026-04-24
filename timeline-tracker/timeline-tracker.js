// ── Storage / migration ────────────────────────────────────────────────────

const LS_KEY = 'timelineTrackerData';

// Migrate entries that used the old flat transitMode/transitRef/transitGeoJSON fields
function migrateEntry(e) {
    if (e.kind !== 'activity') return e;
    if (!e.transitSegments) {
        if (e.transitRef) {
            e.transitSegments = [{
                mode: e.transitMode || 'bus',
                ref: e.transitRef,
                entryStation: null,
                exitStation: null,
                fullGeoJSON: e.transitGeoJSON,
                geoJSON: e.transitGeoJSON,
            }];
        } else {
            e.transitSegments = [];
        }
        delete e.transitMode;
        delete e.transitRef;
        delete e.transitGeoJSON;
    }
    return e;
}

function loadStore() {
    try {
        const raw = localStorage.getItem(LS_KEY);
        const store = raw
            ? JSON.parse(raw)
            : { version: 1, entries: [], deletedIds: [] };
        store.entries = store.entries.map(migrateEntry);
        if (!store.savedPlaces) store.savedPlaces = {};
        if (!('Home' in store.savedPlaces)) store.savedPlaces.Home = null;
        return store;
    } catch {
        return { version: 1, entries: [], deletedIds: [], savedPlaces: { Home: null } };
    }
}

function saveStore(store) {
    localStorage.setItem(LS_KEY, JSON.stringify(store));
}

// ── Deterministic id ───────────────────────────────────────────────────────

function djb2(str) {
    let h = 5381;
    for (let i = 0; i < str.length; i++) {
        h = (Math.imul(h, 33) ^ str.charCodeAt(i)) >>> 0;
    }
    return h.toString(36);
}

function makeId(entry) {
    const parts = [entry.startTime, entry.endTime];
    if (entry.kind === 'visit') {
        parts.push(String(entry.lat), String(entry.lng));
    } else {
        parts.push(String(entry.startLat), String(entry.startLng), String(entry.endLat), String(entry.endLng));
    }
    return entry.kind + '_' + djb2(parts.join('|'));
}

// ── Parsing ────────────────────────────────────────────────────────────────

function parseGeo(geoStr) {
    if (!geoStr) return null;
    const m = geoStr.match(/geo:([-\d.]+),([-\d.]+)/);
    if (!m) return null;
    return { lat: parseFloat(m[1]), lng: parseFloat(m[2]) };
}

function parseGoogleTimeline(data) {
    const entries = [];
    const raw = Array.isArray(data) ? data : (data.timelineObjects || data.semanticSegments || []);
    for (const item of raw) {
        try {
            if (item.visit) {
                const v = item.visit;
                const loc = parseGeo(v.topCandidate && v.topCandidate.placeLocation);
                if (!loc) continue;
                const entry = {
                    kind: 'visit',
                    startTime: item.startTime,
                    endTime: item.endTime,
                    lat: loc.lat,
                    lng: loc.lng,
                    placeID: v.topCandidate && v.topCandidate.placeId,
                    semanticType: v.topCandidate && v.topCandidate.semanticType,
                };
                entry.id = makeId(entry);
                entries.push(entry);
            } else if (item.activity) {
                const a = item.activity;
                const start = parseGeo(a.start);
                const end = parseGeo(a.end);
                if (!start || !end) continue;
                const entry = {
                    kind: 'activity',
                    startTime: item.startTime,
                    endTime: item.endTime,
                    startLat: start.lat,
                    startLng: start.lng,
                    endLat: end.lat,
                    endLng: end.lng,
                    activityType: a.topCandidate && a.topCandidate.type,
                    distanceMeters: a.distanceMeters || null,
                    routeGeoJSON: null,
                    transitSegments: [],
                };
                entry.id = makeId(entry);
                entries.push(entry);
            }
        } catch (_) {
            // skip malformed entries
        }
    }
    return entries;
}

// ── OSRM road path ─────────────────────────────────────────────────────────

const OSRM_CAP = 100;
let osrmCount = 0;
const osrmDelay = ms => new Promise(r => setTimeout(r, ms));

async function fetchOsrmRoute(startLat, startLng, endLat, endLng, waypoints) {
    if (osrmCount >= OSRM_CAP) return null;
    osrmCount++;
    try {
        await osrmDelay(100);
        const pts = [
            [startLng, startLat],
            ...(waypoints || []).map(wp => [wp.lng, wp.lat]),
            [endLng, endLat],
        ];
        const coord = pts.map(([lng, lat]) => `${lng},${lat}`).join(';');
        const url = `https://router.project-osrm.org/route/v1/driving/${coord}?overview=full&geometries=geojson`;
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const json = await resp.json();
        if (json.code !== 'Ok' || !json.routes || !json.routes[0]) return null;
        return json.routes[0].geometry;
    } catch {
        return null;
    }
}

// ── Transit ────────────────────────────────────────────────────────────────

// Per-route colour palette (used for non-transit activity lines)
const ROUTE_COLORS = [
    '#2563eb', // blue
    '#dc2626', // red
    '#16a34a', // green
    '#9333ea', // purple
    '#ea580c', // orange
    '#0891b2', // cyan
    '#b45309', // amber
    '#be185d', // pink
];

const TRANSIT_COLORS = {
    bus:        '#e67e22',
    subway:     '#c0392b',
    tram:       '#27ae60',
    light_rail: '#8e44ad',
    ferry:      '#16a085',
    train:      '#2c3e50',
};

function transitColor(mode) {
    return TRANSIT_COLORS[mode] || '#2980b9';
}

function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function queryOverpass(mode, ref, city) {
    const safeRef = ref.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    let areaFilter = '';
    let areaSuffix = '';
    if (city) {
        areaFilter = `area["name"~"^${escapeRegex(city)}$",i]->.a;\n`;
        areaSuffix = '(area.a)';
    }
    const query =
        `[out:json][timeout:30];\n` +
        areaFilter +
        `(relation[type=route][route=${mode}][ref="${safeRef}"]${areaSuffix};\n` +
        ` relation[type=route][route=${mode}][name~"${safeRef}",i]${areaSuffix};);\n` +
        `out geom qt;`;

    const resp = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'data=' + encodeURIComponent(query),
    });
    if (!resp.ok) throw new Error(`Overpass returned ${resp.status}`);
    const json = await resp.json();
    return json.elements || [];
}

function stitchWays(ways) {
    if (ways.length === 0) return [];
    const segments = ways.map(w => w.geometry.map(p => [p.lat, p.lon]));
    const result = [...segments[0]];
    const used = new Set([0]);

    while (used.size < segments.length) {
        const tail = result[result.length - 1];
        let bestIdx = -1, bestDist = Infinity, bestReverse = false;
        for (let i = 0; i < segments.length; i++) {
            if (used.has(i)) continue;
            const seg = segments[i];
            const dFwd = Math.hypot(tail[0] - seg[0][0], tail[1] - seg[0][1]);
            const dRev = Math.hypot(tail[0] - seg[seg.length - 1][0], tail[1] - seg[seg.length - 1][1]);
            if (dFwd < bestDist) { bestDist = dFwd; bestIdx = i; bestReverse = false; }
            if (dRev < bestDist) { bestDist = dRev; bestIdx = i; bestReverse = true; }
        }
        if (bestIdx === -1) break;

        const seg = segments[bestIdx];
        const ordered = bestReverse ? [...seg].reverse() : seg;

        used.add(bestIdx);
        // Skip duplicate junction point when the new segment starts at the tail
        const connDist = Math.hypot(tail[0] - ordered[0][0], tail[1] - ordered[0][1]);
        result.push(...ordered.slice(connDist < 1e-9 ? 1 : 0));
    }
    return result;
}

function overpassToGeoJSON(relation) {
    // Only include actual route ways; exclude platform/stop-area ways which
    // can be closed loops and cause the stitcher to create visible circles.
    const nonRouteRoles = new Set(['platform', 'hail_and_ride', 'stop']);
    const ways = (relation.members || [])
        .filter(m => m.type === 'way' && m.geometry && m.geometry.length > 0
                  && !nonRouteRoles.has(m.role));
    const latLngs = stitchWays(ways);
    if (latLngs.length === 0) return null;
    return {
        type: 'LineString',
        coordinates: latLngs.map(([lat, lng]) => [lng, lat]), // GeoJSON = [lng, lat]
    };
}

// Extract GeoJSON for the segment of a route relation between two stop nodes.
// OSM route relations list members (stop nodes + way members) in travel order.
// We find the member-array indices of the entry and exit stop nodes, then keep
// only the way members whose member-array index falls between those two indices.
// This is more reliable than coordinate-distance clipping because it doesn't
// depend on the stop node coordinates aligning with the way geometry.
// Falls back to the full route if the stop nodes aren't found in the members.
function extractSegmentGeoJSON(relation, entryStop, exitStop) {
    const nonRouteRoles = new Set(['platform', 'hail_and_ride', 'stop']);
    const members = relation.members || [];

    // Collect eligible way members with their member-array position
    const wayEntries = [];
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (m.type === 'way' && m.geometry?.length >= 2 && !nonRouteRoles.has(m.role)) {
            wayEntries.push({ idx: i, m });
        }
    }
    if (wayEntries.length === 0) return null;

    // Find member-array positions of the entry/exit stop nodes
    let entryMemberIdx = -1, exitMemberIdx = -1;
    for (let i = 0; i < members.length; i++) {
        const m = members[i];
        if (m.type !== 'node') continue;
        if (entryStop && m.ref === entryStop.ref && entryMemberIdx === -1) entryMemberIdx = i;
        if (exitStop  && m.ref === exitStop.ref  && exitMemberIdx  === -1) exitMemberIdx  = i;
    }

    // If both stops were found, filter to ways between them
    if (entryMemberIdx !== -1 && exitMemberIdx !== -1) {
        const lo = Math.min(entryMemberIdx, exitMemberIdx);
        const hi = Math.max(entryMemberIdx, exitMemberIdx);
        const between = wayEntries.filter(e => e.idx >= lo && e.idx <= hi).map(e => e.m);
        // Only use the filtered set if it produced some ways; otherwise fall through to full route
        if (between.length > 0) {
            const latLngs = stitchWays(between);
            if (latLngs.length > 0) {
                return { type: 'LineString', coordinates: latLngs.map(([lat, lng]) => [lng, lat]) };
            }
        }
    }

    // Fallback: stitch all ways and clip by coordinates
    const allLatLngs = stitchWays(wayEntries.map(e => e.m));
    if (!allLatLngs.length) return null;
    const fullGeo = { type: 'LineString', coordinates: allLatLngs.map(([lat, lng]) => [lng, lat]) };

    if (!entryStop && !exitStop) return fullGeo;

    // Coordinate-distance fallback: find closest point for each stop
    const coords = fullGeo.coordinates;
    function closestIdx(lat, lng) {
        let best = 0, bestD = Infinity;
        for (let i = 0; i < coords.length; i++) {
            const d = Math.hypot(coords[i][1] - lat, coords[i][0] - lng);
            if (d < bestD) { bestD = d; best = i; }
        }
        return best;
    }
    const i1 = entryStop ? closestIdx(entryStop.lat, entryStop.lng) : 0;
    const i2 = exitStop  ? closestIdx(exitStop.lat,  exitStop.lng)  : coords.length - 1;
    const lo = Math.min(i1, i2), hi = Math.max(i1, i2);
    if (hi <= lo) return fullGeo;
    return { type: 'LineString', coordinates: coords.slice(lo, hi + 1) };
}

// ── State ──────────────────────────────────────────────────────────────────

let store = loadStore();
let viewMode = 'day';
let selectedDay = null;
let mapInstance = null;
let mapLayers = [];
let transitPanelOpenId = null;
let transitSearchContext = null; // { id, mode, ref, results }
let transitInsertIdx = null;     // null = append; number = splice before that index
let visitLabelPanelOpenId = null;
let waypointPanelOpenId = null;  // also acts as the "map-click adds waypoint" flag
let modePanelOpenId = null;
let editOptionsOpenId = null;
let addRoutePickMode = null; // 'start' | 'end' | null
let newRoutePending = { startLat: null, startLng: null, endLat: null, endLng: null };
let editingRouteId = null;

// ── Map helpers ────────────────────────────────────────────────────────────

function initMap() {
    if (mapInstance) return;
    mapInstance = L.map('map').setView([20, 0], 2);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
    }).addTo(mapInstance);

    mapInstance.on('click', ev => {
        const { lat, lng } = ev.latlng;

        if (addRoutePickMode) {
            const fmt = (n) => n.toFixed(5);
            if (addRoutePickMode === 'start') {
                newRoutePending.startLat = lat;
                newRoutePending.startLng = lng;
                document.getElementById('newRouteStartCoord').textContent = `${fmt(lat)}, ${fmt(lng)}`;
                document.getElementById('newRouteStartPlace').value = '';
            } else if (addRoutePickMode === 'end') {
                newRoutePending.endLat = lat;
                newRoutePending.endLng = lng;
                document.getElementById('newRouteEndCoord').textContent = `${fmt(lat)}, ${fmt(lng)}`;
                document.getElementById('newRouteEndPlace').value = '';
            }
            addRoutePickMode = null;
            document.getElementById('map').classList.remove('waypoint-adding');
            document.getElementById('pickStartBtn').classList.remove('active');
            document.getElementById('pickEndBtn').classList.remove('active');
            return;
        }

        if (!waypointPanelOpenId) return;
        const entry = store.entries.find(e => e.id === waypointPanelOpenId);
        if (!entry) return;
        if (!entry.waypoints) entry.waypoints = [];
        entry.waypoints.push({ lat, lng });
        entry.routeGeoJSON = null; // force re-route through new waypoint
        saveStore(store);
        render();
    });
}

function clearMapLayers() {
    for (const layer of mapLayers) mapInstance.removeLayer(layer);
    mapLayers = [];
}

function fitBoundsIfAny(bounds) {
    if (bounds.isValid()) mapInstance.fitBounds(bounds, { padding: [40, 40] });
}

function formatTime(iso) {
    if (!iso) return '';
    try {
        return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    } catch {
        return iso.slice(11, 16);
    }
}

function timeHHMM(isoStr) {
    if (!isoStr) return '';
    const m = isoStr.match(/T(\d{2}:\d{2})/);
    return m ? m[1] : '';
}

function dayOf(entry) {
    return (entry.startTime || '').slice(0, 10);
}

// ── Time edit panel ────────────────────────────────────────────────────────

let timePanelOpenId = null;

function timePanelHtml(e) {
    return `<div class="transit-form">
        <div class="transit-form-label">edit times</div>
        <div class="transit-form-row">
            <div style="display:flex;flex-direction:column;gap:3px;flex:1">
                <span class="transit-form-label">start</span>
                <input type="time" class="time-edit-start transit-entry-input" value="${timeHHMM(e.startTime)}">
            </div>
            <div style="display:flex;flex-direction:column;gap:3px;flex:1">
                <span class="transit-form-label">end</span>
                <input type="time" class="time-edit-end transit-entry-input" value="${timeHHMM(e.endTime)}">
            </div>
        </div>
        <button class="transit-search-btn time-edit-save-btn" style="align-self:flex-end">save</button>
    </div>`;
}

function toggleTimePanel(id) {
    if (timePanelOpenId === id) {
        const panel = document.getElementById(`time-panel-${id}`);
        if (panel) panel.style.display = 'none';
        const btn = document.querySelector(`.time-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.remove('active');
        timePanelOpenId = null;
    } else {
        if (timePanelOpenId) {
            const prev = document.getElementById(`time-panel-${timePanelOpenId}`);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`.time-toggle-btn[data-id="${timePanelOpenId}"]`);
            if (prevBtn) prevBtn.classList.remove('active');
        }
        timePanelOpenId = id;
        const panel = document.getElementById(`time-panel-${id}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`.time-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
        wireTimePanel(id);
    }
}

function wireTimePanel(id) {
    const panel = document.getElementById(`time-panel-${id}`);
    if (!panel) return;
    panel.querySelector('.time-edit-save-btn').addEventListener('click', () => {
        const entry = store.entries.find(e => e.id === id);
        if (!entry) return;
        const startVal = panel.querySelector('.time-edit-start').value;
        const endVal   = panel.querySelector('.time-edit-end').value;
        const day = dayOf(entry);
        if (startVal) entry.startTime = `${day}T${startVal}:00`;
        if (endVal)   entry.endTime   = `${day}T${endVal}:00`;
        saveStore(store);
        render();
    });
}

// ── Activity mode panel ────────────────────────────────────────────────────

const ACTIVITY_MODES = [
    'walking', 'running', 'cycling',
    'in passenger vehicle', 'in subway', 'in bus', 'in tram', 'in train',
    'in ferry', 'flying', 'skiing', 'sailing',
];

function modePanelHtml(e) {
    const current = e.activityType || '';
    const options = ACTIVITY_MODES.includes(current)
        ? ACTIVITY_MODES
        : [current, ...ACTIVITY_MODES].filter(Boolean);
    return `<div class="transit-form">
        <div class="transit-form-label">activity mode</div>
        <div class="transit-form-row">
            <select class="mode-type-select transit-mode-select">
                ${options.map(m => `<option value="${m}"${current === m ? ' selected' : ''}>${m}</option>`).join('')}
            </select>
            <button class="transit-search-btn mode-save-btn">save</button>
        </div>
    </div>`;
}

function toggleModePanel(id) {
    if (modePanelOpenId === id) {
        const panel = document.getElementById(`mode-panel-${id}`);
        if (panel) panel.style.display = 'none';
        const btn = document.querySelector(`.mode-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.remove('active');
        modePanelOpenId = null;
    } else {
        if (modePanelOpenId) {
            const prev = document.getElementById(`mode-panel-${modePanelOpenId}`);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`.mode-toggle-btn[data-id="${modePanelOpenId}"]`);
            if (prevBtn) prevBtn.classList.remove('active');
        }
        modePanelOpenId = id;
        const panel = document.getElementById(`mode-panel-${id}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`.mode-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
        wireModePanel(id);
    }
}

function wireModePanel(id) {
    const panel = document.getElementById(`mode-panel-${id}`);
    if (!panel) return;
    const saveBtn = panel.querySelector('.mode-save-btn');
    const select  = panel.querySelector('.mode-type-select');
    if (saveBtn) saveBtn.addEventListener('click', () => {
        const entry = store.entries.find(e => e.id === id);
        if (!entry || !select) return;
        entry.activityType = select.value;
        saveStore(store);
        render();
    });
}

// ── Edit options row ──────────────────────────────────────────────────────

function toggleEditOptions(id) {
    const close = (eid) => {
        const row = document.getElementById(`edit-sub-${eid}`);
        if (row) row.style.display = 'none';
        const btn = document.querySelector(`.edit-options-btn[data-id="${eid}"]`);
        if (btn) btn.classList.remove('active');
    };
    if (editOptionsOpenId === id) {
        close(id);
        editOptionsOpenId = null;
    } else {
        if (editOptionsOpenId) close(editOptionsOpenId);
        editOptionsOpenId = id;
        const row = document.getElementById(`edit-sub-${id}`);
        if (row) row.style.display = '';
        const btn = document.querySelector(`.edit-options-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
    }
}

// ── Side list ──────────────────────────────────────────────────────────────

function buildSideList(visibleEntries) {
    const el = document.getElementById('sideList');
    if (visibleEntries.length === 0) {
        el.innerHTML = '<div class="side-empty">no entries</div>';
        return;
    }

    let routeIdx = 0;
    el.innerHTML = visibleEntries.map(e =>
        e.kind === 'visit' ? visitItemHtml(e) : activityItemHtml(e, routeIdx++)
    ).join('');

    el.querySelectorAll('.side-item').forEach(item => {
        item.addEventListener('click', () => flyToEntry(item.dataset.id));
    });
    el.querySelectorAll('.delete-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            deleteEntry(btn.dataset.id);
        });
    });
    el.querySelectorAll('.edit-options-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleEditOptions(btn.dataset.id);
        });
    });
    el.querySelectorAll('.route-edit-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            openEditRoute(btn.dataset.id);
        });
    });
    el.querySelectorAll('.transit-toggle-btn').forEach(btn => {
        if (btn.classList.contains('edit-options-btn')) return;
        if (btn.classList.contains('place-label-btn')) return;
        if (btn.classList.contains('waypoint-toggle-btn')) return;
        if (btn.classList.contains('mode-toggle-btn')) return;
        if (btn.classList.contains('time-toggle-btn')) return;
        if (btn.classList.contains('route-edit-btn')) return;
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleTransitPanel(btn.dataset.id);
        });
    });
    el.querySelectorAll('.waypoint-toggle-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleWaypointPanel(btn.dataset.id);
        });
    });
    el.querySelectorAll('.mode-toggle-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleModePanel(btn.dataset.id);
        });
    });
    el.querySelectorAll('.time-toggle-btn').forEach(btn => {
        if (btn.classList.contains('place-label-btn')) return;
        if (btn.classList.contains('waypoint-toggle-btn')) return;
        if (btn.classList.contains('mode-toggle-btn')) return;
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleTimePanel(btn.dataset.id);
        });
    });
    el.querySelectorAll('.place-label-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            toggleVisitLabelPanel(btn.dataset.id);
        });
    });

    // Re-open whichever panels were open before this re-render
    if (editOptionsOpenId) {
        const row = document.getElementById(`edit-sub-${editOptionsOpenId}`);
        if (row) {
            row.style.display = '';
            const btn = el.querySelector(`.edit-options-btn[data-id="${editOptionsOpenId}"]`);
            if (btn) btn.classList.add('active');
        }
    }
    if (transitPanelOpenId) {
        const panel = document.getElementById(`transit-panel-${transitPanelOpenId}`);
        if (panel) {
            panel.style.display = '';
            const tb = el.querySelector(`.transit-toggle-btn[data-id="${transitPanelOpenId}"]`);
            if (tb) tb.classList.add('active');
            wireTransitPanel(transitPanelOpenId);
        }
    }
    if (visitLabelPanelOpenId) {
        const panel = document.getElementById(`place-label-panel-${visitLabelPanelOpenId}`);
        if (panel) {
            panel.style.display = '';
            const lb = el.querySelector(`.place-label-btn[data-id="${visitLabelPanelOpenId}"]`);
            if (lb) lb.classList.add('active');
            wireVisitLabelPanel(visitLabelPanelOpenId);
        }
    }
    if (waypointPanelOpenId) {
        const panel = document.getElementById(`waypoint-panel-${waypointPanelOpenId}`);
        if (panel) {
            panel.style.display = '';
            const wb = el.querySelector(`.waypoint-toggle-btn[data-id="${waypointPanelOpenId}"]`);
            if (wb) wb.classList.add('active');
            document.getElementById('map').classList.add('waypoint-adding');
            wireWaypointPanel(waypointPanelOpenId);
        }
    }
    if (modePanelOpenId) {
        const panel = document.getElementById(`mode-panel-${modePanelOpenId}`);
        if (panel) {
            panel.style.display = '';
            const mb = el.querySelector(`.mode-toggle-btn[data-id="${modePanelOpenId}"]`);
            if (mb) mb.classList.add('active');
            wireModePanel(modePanelOpenId);
        }
    }
    if (timePanelOpenId) {
        const panel = document.getElementById(`time-panel-${timePanelOpenId}`);
        if (panel) {
            panel.style.display = '';
            const tb = el.querySelector(`.time-toggle-btn[data-id="${timePanelOpenId}"]`);
            if (tb) tb.classList.add('active');
            wireTimePanel(timePanelOpenId);
        }
    }
}

function visitItemHtml(e) {
    const label = e.customName || e.semanticType || '';
    const coords = `${e.lat.toFixed(4)}, ${e.lng.toFixed(4)}`;
    const detail = label ? `${label} · ${coords}` : coords;
    const badge  = e.customName
        ? ` · <span class="place-name-badge">${e.customName}</span>`
        : '';
    return `<div class="side-item-wrap">
        <div class="side-item" data-id="${e.id}">
            <div class="side-item-info">
                <div class="side-item-kind">visit${badge}</div>
                <div class="side-item-detail">${detail}</div>
                <div class="side-item-time">${formatTime(e.startTime)} – ${formatTime(e.endTime)}</div>
            </div>
            <div class="side-item-actions">
                <button class="edit-options-btn transit-toggle-btn" data-id="${e.id}">edit</button>
                <button class="delete-btn" data-id="${e.id}" title="delete">×</button>
            </div>
        </div>
        <div class="edit-subbtn-row" id="edit-sub-${e.id}" style="display:none">
            <button class="place-label-btn transit-toggle-btn" data-id="${e.id}">label</button>
            <button class="time-toggle-btn transit-toggle-btn" data-id="${e.id}">time</button>
        </div>
        <div class="place-label-panel transit-panel" id="place-label-panel-${e.id}" style="display:none">
            ${visitLabelPanelHtml(e)}
        </div>
        <div class="transit-panel" id="time-panel-${e.id}" style="display:none">
            ${timePanelHtml(e)}
        </div>
    </div>`;
}

function visitLabelPanelHtml(e) {
    const deleted = new Set(store.deletedIds);
    const seen = new Set();
    const allNames = store.entries
        .filter(x => !deleted.has(x.id) && x.kind === 'visit' && x.customName
            && x.id !== e.id && !seen.has(x.customName) && seen.add(x.customName))
        .sort((a, b) => (a.customName || '').localeCompare(b.customName || ''))
        .map(x => `<option value="${x.customName}">${x.customName}</option>`)
        .join('');
    const copyHtml = `<div class="transit-form">
        <div class="transit-form-label">existing label</div>
        <select class="label-copy-select">
            <option value="">— pick existing —</option>
            ${allNames}
        </select>
    </div>`;
    return `${copyHtml}
        <div class="transit-form">
            <div class="transit-form-label">place name</div>
            <div class="transit-form-row">
                <input type="text" class="place-name-input transit-ref-input" placeholder="e.g. Home, Work, Coffee Shop" value="${e.customName || ''}">
                <button class="transit-search-btn place-name-save-btn">save</button>
            </div>
        </div>`;
}

function activityItemHtml(e, routeIdx) {
    const dist = e.distanceMeters ? ` · ${(e.distanceMeters / 1000).toFixed(1)} km` : '';
    const segs = e.transitSegments || [];
    const badge = segs.length
        ? ' · ' + segs.map(s =>
            `<span class="transit-badge" style="color:${transitColor(s.mode)}">${(s.mode || '').replace('_', ' ')} ${s.ref}</span>`
          ).join(' + ')
        : '';
    const color = ROUTE_COLORS[(routeIdx ?? 0) % ROUTE_COLORS.length];
    const dot = segs.length === 0
        ? `<span style="color:${color};margin-right:3px;font-size:10px;">■</span>`
        : '';
    return `<div class="side-item-wrap">
        <div class="side-item" data-id="${e.id}">
            <div class="side-item-info">
                <div class="side-item-kind">${dot}route${badge}</div>
                <div class="side-item-detail">${e.activityType || 'activity'}${dist}</div>
                <div class="side-item-time">${formatTime(e.startTime)} – ${formatTime(e.endTime)}</div>
            </div>
            <div class="side-item-actions">
                <button class="edit-options-btn transit-toggle-btn" data-id="${e.id}">edit</button>
                <button class="delete-btn" data-id="${e.id}" title="delete">×</button>
            </div>
        </div>
        <div class="edit-subbtn-row" id="edit-sub-${e.id}" style="display:none">
            <button class="transit-toggle-btn" data-id="${e.id}">transit</button>
            <button class="waypoint-toggle-btn transit-toggle-btn" data-id="${e.id}">via</button>
            <button class="mode-toggle-btn transit-toggle-btn" data-id="${e.id}">mode</button>
            <button class="time-toggle-btn transit-toggle-btn" data-id="${e.id}">time</button>
            <button class="route-edit-btn transit-toggle-btn" data-id="${e.id}">route</button>
        </div>
        <div class="transit-panel" id="transit-panel-${e.id}" style="display:none">
            ${transitPanelHtml(e)}
        </div>
        <div class="transit-panel" id="waypoint-panel-${e.id}" style="display:none">
            ${waypointPanelHtml(e)}
        </div>
        <div class="transit-panel" id="mode-panel-${e.id}" style="display:none">
            ${modePanelHtml(e)}
        </div>
        <div class="transit-panel" id="time-panel-${e.id}" style="display:none">
            ${timePanelHtml(e)}
        </div>
    </div>`;
}

function transitPanelHtml(e) {
    const segs = e.transitSegments || [];
    const modes = ['bus', 'subway', 'tram', 'light_rail', 'ferry', 'train'];

    const deleted = new Set(store.deletedIds);
    const copyOptions = store.entries
        .filter(x => x.id !== e.id && !deleted.has(x.id) && (x.transitSegments || []).length > 0)
        .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''))
        .map(x => {
            const day  = (x.startTime || '').slice(0, 10);
            const desc = x.transitSegments.map(s => {
                const stations = (s.entryStation || s.exitStation)
                    ? ` (${s.entryStation || ''}→${s.exitStation || ''})` : '';
                return `${(s.mode || '').replace('_', ' ')} ${s.ref}${stations}`;
            }).join(' + ');
            return `<option value="${x.id}">${day} · ${desc}</option>`;
        }).join('');
    const suggestionsHtml = `<div class="transit-form">
        <div class="transit-form-label">copy from</div>
        <select class="transit-copy-select">
            <option value="">— existing route —</option>
            ${copyOptions}
        </select>
    </div>`;

    const segListHtml = segs.length
        ? `<div class="transit-seg-list">${segs.map((s, i) => {
            const from = s.entryStation || '';
            const to   = s.exitStation  || '';
            const stations = (from || to) ? ` · ${from}→${to}` : '';
            const insertActive = transitInsertIdx === i ? ' active' : '';
            return `<div class="transit-seg-item">
                <button class="transit-seg-insert${insertActive}" data-idx="${i}" title="insert a segment before this one">+</button>
                <span class="transit-seg-label" style="color:${transitColor(s.mode)}">${(s.mode || '').replace('_', ' ')} ${s.ref}${stations}</span>
                <button class="transit-seg-remove" data-idx="${i}" title="remove">×</button>
            </div>`;
          }).join('')}</div>`
        : '';

    const formLabel = transitInsertIdx !== null
        ? `insert before #${transitInsertIdx + 1}`
        : segs.length ? 'add transfer' : 'transit route';

    return `${suggestionsHtml}${segListHtml}
        <div class="transit-form">
            <div class="transit-form-label">${formLabel}</div>
            <div class="transit-form-row">
                <select class="transit-mode-select">
                    ${modes.map(m => `<option value="${m}">${m.replace('_', ' ')}</option>`).join('')}
                </select>
                <input type="text" class="transit-ref-input" placeholder="route # or name">
            </div>
            <input type="text" class="transit-city-input" placeholder="city (optional)">
            <button class="transit-search-btn">${segs.length ? 'find + add' : 'search'}</button>
        </div>
        <div class="transit-results" id="transit-results-${e.id}"></div>`;
}

// ── Visit label panel logic ────────────────────────────────────────────────

function toggleVisitLabelPanel(id) {
    if (visitLabelPanelOpenId === id) {
        const panel = document.getElementById(`place-label-panel-${id}`);
        if (panel) panel.style.display = 'none';
        const btn = document.querySelector(`.place-label-btn[data-id="${id}"]`);
        if (btn) btn.classList.remove('active');
        visitLabelPanelOpenId = null;
    } else {
        if (visitLabelPanelOpenId) {
            const prev = document.getElementById(`place-label-panel-${visitLabelPanelOpenId}`);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`.place-label-btn[data-id="${visitLabelPanelOpenId}"]`);
            if (prevBtn) prevBtn.classList.remove('active');
        }
        visitLabelPanelOpenId = id;
        const panel = document.getElementById(`place-label-panel-${id}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`.place-label-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
        wireVisitLabelPanel(id);
    }
}

function wireVisitLabelPanel(id) {
    const panel = document.getElementById(`place-label-panel-${id}`);
    if (!panel) return;

    const copySelect = panel.querySelector('.label-copy-select');
    const nameInput  = panel.querySelector('.place-name-input');
    if (copySelect) {
        copySelect.addEventListener('change', function () {
            if (!this.value) return;
            if (nameInput) nameInput.value = this.value;
            this.value = '';
        });
    }

    const saveBtn   = panel.querySelector('.place-name-save-btn');
    const saveName  = () => {
        const entry = store.entries.find(e => e.id === id);
        if (!entry) return;
        entry.customName = nameInput ? nameInput.value.trim() || null : null;
        saveStore(store);
        render();
    };
    if (saveBtn)   saveBtn.addEventListener('click', saveName);
    if (nameInput) nameInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') saveName();
    });
}

// ── Waypoint panel logic ───────────────────────────────────────────────────

function waypointPanelHtml(e) {
    const wps = e.waypoints || [];
    const listHtml = wps.length
        ? `<div class="transit-seg-list">${wps.map((wp, i) =>
            `<div class="transit-seg-item">
                <span class="transit-seg-label">${wp.lat.toFixed(5)}, ${wp.lng.toFixed(5)}</span>
                <button class="waypoint-remove-btn transit-seg-remove" data-idx="${i}">×</button>
             </div>`
          ).join('')}</div>`
        : '';
    const hint = wps.length
        ? `${wps.length} waypoint${wps.length !== 1 ? 's' : ''} — click map to add more`
        : 'click anywhere on the map to add a waypoint';
    return `${listHtml}
        <div class="transit-form">
            <div class="transit-form-label waypoint-hint">${hint}</div>
            ${wps.length ? `<button class="transit-clear-btn waypoint-clear-btn">clear all</button>` : ''}
        </div>`;
}

function toggleWaypointPanel(id) {
    const mapEl = document.getElementById('map');
    if (waypointPanelOpenId === id) {
        const panel = document.getElementById(`waypoint-panel-${id}`);
        if (panel) panel.style.display = 'none';
        const btn = document.querySelector(`.waypoint-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.remove('active');
        waypointPanelOpenId = null;
        if (mapEl) mapEl.classList.remove('waypoint-adding');
    } else {
        if (waypointPanelOpenId) {
            const prev = document.getElementById(`waypoint-panel-${waypointPanelOpenId}`);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`.waypoint-toggle-btn[data-id="${waypointPanelOpenId}"]`);
            if (prevBtn) prevBtn.classList.remove('active');
        }
        waypointPanelOpenId = id;
        const panel = document.getElementById(`waypoint-panel-${id}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`.waypoint-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
        if (mapEl) mapEl.classList.add('waypoint-adding');
        wireWaypointPanel(id);
    }
}

function wireWaypointPanel(id) {
    const panel = document.getElementById(`waypoint-panel-${id}`);
    if (!panel) return;

    panel.querySelectorAll('.waypoint-remove-btn').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            const entry = store.entries.find(e => e.id === id);
            if (!entry || !entry.waypoints) return;
            entry.waypoints.splice(parseInt(btn.dataset.idx), 1);
            entry.routeGeoJSON = null;
            saveStore(store);
            render();
        });
    });

    const clearBtn = panel.querySelector('.waypoint-clear-btn');
    if (clearBtn) {
        clearBtn.addEventListener('click', ev => {
            ev.stopPropagation();
            const entry = store.entries.find(e => e.id === id);
            if (!entry) return;
            entry.waypoints = [];
            entry.routeGeoJSON = null;
            saveStore(store);
            render();
        });
    }
}

// ── Transit panel logic ────────────────────────────────────────────────────

function toggleTransitPanel(id) {
    if (transitPanelOpenId === id) {
        const panel = document.getElementById(`transit-panel-${id}`);
        if (panel) panel.style.display = 'none';
        const btn = document.querySelector(`.transit-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.remove('active');
        transitPanelOpenId = null;
        transitInsertIdx = null;
    } else {
        transitInsertIdx = null;
        if (transitPanelOpenId) {
            const prev = document.getElementById(`transit-panel-${transitPanelOpenId}`);
            if (prev) prev.style.display = 'none';
            const prevBtn = document.querySelector(`.transit-toggle-btn[data-id="${transitPanelOpenId}"]`);
            if (prevBtn) prevBtn.classList.remove('active');
        }
        transitPanelOpenId = id;
        const panel = document.getElementById(`transit-panel-${id}`);
        if (panel) panel.style.display = '';
        const btn = document.querySelector(`.transit-toggle-btn[data-id="${id}"]`);
        if (btn) btn.classList.add('active');
        wireTransitPanel(id);
    }
}

function wireTransitPanel(id) {
    const panel = document.getElementById(`transit-panel-${id}`);
    if (!panel) return;

    const copySelect = panel.querySelector('.transit-copy-select');
    if (copySelect) {
        copySelect.addEventListener('change', function () {
            if (!this.value) return;
            const match = store.entries.find(e => e.id === this.value);
            const entry = store.entries.find(e => e.id === id);
            if (!match || !entry) return;
            entry.transitSegments = match.transitSegments.map(s => ({ ...s }));
            syncTransitEndpoints(entry);
            saveStore(store);
            render();
        });
    }

    panel.querySelectorAll('.transit-seg-remove').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            removeTransitSegment(id, parseInt(btn.dataset.idx));
        });
    });

    const entry = store.entries.find(e => e.id === id);
    const segs  = entry ? (entry.transitSegments || []) : [];

    panel.querySelectorAll('.transit-seg-insert').forEach(btn => {
        btn.addEventListener('click', ev => {
            ev.stopPropagation();
            const idx   = parseInt(btn.dataset.idx);
            const label = panel.querySelector('.transit-form-label');
            if (transitInsertIdx === idx) {
                // toggle off — revert to append mode
                transitInsertIdx = null;
                btn.classList.remove('active');
                if (label) label.textContent = segs.length ? 'add transfer' : 'transit route';
            } else {
                panel.querySelectorAll('.transit-seg-insert').forEach(b => b.classList.remove('active'));
                transitInsertIdx = idx;
                btn.classList.add('active');
                if (label) label.textContent = `insert before #${idx + 1}`;
            }
            // clear stale results when changing insertion point
            const resultsEl = document.getElementById(`transit-results-${id}`);
            if (resultsEl) resultsEl.innerHTML = '';
            if (transitSearchContext) transitSearchContext.results = null;
        });
    });

    const searchBtn = panel.querySelector('.transit-search-btn');
    const refInput  = panel.querySelector('.transit-ref-input');

    if (searchBtn) searchBtn.addEventListener('click', () => runTransitSearch(id, panel));
    if (refInput)  refInput.addEventListener('keydown', ev => {
        if (ev.key === 'Enter') runTransitSearch(id, panel);
    });

    // Restore panel state after re-render
    if (transitSearchContext && transitSearchContext.id === id) {
        if (transitSearchContext.selectedRelation && transitSearchContext.stops) {
            renderStopPicker(id, transitSearchContext.selectedRelation, transitSearchContext.stops, transitSearchContext.mode, transitSearchContext.ref);
        } else if (transitSearchContext.results) {
            renderTransitResults(id, transitSearchContext.results, transitSearchContext.mode, transitSearchContext.ref);
        }
    }
}

// Group relations that are opposite directions of the same service into one entry.
// Two relations belong to the same group when they share network+ref, or when their
// names differ only in the directional "(A → B)" parenthetical.
function groupRelationResults(relations) {
    const groups = [];
    const keyMap = new Map();
    for (const r of relations) {
        const tags = r.tags || {};
        let key;
        if (tags.network && tags.ref) {
            key = `${tags.network.toLowerCase()}::${tags.ref.toLowerCase()}`;
        } else {
            key = (tags.name || '').replace(/\s*\([^)]*→[^)]*\)/g, '').trim().toLowerCase()
                || String(r.id);
        }
        if (keyMap.has(key)) {
            keyMap.get(key).push(r);
        } else {
            const g = [r];
            keyMap.set(key, g);
            groups.push(g);
        }
    }
    return groups;
}

async function runTransitSearch(id, panel) {
    const mode = panel.querySelector('.transit-mode-select').value;
    const ref  = panel.querySelector('.transit-ref-input').value.trim();
    const city = panel.querySelector('.transit-city-input').value.trim();
    if (!ref) return;

    const resultsEl = document.getElementById(`transit-results-${id}`);
    resultsEl.innerHTML = '<div class="transit-loading">searching…</div>';

    try {
        const results = await queryOverpass(mode, ref, city);
        transitSearchContext = { id, mode, ref, results, selectedRelation: null, selectedGroup: null, stops: null };
        renderTransitResults(id, results, mode, ref);
    } catch (err) {
        resultsEl.innerHTML = `<div class="transit-no-results">error: ${err.message}</div>`;
    }
}

function renderTransitResults(id, results, mode, ref) {
    const el = document.getElementById(`transit-results-${id}`);
    if (!el) return;

    if (results.length === 0) {
        el.innerHTML = '<div class="transit-no-results">no routes found — try adding a city</div>';
        return;
    }

    const groups = groupRelationResults(results);
    el._transitGroups = groups;

    el.innerHTML = groups.slice(0, 10).map((group, gi) => {
        const tags = group[0].tags || {};
        // Strip directional "(A → B)" so both directions share the same display name
        const name = (tags.name || tags.ref || '(unnamed)').replace(/\s*\([^)]*→[^)]*\)/g, '').trim();
        const network = tags.network ? ` · ${tags.network}` : '';
        // Show endpoints with ↔ for bidirectional groups, → for single-direction
        let fromTo = '';
        if (tags.from && tags.to) {
            const arrow = group.length > 1 ? ' ↔ ' : ' → ';
            fromTo = `<div class="transit-result-fromto">${tags.from}${arrow}${tags.to}</div>`;
        }
        return `<div class="transit-result-item" data-gi="${gi}">
            <span class="transit-result-name">${name}${network}</span>${fromTo}
        </div>`;
    }).join('');

    el.querySelectorAll('.transit-result-item').forEach(item => {
        item.addEventListener('click', async () => {
            const group = el._transitGroups[parseInt(item.dataset.gi)];
            el.innerHTML = '<div class="transit-loading">loading stops…</div>';
            // Use the relation with the most stops — one direction may have fuller data
            let bestRel = group[0], bestStops = await getRouteStops(group[0]);
            for (let i = 1; i < group.length; i++) {
                const s = await getRouteStops(group[i]);
                if (s.length > bestStops.length) { bestStops = s; bestRel = group[i]; }
            }
            if (transitSearchContext) {
                transitSearchContext.selectedRelation = bestRel;
                transitSearchContext.selectedGroup    = group;
                transitSearchContext.stops            = bestStops;
            }
            renderStopPicker(id, bestRel, bestStops, mode, ref);
        });
    });
}

// Extract ordered stop nodes (with position) from a relation returned by Overpass `out geom`
function extractStopsFromRelation(relation) {
    const seen = new Set();
    return (relation.members || [])
        .filter(m => m.type === 'node' && (m.role === 'stop' || m.role === 'stop_position' || m.role === 'platform') && m.lat !== undefined)
        .filter(m => { if (seen.has(m.ref)) return false; seen.add(m.ref); return true; })
        .map(m => ({ ref: m.ref, lat: m.lat, lng: m.lon, name: null }));
}

async function fetchStopNames(refs) {
    if (refs.length === 0) return {};
    const query = `[out:json][timeout:15]; node(id:${refs.join(',')}); out body;`;
    try {
        const resp = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: 'data=' + encodeURIComponent(query),
        });
        if (!resp.ok) return {};
        const json = await resp.json();
        const map = {};
        for (const n of (json.elements || [])) {
            map[n.id] = n.tags && (n.tags.name || n.tags.ref || null);
        }
        return map;
    } catch {
        return {};
    }
}

async function getRouteStops(relation) {
    const raw = extractStopsFromRelation(relation);
    if (raw.length === 0) return [];
    const names = await fetchStopNames(raw.map(s => s.ref));
    // Deduplicate consecutive stops with the same name (stop + stop_position pairs)
    const result = [];
    for (const s of raw) {
        s.name = names[s.ref] || null;
        const prev = result[result.length - 1];
        if (prev && prev.name && prev.name === s.name) continue; // skip duplicate
        result.push(s);
    }
    return result;
}

function renderStopPicker(id, relation, stops, mode, ref) {
    const el = document.getElementById(`transit-results-${id}`);
    if (!el) return;

    const tags = relation.tags || {};
    const routeName = (tags.name || `${(mode || '').replace('_', ' ')} ${ref}`)
        .replace(/\s*\([^)]*→[^)]*\)/g, '').trim();

    const stopOptions = stops.map((s, i) => {
        const label = s.name ? `${i + 1}. ${s.name}` : `stop ${i + 1}`;
        return `<option value="${i}">${label}</option>`;
    }).join('');

    const selectsHtml = stops.length
        ? `<div class="transit-form-row">
               <select class="transit-stop-select" id="transit-entry-sel-${id}">
                   <option value="">entry stop (optional)</option>
                   ${stopOptions}
               </select>
               <select class="transit-stop-select" id="transit-exit-sel-${id}">
                   <option value="">exit stop (optional)</option>
                   ${stopOptions}
               </select>
           </div>`
        : `<div class="transit-no-results">no stop data in OSM — will clip to GPS location</div>`;

    el.innerHTML = `<div class="transit-stop-picker">
        <div class="transit-selected-route" style="color:${transitColor(mode)}">${routeName}</div>
        ${selectsHtml}
        <div class="transit-form-row">
            <button class="transit-confirm-btn">add segment</button>
            <button class="transit-cancel-btn">back</button>
        </div>
    </div>`;

    const confirmBtn = el.querySelector('.transit-confirm-btn');
    const cancelBtn  = el.querySelector('.transit-cancel-btn');

    confirmBtn.addEventListener('click', () => {
        const entryEl = document.getElementById(`transit-entry-sel-${id}`);
        const exitEl  = document.getElementById(`transit-exit-sel-${id}`);
        const entryStop = entryEl && entryEl.value !== '' ? stops[parseInt(entryEl.value)] : null;
        const exitStop  = exitEl  && exitEl.value  !== '' ? stops[parseInt(exitEl.value)]  : null;
        selectTransitRoute(id, relation, mode, ref, entryStop, exitStop);
    });

    cancelBtn.addEventListener('click', () => {
        if (transitSearchContext && transitSearchContext.results) {
            renderTransitResults(id, transitSearchContext.results, transitSearchContext.mode, transitSearchContext.ref);
        }
    });
}

function selectTransitRoute(entryId, relation, mode, ref, entryStop, exitStop) {
    const entry = store.entries.find(e => e.id === entryId);
    if (!entry) return;

    // Try every relation in the group (both directions of a service).
    // extractSegmentGeoJSON uses the relation's member-array ordering to find
    // exactly the ways between the entry and exit stops — no coordinate-distance
    // guessing required. We still pick the shortest result across directions so
    // that the correct direction is chosen automatically.
    const group = (transitSearchContext && transitSearchContext.selectedGroup) || [relation];
    let bestClipped = null, bestLen = Infinity;
    for (const rel of group) {
        const segGeo = extractSegmentGeoJSON(rel, entryStop, exitStop);
        if (!segGeo || segGeo.coordinates.length === 0) continue;
        if (segGeo.coordinates.length < bestLen) {
            bestLen     = segGeo.coordinates.length;
            bestClipped = segGeo;
        }
    }

    if (!bestClipped) {
        alert('Could not extract route geometry from this relation.');
        return;
    }

    if (!entry.transitSegments) entry.transitSegments = [];
    const newSeg = {
        mode,
        ref,
        entryStation: entryStop ? entryStop.name : null,
        exitStation:  exitStop  ? exitStop.name  : null,
        geoJSON:      bestClipped,
    };
    if (transitInsertIdx !== null) {
        entry.transitSegments.splice(transitInsertIdx, 0, newSeg);
    } else {
        entry.transitSegments.push(newSeg);
    }

    syncTransitEndpoints(entry);
    saveStore(store);
    transitInsertIdx = null;
    if (transitSearchContext) transitSearchContext.results = null;
    render();
}

function syncTransitEndpoints(entry) {
    const segs = entry.transitSegments || [];
    if (segs.length === 0) return;
    const firstCoords = segs[0].geoJSON && segs[0].geoJSON.coordinates;
    const lastCoords  = segs[segs.length - 1].geoJSON && segs[segs.length - 1].geoJSON.coordinates;
    if (firstCoords && firstCoords.length > 0) {
        const [lng, lat] = firstCoords[0];
        entry.startLat = lat;
        entry.startLng = lng;
        entry.routeGeoJSON = null;
    }
    if (lastCoords && lastCoords.length > 0) {
        const [lng, lat] = lastCoords[lastCoords.length - 1];
        entry.endLat = lat;
        entry.endLng = lng;
        entry.routeGeoJSON = null;
    }
}

function removeTransitSegment(entryId, segIdx) {
    const entry = store.entries.find(e => e.id === entryId);
    if (!entry || !entry.transitSegments) return;
    entry.transitSegments.splice(segIdx, 1);
    syncTransitEndpoints(entry);
    saveStore(store);
    transitInsertIdx = null; // indices shifted, reset to avoid inserting at wrong position
    render();
}

// ── Fly to ────────────────────────────────────────────────────────────────

function flyToEntry(id) {
    const entry = store.entries.find(e => e.id === id);
    if (!entry) return;
    if (entry.kind === 'visit') {
        mapInstance.flyTo([entry.lat, entry.lng], 15);
    } else {
        mapInstance.flyTo(
            [(entry.startLat + entry.endLat) / 2, (entry.startLng + entry.endLng) / 2],
            13
        );
    }
}

// ── Delete ────────────────────────────────────────────────────────────────

function deleteEntry(id, groupIds) {
    const ids = groupIds || [id];
    const label = groupIds ? `all ${ids.length} routes in this group` : 'this entry';
    if (!confirm(`Delete ${label}?`)) return;
    for (const i of ids) {
        if (!store.deletedIds.includes(i)) store.deletedIds.push(i);
    }
    saveStore(store);
    render();
}

// ── Popups ────────────────────────────────────────────────────────────────

function visitPopup(e) {
    const label = e.customName || e.semanticType || 'visit';
    return `<b>${label}</b><br>${e.lat.toFixed(5)}, ${e.lng.toFixed(5)}<br>
        ${formatTime(e.startTime)} – ${formatTime(e.endTime)}<br>
        <button class="popup-delete-btn" onclick="deleteEntry('${e.id}')">delete</button>`;
}

function activityPopup(e, count, groupIds) {
    const dist      = e.distanceMeters ? `${(e.distanceMeters / 1000).toFixed(1)} km · ` : '';
    const travelled = count > 1 ? `<br>Travelled ${count} times` : '';
    const segs      = e.transitSegments || [];
    const transitHtml = segs.map(s => {
        const from = s.entryStation ? ` from ${s.entryStation}` : '';
        const to   = s.exitStation  ? ` to ${s.exitStation}`    : '';
        return `<br><span style="color:${transitColor(s.mode)}">${(s.mode || '').replace('_', ' ')} ${s.ref}${from}${to}</span>`;
    }).join('');
    const deleteArg   = groupIds ? `null, ${JSON.stringify(groupIds)}` : `'${e.id}'`;
    const deleteLabel = groupIds ? `delete group (${count})` : 'delete';
    return `<b>${e.activityType || 'activity'}</b><br>${dist}${formatTime(e.startTime)} – ${formatTime(e.endTime)}${transitHtml}${travelled}<br>
        <button class="popup-delete-btn" onclick="deleteEntry(${deleteArg})">${deleteLabel}</button>`;
}

// ── Activity line rendering ────────────────────────────────────────────────

async function renderActivityLine(e, count, groupIds, routeIdx) {
    const segs     = e.transitSegments || [];
    const weight   = Math.min(2 + count, 12);
    const popup    = activityPopup(e, count, groupIds);
    const defColor = ROUTE_COLORS[(routeIdx ?? 0) % ROUTE_COLORS.length];

    if (segs.length > 0) {
        for (const seg of segs) {
            const geo = seg.geoJSON;
            if (!geo) continue;
            const coords = geo.coordinates.map(([lng, lat]) => [lat, lng]);
            const line   = L.polyline(coords, { color: transitColor(seg.mode), weight, opacity: 0.85 });
            line.bindPopup(popup);
            line.addTo(mapInstance);
            mapLayers.push(line);
        }
        return;
    }

    // No transit — fall back to OSRM / straight line
    if (!e.routeGeoJSON) {
        const geo = await fetchOsrmRoute(e.startLat, e.startLng, e.endLat, e.endLng, e.waypoints);
        if (geo) { e.routeGeoJSON = geo; saveStore(store); }
    }
    let line;
    if (e.routeGeoJSON) {
        const coords = e.routeGeoJSON.coordinates.map(([lng, lat]) => [lat, lng]);
        line = L.polyline(coords, { color: defColor, weight, opacity: 0.75 });
    } else {
        line = L.polyline(
            [[e.startLat, e.startLng], [e.endLat, e.endLng]],
            { color: defColor, weight, opacity: 0.5, dashArray: '6 4' }
        );
    }
    line.bindPopup(popup);
    line.addTo(mapInstance);
    mapLayers.push(line);
}

// ── Per-day render ────────────────────────────────────────────────────────

async function renderDay(day) {
    clearMapLayers();
    const deleted   = new Set(store.deletedIds);
    const dayEntries = store.entries
        .filter(e => !deleted.has(e.id) && dayOf(e) === day)
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    buildSideList(dayEntries);

    const bounds = L.latLngBounds();
    let routeIdx = 0;
    for (const e of dayEntries) {
        if (e.kind === 'visit') {
            const m = L.marker([e.lat, e.lng]).bindPopup(visitPopup(e));
            m.addTo(mapInstance);
            mapLayers.push(m);
            bounds.extend([e.lat, e.lng]);
        } else {
            await renderActivityLine(e, 1, null, routeIdx++);
            bounds.extend([e.startLat, e.startLng]);
            bounds.extend([e.endLat, e.endLng]);
        }
    }
    fitBoundsIfAny(bounds);
}

// ── Total render ──────────────────────────────────────────────────────────

function roundCoord(n) { return Math.round(n * 10000) / 10000; }


function routeGroupKey(e) {
    const [sLat, sLng, eLat, eLng] = [
        roundCoord(e.startLat), roundCoord(e.startLng),
        roundCoord(e.endLat),   roundCoord(e.endLng),
    ];
    return sLat < eLat || (sLat === eLat && sLng < eLng)
        ? `${sLat},${sLng}|${eLat},${eLng}`
        : `${eLat},${eLng}|${sLat},${sLng}`;
}

async function renderTotal() {
    clearMapLayers();
    const deleted = new Set(store.deletedIds);
    const active  = store.entries
        .filter(e => !deleted.has(e.id))
        .sort((a, b) => (a.startTime || '').localeCompare(b.startTime || ''));
    buildSideList(active);

    const bounds      = L.latLngBounds();
    const routeGroups = {};

    for (const e of active) {
        if (e.kind === 'visit') {
            const m = L.marker([e.lat, e.lng]).bindPopup(visitPopup(e));
            m.addTo(mapInstance);
            mapLayers.push(m);
            bounds.extend([e.lat, e.lng]);
        } else {
            const key = routeGroupKey(e);
            if (!routeGroups[key]) routeGroups[key] = [];
            routeGroups[key].push(e);
            bounds.extend([e.startLat, e.startLng]);
            bounds.extend([e.endLat, e.endLng]);
        }
    }

    let routeIdx = 0;
    for (const group of Object.values(routeGroups)) {
        const rep      = group[0];
        const count    = group.length;
        const groupIds = count > 1 ? group.map(e => e.id) : null;
        await renderActivityLine(rep, count, groupIds, routeIdx++);
    }

    fitBoundsIfAny(bounds);
}

// ── Render dispatcher ─────────────────────────────────────────────────────

function render() {
    initMap();
    const deleted = new Set(store.deletedIds);
    const active  = store.entries.filter(e => !deleted.has(e.id));

    if (viewMode === 'day') {
        const days      = [...new Set(active.map(dayOf))].filter(Boolean).sort();
        const daySelect = document.getElementById('daySelect');
        daySelect.style.display = days.length ? '' : 'none';

        const currentDay = selectedDay && days.includes(selectedDay) ? selectedDay : days[0];
        selectedDay = currentDay;

        daySelect.innerHTML = days.map(d =>
            `<option value="${d}" ${d === currentDay ? 'selected' : ''}>${d}</option>`
        ).join('');

        if (currentDay) renderDay(currentDay);
        else { clearMapLayers(); buildSideList([]); }
    } else {
        document.getElementById('daySelect').style.display = 'none';
        renderTotal();
    }

    updateStatus();
}

function updateStatus() {
    const deleted = new Set(store.deletedIds);
    const active  = store.entries.filter(e => !deleted.has(e.id));
    const visits  = active.filter(e => e.kind === 'visit').length;
    const routes  = active.filter(e => e.kind === 'activity').length;
    const days    = new Set(active.map(dayOf)).size;
    document.getElementById('statusLine').textContent = active.length
        ? `Loaded ${visits} place${visits !== 1 ? 's' : ''} and ${routes} route${routes !== 1 ? 's' : ''} across ${days} day${days !== 1 ? 's' : ''}`
        : '';
}

// ── Import ────────────────────────────────────────────────────────────────

function importData(data) {
    osrmCount = 0;

    if (data.version === 1 && Array.isArray(data.entries)) {
        const existingIds = new Set(store.entries.map(e => e.id));
        for (const e of data.entries) {
            if (!existingIds.has(e.id)) store.entries.push(migrateEntry(e));
        }
        for (const id of (data.deletedIds || [])) {
            if (!store.deletedIds.includes(id)) store.deletedIds.push(id);
        }
        // Restore saved places from own-format export
        for (const [name, coords] of Object.entries(data.savedPlaces || {})) {
            if (coords && !store.savedPlaces[name]) store.savedPlaces[name] = coords;
        }
    } else {
        const newEntries  = parseGoogleTimeline(data);
        const existingIds = new Set(store.entries.map(e => e.id));
        for (const e of newEntries) {
            if (!existingIds.has(e.id)) store.entries.push(e);
        }
        // Derive Home from the most recent TYPE_HOME visit in this import
        const homeVisits = newEntries
            .filter(e => e.kind === 'visit' && e.semanticType === 'TYPE_HOME')
            .sort((a, b) => b.startTime.localeCompare(a.startTime));
        if (homeVisits.length > 0) {
            store.savedPlaces.Home = { lat: homeVisits[0].lat, lng: homeVisits[0].lng };
        }
    }

    saveStore(store);
    render();
}

// ── Export ────────────────────────────────────────────────────────────────

function exportData() {
    const today = new Date().toISOString().slice(0, 10);
    const blob  = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const a     = document.createElement('a');
    a.href      = URL.createObjectURL(blob);
    a.download  = `timeline-tracker-${today}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ── Event wiring ───────────────────────────────────────────────────────────

document.getElementById('fileInput').addEventListener('change', function () {
    const file = this.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => {
        try { importData(JSON.parse(ev.target.result)); }
        catch { alert('Could not parse JSON file.'); }
    };
    reader.readAsText(file);
    this.value = '';
});

document.getElementById('saveBtn').addEventListener('click', () => {
    saveStore(store);
    const btn = document.getElementById('saveBtn');
    const prev = btn.textContent;
    btn.textContent = 'saved!';
    setTimeout(() => { btn.textContent = prev; }, 1500);
});

document.getElementById('exportBtn').addEventListener('click', exportData);

document.getElementById('clearBtn').addEventListener('click', () => {
    if (!confirm('Clear all data from localStorage?')) return;
    store = { version: 1, entries: [], deletedIds: [] };
    saveStore(store);
    osrmCount = 0;
    transitPanelOpenId = null;
    transitSearchContext = null;
    visitLabelPanelOpenId = null;
    waypointPanelOpenId = null;
    modePanelOpenId = null;
    timePanelOpenId = null;
    editOptionsOpenId = null;
    editingRouteId = null;
    addRoutePickMode = null;
    document.getElementById('newRouteConfirm').textContent = 'add route';
    document.getElementById('addRoutePanel').style.display = 'none';
    document.getElementById('map').classList.remove('waypoint-adding');
    render();
});

document.querySelectorAll('input[name="viewMode"]').forEach(radio => {
    radio.addEventListener('change', () => {
        viewMode = radio.value;
        render();
    });
});

document.getElementById('daySelect').addEventListener('change', function () {
    selectedDay = this.value;
    renderDay(selectedDay);
});

// ── Add route ─────────────────────────────────────────────────────────────

(function wireAddRoute() {
    const panel  = document.getElementById('addRoutePanel');
    const modeEl = document.getElementById('newRouteMode');

    // Populate mode dropdown
    for (const m of ACTIVITY_MODES) {
        const opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modeEl.appendChild(opt);
    }

    function entryEndLoc(e)   { return e.kind === 'visit' ? { lat: e.lat,      lng: e.lng      } : { lat: e.endLat,   lng: e.endLng   }; }
    function entryStartLoc(e) { return e.kind === 'visit' ? { lat: e.lat,      lng: e.lng      } : { lat: e.startLat, lng: e.startLng }; }

    function setCoordDisplay(which, lat, lng) {
        newRoutePending[`${which}Lat`] = lat;
        newRoutePending[`${which}Lng`] = lng;
        document.getElementById(`newRoute${which === 'start' ? 'Start' : 'End'}Coord`).textContent =
            `${lat.toFixed(5)}, ${lng.toFixed(5)}`;
    }

    function populateEntrySelects() {
        const day = document.getElementById('newRouteDate').value || selectedDay || new Date().toISOString().slice(0, 10);
        const deleted = new Set(store.deletedIds);
        const dayEntries = store.entries
            .filter(e => !deleted.has(e.id) && dayOf(e) === day)
            .sort((a, b) => a.startTime.localeCompare(b.startTime));

        const fromSel = document.getElementById('newRouteFromEntry');
        const toSel   = document.getElementById('newRouteToEntry');
        fromSel.innerHTML = '<option value="">— pick manually —</option>';
        toSel.innerHTML   = '<option value="">— pick manually —</option>';

        for (const e of dayEntries) {
            const t1   = timeHHMM(e.startTime);
            const t2   = timeHHMM(e.endTime);
            const desc = e.kind === 'visit'
                ? (e.customName || `visit @ ${e.lat.toFixed(3)},${e.lng.toFixed(3)}`)
                : (e.activityType || 'route');
            const label = `${t1}–${t2} · ${desc}`;

            const oFrom = new Option(label, e.id);
            const oTo   = new Option(label, e.id);
            fromSel.appendChild(oFrom);
            toSel.appendChild(oTo);
        }
    }

    function resolvePlaceCoords(value) {
        if (!value) return null;
        if (value.startsWith('saved:')) {
            const name = value.slice(6);
            return store.savedPlaces[name] || null;
        }
        const e = store.entries.find(x => x.id === value);
        return e ? { lat: e.lat, lng: e.lng } : null;
    }

    function populateNamedPlaces() {
        const deleted = new Set(store.deletedIds);
        const seen = new Set();
        for (const selId of ['newRouteStartPlace', 'newRouteEndPlace']) {
            const sel = document.getElementById(selId);
            const prev = sel.value;
            sel.innerHTML = '<option value="">— named place —</option>';
            for (const [name, coords] of Object.entries(store.savedPlaces)) {
                const opt = document.createElement('option');
                opt.value = `saved:${name}`;
                opt.textContent = coords ? name : `${name} (not set)`;
                opt.disabled = !coords;
                seen.add(name);
                sel.appendChild(opt);
            }
            const named = store.entries.filter(e =>
                !deleted.has(e.id) && e.kind === 'visit' && e.customName
                && !seen.has(e.customName) && seen.add(e.customName)
            );
            for (const e of named) {
                const opt = document.createElement('option');
                opt.value = e.id;
                opt.textContent = e.customName;
                sel.appendChild(opt);
            }
            if ([...sel.options].some(o => o.value === prev)) sel.value = prev;
        }
    }

    function pickCoordIntoField(which, coords) {
        setCoordDisplay(which, coords.lat, coords.lng);
        addRoutePickMode = null;
        document.getElementById('map').classList.remove('waypoint-adding');
        document.getElementById('pickStartBtn').classList.remove('active');
        document.getElementById('pickEndBtn').classList.remove('active');
    }

    document.getElementById('newRouteStartPlace').addEventListener('change', function () {
        const coords = resolvePlaceCoords(this.value);
        if (!coords) return;
        pickCoordIntoField('start', coords);
    });

    document.getElementById('newRouteEndPlace').addEventListener('change', function () {
        const coords = resolvePlaceCoords(this.value);
        if (!coords) return;
        pickCoordIntoField('end', coords);
    });

    document.getElementById('newRouteFromEntry').addEventListener('change', function () {
        if (!this.value) return;
        const e = store.entries.find(x => x.id === this.value);
        if (!e) return;
        document.getElementById('newRouteStartTime').value = timeHHMM(e.endTime);
        const loc = entryEndLoc(e);
        setCoordDisplay('start', loc.lat, loc.lng);
    });

    document.getElementById('newRouteToEntry').addEventListener('change', function () {
        if (!this.value) return;
        const e = store.entries.find(x => x.id === this.value);
        if (!e) return;
        document.getElementById('newRouteEndTime').value = timeHHMM(e.startTime);
        const loc = entryStartLoc(e);
        setCoordDisplay('end', loc.lat, loc.lng);
    });

    // Re-populate when date changes
    document.getElementById('newRouteDate').addEventListener('change', populateEntrySelects);

    document.getElementById('addRouteBtn').addEventListener('click', () => {
        const isOpen = panel.style.display !== 'none';
        if (isOpen) {
            panel.style.display = 'none';
            addRoutePickMode = null;
            document.getElementById('map').classList.remove('waypoint-adding');
            return;
        }
        // Pre-fill date from current view
        const today = new Date().toISOString().slice(0, 10);
        document.getElementById('newRouteDate').value = selectedDay || today;
        document.getElementById('newRouteStartCoord').textContent = '—';
        document.getElementById('newRouteEndCoord').textContent = '—';
        document.getElementById('newRouteStartTime').value = '';
        document.getElementById('newRouteEndTime').value = '';
        document.getElementById('newRouteFromEntry').value = '';
        document.getElementById('newRouteToEntry').value = '';
        document.getElementById('newRouteStartPlace').value = '';
        document.getElementById('newRouteEndPlace').value = '';
        newRoutePending = { startLat: null, startLng: null, endLat: null, endLng: null };
        populateEntrySelects();
        populateNamedPlaces();
        panel.style.display = '';
    });

    function activatePick(which) {
        addRoutePickMode = which;
        document.getElementById('map').classList.add('waypoint-adding');
        document.getElementById('pickStartBtn').classList.toggle('active', which === 'start');
        document.getElementById('pickEndBtn').classList.toggle('active', which === 'end');
    }

    document.getElementById('pickStartBtn').addEventListener('click', () => {
        activatePick(addRoutePickMode === 'start' ? null : 'start');
        if (!addRoutePickMode) document.getElementById('map').classList.remove('waypoint-adding');
    });

    document.getElementById('pickEndBtn').addEventListener('click', () => {
        activatePick(addRoutePickMode === 'end' ? null : 'end');
        if (!addRoutePickMode) document.getElementById('map').classList.remove('waypoint-adding');
    });

    function closePanel() {
        panel.style.display = 'none';
        addRoutePickMode = null;
        editingRouteId = null;
        document.getElementById('map').classList.remove('waypoint-adding');
        document.getElementById('newRouteConfirm').textContent = 'add route';
    }

    // Expose so buildSideList can call it
    window.openEditRoute = function(id) {
        const e = store.entries.find(x => x.id === id);
        if (!e) return;

        editingRouteId = id;

        const day = (e.startTime || '').slice(0, 10);
        document.getElementById('newRouteDate').value = day;
        document.getElementById('newRouteStartTime').value = timeHHMM(e.startTime);
        document.getElementById('newRouteEndTime').value = timeHHMM(e.endTime);

        const modeEl = document.getElementById('newRouteMode');
        modeEl.value = e.activityType || '';

        const fmt = n => n.toFixed(5);
        newRoutePending = { startLat: e.startLat, startLng: e.startLng, endLat: e.endLat, endLng: e.endLng };
        document.getElementById('newRouteStartCoord').textContent = `${fmt(e.startLat)}, ${fmt(e.startLng)}`;
        document.getElementById('newRouteEndCoord').textContent   = `${fmt(e.endLat)}, ${fmt(e.endLng)}`;
        document.getElementById('newRouteStartPlace').value = '';
        document.getElementById('newRouteEndPlace').value = '';
        document.getElementById('newRouteFromEntry').value = '';
        document.getElementById('newRouteToEntry').value = '';

        populateEntrySelects();
        populateNamedPlaces();

        document.getElementById('newRouteConfirm').textContent = 'save changes';
        panel.style.display = '';
    };

    document.getElementById('newRouteCancel').addEventListener('click', closePanel);

    document.getElementById('newRouteConfirm').addEventListener('click', () => {
        const { startLat, startLng, endLat, endLng } = newRoutePending;
        if (startLat === null || endLat === null) {
            alert('Please pick a start point and an end point on the map.');
            return;
        }
        const dateVal = document.getElementById('newRouteDate').value;
        const startT  = document.getElementById('newRouteStartTime').value;
        const endT    = document.getElementById('newRouteEndTime').value;
        const modeVal = document.getElementById('newRouteMode').value;

        const day       = dateVal || new Date().toISOString().slice(0, 10);
        const startTime = `${day}T${startT || '00:00'}:00`;
        const endTime   = `${day}T${endT   || '00:01'}:00`;

        if (editingRouteId) {
            const idx = store.entries.findIndex(e => e.id === editingRouteId);
            if (idx === -1) return;
            const existing = store.entries[idx];
            const coordsChanged = existing.startLat !== startLat || existing.startLng !== startLng
                                || existing.endLat !== endLat   || existing.endLng !== endLng;
            const updated = {
                ...existing,
                startTime,
                endTime,
                startLat,
                startLng,
                endLat,
                endLng,
                activityType: modeVal || null,
                routeGeoJSON: coordsChanged ? null : existing.routeGeoJSON,
            };
            updated.id = makeId(updated);
            if (updated.id !== editingRouteId && store.entries.some(e => e.id === updated.id)) {
                alert('An identical route already exists.');
                return;
            }
            store.entries[idx] = updated;
        } else {
            const entry = {
                kind: 'activity',
                startTime,
                endTime,
                startLat,
                startLng,
                endLat,
                endLng,
                activityType: modeVal || null,
                distanceMeters: null,
                routeGeoJSON: null,
                transitSegments: [],
            };
            entry.id = makeId(entry);
            if (store.entries.some(e => e.id === entry.id)) {
                alert('An identical route already exists.');
                return;
            }
            store.entries.push(entry);
        }

        saveStore(store);
        viewMode = 'day';
        selectedDay = day;
        document.querySelector('input[name="viewMode"][value="day"]').checked = true;

        newRoutePending = { startLat: null, startLng: null, endLat: null, endLng: null };
        closePanel();
        render();
    });
})();

// ── Init ───────────────────────────────────────────────────────────────────

render();
