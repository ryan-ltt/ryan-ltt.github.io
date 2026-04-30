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
let activeDate = todayStr();
let historyDate = todayStr();
let activeTab = 'mark';
let map = null;
let mapHistory = null;
let currentUser = null;
let realtimeChannel = null;

// --- Helpers ---
function todayStr() {
    return new Date().toISOString().slice(0, 10);
}

function invalidateBoth() {
    // Call immediately and again after a short delay to handle mobile layout settling
    setTimeout(() => { map.invalidateSize(); mapHistory.invalidateSize(); }, 0);
    setTimeout(() => { map.invalidateSize(); mapHistory.invalidateSize(); }, 250);
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
    invalidateBoth();

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

    // Fullscreen
    const fsButtons = {};
    function enterFullscreen(layoutId, mapObj) {
        document.getElementById(layoutId).classList.add('fullscreen');
        if (fsButtons[layoutId]) { fsButtons[layoutId].innerHTML = '✕'; fsButtons[layoutId].title = 'Exit fullscreen'; }
        setTimeout(() => mapObj.invalidateSize(), 50);
    }
    function exitFullscreen(layoutId, mapObj) {
        document.getElementById(layoutId).classList.remove('fullscreen');
        if (fsButtons[layoutId]) { fsButtons[layoutId].innerHTML = '⛶'; fsButtons[layoutId].title = 'Enter fullscreen'; }
        void document.getElementById(layoutId).offsetHeight; // sync reflow before Leaflet reads container size
        mapObj.invalidateSize({ animate: false });
        if (cityState) {
            if (mapObj === map) renderMap();
            else renderHistoryTab();
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
    addFullscreenControl(map, 'mapLayoutMark');
    addFullscreenControl(mapHistory, 'mapLayoutHistory');
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            exitFullscreen('mapLayoutMark', map);
            exitFullscreen('mapLayoutHistory', mapHistory);
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
    document.getElementById('streetSearch').addEventListener('input', e => {
        filterText = e.target.value.toLowerCase();
        renderList();
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
        const { error } = authMode === 'signup'
            ? await db.auth.signUp({ email, password })
            : await db.auth.signInWithPassword({ email, password });
        if (error) { errEl.textContent = error.message; errEl.style.display = ''; return; }
        document.getElementById('signInModal').style.display = 'none';
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

    const lastCity = localStorage.getItem(LS_PREFIX + 'lastCity') || 'toronto';
    document.getElementById('citySelect').value = lastCity;
    loadCity(lastCity);
}

// --- Tab switching ---
function switchTab(tab) {
    activeTab = tab;
    document.getElementById('tabMark').style.display = tab === 'mark' ? '' : 'none';
    document.getElementById('tabHistory').style.display = tab === 'history' ? '' : 'none';
    document.getElementById('tabMarkBtn').classList.toggle('active', tab === 'mark');
    document.getElementById('tabHistoryBtn').classList.toggle('active', tab === 'history');
    if (tab === 'history') renderHistoryTab();
    invalidateBoth();
}

// --- Load city ---
async function loadCity(cityKey) {
    currentCity = null; // suppress saveMapPos during transition
    walks = loadProgress(cityKey);
    if (currentUser) {
        walks = await loadProgressFromDB(cityKey);
        saveProgress(cityKey);
    }
    expandedStreets.clear();
    filterText = '';
    document.getElementById('streetSearch').value = '';

    setStatus('loading...');
    clearMap();
    clearHistoryMap();
    document.getElementById('sideList').innerHTML = '<div class="loading-msg">loading street data...</div>';
    document.getElementById('sideListHistory').innerHTML = '';

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
    renderMap();
    subscribeRealtime(cityKey);
    renderList();
    updateStatus();
    if (activeTab === 'history') renderHistoryTab();
    invalidateBoth();
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

    if (streets.length === 0) {
        list.innerHTML = '<div class="loading-msg">no streets match</div>';
        return;
    }

    streets = [...streets].sort((a, b) => {
        const aWalked = a.wayIds.some(id => walks.has(id)) ? 0 : 1;
        const bWalked = b.wayIds.some(id => walks.has(id)) ? 0 : 1;
        return aWalked - bWalked;
    });

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
        for (let i = 0; i < rows.length; i += 500) {
            const { error } = await db.from('walks').upsert(rows.slice(i, i + 500), { onConflict: 'user_id,city,way_id' });
            if (error) { console.error('migration failed', error); return; }
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
    if (!confirm('Clear all walked segments for every city? This cannot be undone.')) return;
    for (const key of Object.keys(CITIES)) {
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

init();
