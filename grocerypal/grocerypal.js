'use strict';

// ── Firebase ───────────────────────────────────────────────────────────────
// Replace these with your Firebase project config (Project settings → Your apps → SDK setup).
const FIREBASE_CONFIG = {

    apiKey: "AIzaSyDv6nvYiUQ-73S65cln9xU5H-DBj1WucDE",

    authDomain: "grocerypal-2882c.firebaseapp.com",

    projectId: "grocerypal-2882c",

    storageBucket: "grocerypal-2882c.firebasestorage.app",

    messagingSenderId: "222825399999",

    appId: "1:222825399999:web:542bf68842d9a9af81e80a",

    measurementId: "G-6LJJLPY49T"

  };


const FB_CONFIGURED = FIREBASE_CONFIG.apiKey !== 'YOUR_API_KEY';

let gpDb   = null; // Firestore instance
let gpAuth = null; // Firebase Auth instance

if (FB_CONFIGURED && typeof firebase !== 'undefined') {
    firebase.initializeApp(FIREBASE_CONFIG);
    gpAuth = firebase.auth();
    gpDb   = firebase.firestore();
    window.gpDb   = gpDb;
    window.gpAuth = gpAuth;
}

// Auth state — shared with flyer-import.js via window globals
window.gpAuthUser   = null;
window.gpDealPrices = {}; // { "chain:key": { price, unit, validTo, chain } }

// ── Constants ──────────────────────────────────────────────────────────────
const LS_CATALOG  = 'groceryPal_catalog';
const LS_LIST     = 'groceryPal_list';
const LS_SETTINGS = 'groceryPal_settings';

// All supported chains (mirrors fetch-prices.py CHAINS / fetch-stores.py CHAIN_DISPLAY).
const CHAIN_LABELS = {
    metro: 'Metro', foodbasics: 'Food Basics',
    walmart: 'Walmart',
    nofrills: 'No Frills', loblaws: 'Loblaws', rcss: 'Real Canadian Superstore',
    zehrs: 'Zehrs', fortinos: 'Fortinos', valumart: 'Valu-mart', independent: 'Independent',
    freshco: 'FreshCo', sobeys: 'Sobeys', foodland: 'Foodland', longos: "Longo's", farmboy: 'Farm Boy',
    highlandfarms: 'Highland Farms',
};
const CHAINS = Object.keys(CHAIN_LABELS);
// Element-id suffix for a chain key, e.g. 'nofrills' → 'Nofrills' (used for price inputs).
function chainIdSuffix(c) { return c.charAt(0).toUpperCase() + c.slice(1); }
// Fresh price object with every chain null.
function emptyPrices() { return Object.fromEntries(CHAINS.map(c => [c, null])); }
const CATEGORIES = ['produce','dairy','meat','bakery','pantry','frozen','household'];

// L/100km per car class (EV handled separately in ¢/km)
const CAR_FUEL = { small: 7, sedan: 9, suv: 12, truck: 14, hybrid: 5 };
const EV_CENTS_PER_KM = 2; // default

const OSRM_CAR  = 'https://routing.openstreetmap.de/routed-car/route/v1/driving';
const OSRM_FOOT = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot';
const NOMINATIM = 'https://nominatim.openstreetmap.org/search';

// Toronto bounding box for geocoding
const TORONTO_BBOX = '-79.639, 43.580, -79.115, 43.856'; // lon_min,lat_min,lon_max,lat_max

const MAX_WALK_SECONDS = 7200; // 2h round trip max for walking plans

// ── State ──────────────────────────────────────────────────────────────────
let catalog  = [];   // [{ id, name, category, barcode, frozen, prices: {chain: num|null} }]
let list     = [];   // [{ itemId, qty }]
let settings = {};

let storesData = null;  // loaded from data/stores.json
let planMap = null;     // Leaflet map instance
let planMapMarkers = [];
let planMapLines = [];
let osrmCache = {};     // key → route result

let editingItemId = null; // item open in edit modal

// ── Storage helpers ─────────────────────────────────────────────────────────
function loadCatalog()  { try { return JSON.parse(localStorage.getItem(LS_CATALOG) || '[]'); } catch { return []; } }
function saveCatalog()  { localStorage.setItem(LS_CATALOG, JSON.stringify(catalog)); }
function loadList()     { try { return JSON.parse(localStorage.getItem(LS_LIST) || '[]'); } catch { return []; } }
function saveList()     { localStorage.setItem(LS_LIST, JSON.stringify(list)); }
function loadSettings() {
    try { return JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}'); } catch { return {}; }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }

function defaultSettings() {
    return { homeAddress: '', homeLat: null, homeLon: null, mode: 'walk',
             carClass: 'sedan', gasPrice: 165, evRate: 12,
             transitFare: 3.35, frozenLast: true };
}

// ── UUID ────────────────────────────────────────────────────────────────────
function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = Math.random() * 16 | 0;
        return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
    });
}

// ── Haversine distance (metres) ─────────────────────────────────────────────
function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLon/2)**2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// ── Format helpers ──────────────────────────────────────────────────────────
function fmt$(n) { return n == null ? '—' : '$' + n.toFixed(2); }
function fmtDist(m) { return m >= 1000 ? (m/1000).toFixed(1) + ' km' : Math.round(m) + ' m'; }
function fmtTime(sec) {
    const m = Math.round(sec / 60);
    if (m < 60) return m + ' min';
    return Math.floor(m/60) + 'h ' + (m%60) + 'm';
}

// ── Price helpers ────────────────────────────────────────────────────────────
function priceRange(item) {
    const vals = CHAINS.map(c => item.prices[c]).filter(v => v != null && v > 0);
    if (!vals.length) return null;
    return { min: Math.min(...vals), max: Math.max(...vals) };
}

function priceRangeStr(item) {
    const r = priceRange(item);
    if (!r) return 'no prices';
    if (r.min === r.max) return fmt$(r.min);
    return fmt$(r.min) + ' – ' + fmt$(r.max);
}

// ── Catalog CRUD ─────────────────────────────────────────────────────────────
function getCatalogItem(id) { return catalog.find(i => i.id === id); }

function createItem(name, category, barcode, prices) {
    const frozen = category === 'frozen';
    const item = {
        id: uuid(),
        name: name.trim(),
        category,
        barcode: barcode.trim() || null,
        frozen,
        prices: { ...emptyPrices(), ...prices },
    };
    catalog.push(item);
    saveCatalog();
    return item;
}

function updateItem(id, name, category, barcode, prices) {
    const item = getCatalogItem(id);
    if (!item) return;
    item.name = name.trim();
    item.category = category;
    item.barcode = barcode.trim() || null;
    item.frozen = category === 'frozen';
    item.prices = { ...emptyPrices(), ...prices };
    saveCatalog();
}

function deleteItem(id) {
    catalog = catalog.filter(i => i.id !== id);
    list = list.filter(e => e.itemId !== id);
    saveCatalog();
    saveList();
}

// ── List management ──────────────────────────────────────────────────────────
function addToList(itemId) {
    if (list.find(e => e.itemId === itemId)) return;
    list.push({ itemId, qty: 1 });
    saveList();
}

function removeFromList(itemId) {
    list = list.filter(e => e.itemId !== itemId);
    saveList();
}

function setQty(itemId, qty) {
    const entry = list.find(e => e.itemId === itemId);
    if (entry) { entry.qty = Math.max(1, qty); saveList(); }
}

function isInList(itemId) { return !!list.find(e => e.itemId === itemId); }

// ── Parse price input ─────────────────────────────────────────────────────
function parsePriceInputs(prefix) {
    const prices = {};
    for (const c of CHAINS) {
        const el = document.getElementById(`${prefix}${chainIdSuffix(c)}`);
        const v = el ? parseFloat(el.value) : NaN;
        prices[c] = isNaN(v) || v <= 0 ? null : v;
    }
    return prices;
}

// ── Build chain-dependent DOM (price grids, chain selects) from CHAINS ────────
function buildPriceGrid(prefix, gridSelector) {
    const grid = document.querySelector(gridSelector);
    if (!grid) return;
    // Keep the existing header; append a price-row per chain.
    for (const c of CHAINS) {
        const row = document.createElement('div');
        row.className = 'price-row';
        row.innerHTML =
            `<span class="chain-label ${c}-label">${esc(CHAIN_LABELS[c])}</span>` +
            `<input type="number" id="${prefix}${chainIdSuffix(c)}" class="price-input" min="0" step="0.01" placeholder="$0.00">`;
        grid.appendChild(row);
    }
}

function populateChainSelect(selectId) {
    const sel = document.getElementById(selectId);
    if (!sel) return;
    sel.innerHTML = CHAINS.map(c => `<option value="${c}">${esc(CHAIN_LABELS[c])}</option>`).join('');
}

// Group the live deals database by NORMALIZED name so look-alike flyer lines
// collapse to one concept. Each group tracks, per chain, the cheapest flat price
// and the cheapest per-mL/per-g (when a size is parseable), plus a display name.
// → { normKey: { name, deals: {chain:{price, unitPriceMl, unitPriceG}}, hasSize } }
function dealsByName(query) {
    const out = {};
    for (const d of Object.values(window.gpDealPrices || {})) {
        const name = d.itemName;
        if (!name) continue;
        if (query && !name.toLowerCase().includes(query)) continue;
        const key = normalizeDealName(name) || name.toLowerCase().trim();
        if (!out[key]) out[key] = { name, deals: {}, hasSize: false };
        const g = out[key];
        // Prefer the shortest display name in the group (usually the cleanest).
        if (name.length < g.name.length) g.name = name;

        const ml = d.unitPriceMl || null;
        const gr = d.unitPriceG  || null;
        if (ml || gr) g.hasSize = true;

        const cur = g.deals[d.chain];
        if (!cur) {
            g.deals[d.chain] = { price: d.price, unitPriceMl: ml, unitPriceG: gr };
        } else {
            if (d.price < cur.price) cur.price = d.price;
            if (ml && (cur.unitPriceMl == null || ml < cur.unitPriceMl)) cur.unitPriceMl = ml;
            if (gr && (cur.unitPriceG  == null || gr < cur.unitPriceG))  cur.unitPriceG  = gr;
        }
    }
    return out;
}

// Create a catalog item from a deal group and add it to the list.
// Stores each chain's cheapest flat price so the catalog stays usable even
// offline; per-mL routing is recomputed live from gpDealPrices via dealLookup.
function addDealToList(name, deals) {
    const prices = {};
    for (const [chain, info] of Object.entries(deals)) {
        if (info.price > 0 && CHAINS.includes(chain)) prices[chain] = info.price;
    }
    const item = createItem(name, 'pantry', '', prices);
    addToList(item.id);
    renderShoppingList();
}

// ── Render catalog search results ─────────────────────────────────────────
function renderCatalogResults(query) {
    const box = document.getElementById('catalogResults');
    const q = query.trim().toLowerCase();
    if (!q && !catalog.length) { box.classList.remove('visible'); box.innerHTML = ''; return; }

    const catMatches = q
        ? catalog.filter(i => i.name.toLowerCase().includes(q) || (i.barcode && i.barcode.includes(q)))
        : [...catalog];

    // Deal matches: only when searching, and exclude names already in the catalog
    // (those already appear above with the user's own prices).
    const catNames = new Set(catalog.map(i => i.name.toLowerCase().trim()));
    const dealMatches = q
        ? Object.values(dealsByName(q)).filter(g => !catNames.has(g.name.toLowerCase().trim()))
        : [];

    box.innerHTML = '';
    const clearSearch = () => {
        document.getElementById('catalogSearch').value = '';
        box.classList.remove('visible');
        box.innerHTML = '';
    };

    // 1. Local catalog items
    for (const item of catMatches) {
        const inList = isInList(item.id);
        const div = document.createElement('div');
        div.className = 'catalog-result-item' + (inList ? ' already-added' : '');
        div.innerHTML = `
            <span class="result-name">${esc(item.name)}</span>
            <span class="result-category">${item.category}</span>
            <span class="result-price-range">${priceRangeStr(item)}</span>
            ${inList ? '<span style="font-size:13px;color:#888">✓ in list</span>' : ''}
        `;
        if (!inList) {
            div.addEventListener('click', () => { addToList(item.id); renderShoppingList(); clearSearch(); });
        }
        box.appendChild(div);
    }

    // 2. Deal-database items. Compute each group's best per-unit price, then sort
    //    cheapest-per-L/kg first; sizeless ("size unknown") groups sink to the end.
    const DEAL_LIMIT = 40;
    for (const g of dealMatches) {
        const chains = Object.keys(g.deals);
        const mlVals = chains.map(c => g.deals[c].unitPriceMl).filter(v => v != null);
        const gVals  = chains.map(c => g.deals[c].unitPriceG).filter(v => v != null);
        g._lowestFlat = Math.min(...chains.map(c => g.deals[c].price));
        // Sort key: lowest $/L if any, else lowest $/kg, else Infinity (sizeless last).
        g._sortUnit = mlVals.length ? Math.min(...mlVals) * 1000
                    : gVals.length  ? Math.min(...gVals)  * 1000
                    : Infinity;
        if (mlVals.length)      g._priceStr = `${fmt$(Math.min(...mlVals) * 1000)}/L`;
        else if (gVals.length)  g._priceStr = `${fmt$(Math.min(...gVals)  * 1000)}/kg`;
        else                    g._priceStr = `from ${fmt$(g._lowestFlat)}`;
    }
    const sortedDeals = dealMatches.sort((a, b) =>
        a._sortUnit - b._sortUnit || a._lowestFlat - b._lowestFlat);
    for (const g of sortedDeals.slice(0, DEAL_LIMIT)) {
        const chains = Object.keys(g.deals);
        const chainNames = chains.map(c => CHAIN_LABELS[c] || c).join(', ');
        const priceStr = g._priceStr;
        const sizeNote = g.hasSize ? '' : ' <span class="size-unknown">size unknown</span>';
        const div = document.createElement('div');
        div.className = 'catalog-result-item deal-result-item' + (g.hasSize ? '' : ' size-unknown-item');
        div.innerHTML = `
            <span class="result-name">${esc(g.name)} <span class="deal-badge">deal</span>${sizeNote}</span>
            <span class="result-category">${esc(chainNames)}</span>
            <span class="result-price-range">${priceStr}</span>
        `;
        div.addEventListener('click', () => { addDealToList(g.name, g.deals); clearSearch(); });
        box.appendChild(div);
    }

    if (!catMatches.length && !dealMatches.length) {
        box.innerHTML = `<div class="catalog-empty-msg">No items found. Use "Add a new item" below.</div>`;
    }
    box.classList.add('visible');
}

// ── Render shopping list ───────────────────────────────────────────────────
function renderShoppingList() {
    const container = document.getElementById('shoppingList');
    const emptyMsg  = document.getElementById('listEmpty');
    container.innerHTML = '';

    if (!list.length) {
        emptyMsg.style.display = 'block';
        return;
    }
    emptyMsg.style.display = 'none';

    for (const entry of list) {
        const item = getCatalogItem(entry.itemId);
        if (!item) continue;
        const row = document.createElement('div');
        row.className = 'list-item-row';
        row.innerHTML = `
            <div class="list-item-name">
                ${esc(item.name)}
                ${item.frozen ? '<span class="list-item-frozen-badge">❄ frozen</span>' : ''}
            </div>
            <span class="list-item-category">${item.category}</span>
            <span class="list-price-range">${priceRangeStr(item)}</span>
            <div class="qty-stepper">
                <button class="qty-btn" data-action="dec" data-id="${item.id}">−</button>
                <span class="qty-display">${entry.qty}</span>
                <button class="qty-btn" data-action="inc" data-id="${item.id}">+</button>
            </div>
            <button class="edit-item-btn" data-id="${item.id}">edit</button>
            <button class="remove-item-btn" data-id="${item.id}" title="Remove from list">×</button>
        `;
        container.appendChild(row);
    }
}

// ── Add item form ─────────────────────────────────────────────────────────
function handleAddItem() {
    const name = document.getElementById('newItemName').value.trim();
    const category = document.getElementById('newItemCategory').value;
    const barcode = document.getElementById('newItemBarcode').value.trim();
    const prices = parsePriceInputs('price');
    const msg = document.getElementById('addItemMsg');

    if (!name) { showMsg(msg, 'Please enter an item name.', 'error'); return; }

    const item = createItem(name, category, barcode, prices);
    addToList(item.id);
    renderShoppingList();

    // Reset form
    document.getElementById('newItemName').value = '';
    document.getElementById('newItemBarcode').value = '';
    for (const c of CHAINS) {
        const el = document.getElementById(`price${chainIdSuffix(c)}`);
        if (el) el.value = '';
    }
    showMsg(msg, `"${item.name}" added to catalog and list.`, 'success');
    document.getElementById('addItemDetails').open = false;
}

// ── Edit modal ───────────────────────────────────────────────────────────
function openEditModal(itemId) {
    const item = getCatalogItem(itemId);
    if (!item) return;
    editingItemId = itemId;

    document.getElementById('editModalTitle').textContent = `Edit: ${item.name}`;
    document.getElementById('editItemName').value = item.name;
    document.getElementById('editItemCategory').value = item.category;
    document.getElementById('editItemBarcode').value = item.barcode || '';
    for (const c of CHAINS) {
        const el = document.getElementById(`editPrice${chainIdSuffix(c)}`);
        if (el) el.value = item.prices[c] != null ? item.prices[c] : '';
    }
    document.getElementById('editModal').style.display = 'flex';
}

function closeEditModal() {
    document.getElementById('editModal').style.display = 'none';
    editingItemId = null;
}

function handleSaveEdit() {
    if (!editingItemId) return;
    const name = document.getElementById('editItemName').value.trim();
    const category = document.getElementById('editItemCategory').value;
    const barcode = document.getElementById('editItemBarcode').value.trim();
    const prices = parsePriceInputs('editPrice');

    if (!name) { alert('Please enter an item name.'); return; }
    updateItem(editingItemId, name, category, barcode, prices);
    closeEditModal();
    renderShoppingList();
}

function handleDeleteItem() {
    if (!editingItemId) return;
    const item = getCatalogItem(editingItemId);
    if (!item) return;
    if (!confirm(`Delete "${item.name}" from your catalog?`)) return;
    deleteItem(editingItemId);
    closeEditModal();
    renderShoppingList();
}

// ── Settings UI ────────────────────────────────────────────────────────────
function applySettingsToUI() {
    document.getElementById('addressInput').value = settings.homeAddress || '';
    setActiveMode(settings.mode || 'walk');
    document.getElementById('carClassSelect').value = settings.carClass || 'sedan';
    document.getElementById('gasPriceInput').value = settings.gasPrice ?? 165;
    document.getElementById('evRateInput').value = settings.evRate ?? 12;
    document.getElementById('transitFareInput').value = settings.transitFare ?? 3.35;
    document.getElementById('frozenLastCheck').checked = settings.frozenLast !== false;
    updateCarSubfields();
}

function setActiveMode(mode) {
    settings.mode = mode;
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === mode);
    });
    document.getElementById('driveOptions').style.display   = mode === 'drive'   ? 'block' : 'none';
    document.getElementById('transitOptions').style.display = mode === 'transit' ? 'block' : 'none';
}

function updateCarSubfields() {
    const cls = document.getElementById('carClassSelect').value;
    document.getElementById('gasPriceRow').style.display = cls === 'ev' ? 'none' : 'block';
    document.getElementById('evRateRow').style.display   = cls === 'ev' ? 'block' : 'none';
}

function collectSettings() {
    settings.carClass    = document.getElementById('carClassSelect').value;
    settings.gasPrice    = parseFloat(document.getElementById('gasPriceInput').value) || 165;
    settings.evRate      = parseFloat(document.getElementById('evRateInput').value) || 12;
    settings.transitFare = parseFloat(document.getElementById('transitFareInput').value) || 3.35;
    settings.frozenLast  = document.getElementById('frozenLastCheck').checked;
}

// ── Geocoding ──────────────────────────────────────────────────────────────
async function geocodeAddress(address) {
    const url = `${NOMINATIM}?q=${encodeURIComponent(address + ', Toronto, ON')}&format=json&limit=1&viewbox=${TORONTO_BBOX}&bounded=0`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'grocerypal/1.0 (ryan-ltt.github.io)' } });
    const results = await resp.json();
    if (!results.length) return null;
    return { lat: parseFloat(results[0].lat), lon: parseFloat(results[0].lon), display: results[0].display_name };
}

async function handleGeocode() {
    const addr = document.getElementById('addressInput').value.trim();
    const msg  = document.getElementById('geocodeMsg');
    if (!addr) { showMsg(msg, 'Please enter an address.', 'error'); return; }

    showMsg(msg, 'Looking up address…', '');
    const btn = document.getElementById('geocodeBtn');
    btn.disabled = true;

    try {
        const result = await geocodeAddress(addr);
        if (!result) {
            showMsg(msg, 'Address not found. Try adding "Toronto" to your search.', 'error');
        } else {
            settings.homeAddress = addr;
            settings.homeLat = result.lat;
            settings.homeLon = result.lon;
            saveSettings();
            showMsg(msg, `Found: ${result.display.split(',').slice(0,3).join(',')}`, 'success');
        }
    } catch (e) {
        showMsg(msg, 'Geocoding error. Please try again.', 'error');
    } finally {
        btn.disabled = false;
    }
}

// ── Load stores ────────────────────────────────────────────────────────────
async function loadStores() {
    if (storesData) return storesData;
    const resp = await fetch('/grocerypal/data/stores.json');
    storesData = await resp.json();
    return storesData;
}

// ── Nearest store per chain ────────────────────────────────────────────────
function nearestStorePerChain(homeLat, homeLon, stores) {
    const nearest = {};
    for (const store of stores) {
        const d = haversine(homeLat, homeLon, store.lat, store.lon);
        if (!nearest[store.chain] || d < nearest[store.chain].dist) {
            nearest[store.chain] = { ...store, dist: d };
        }
    }
    return Object.values(nearest);
}

// ── OSRM routing ──────────────────────────────────────────────────────────
async function osrmRoute(waypoints, profile) {
    // waypoints: [{lat, lon}]
    const coords = waypoints.map(p => `${p.lon},${p.lat}`).join(';');
    const base   = profile === 'car' ? OSRM_CAR : OSRM_FOOT;
    const key    = `${profile}:${coords}`;
    if (osrmCache[key]) return osrmCache[key];

    const url = `${base}/${coords}?overview=full&geometries=geojson`;
    try {
        const resp = await fetch(url);
        if (!resp.ok) return null;
        const data = await resp.json();
        if (data.code !== 'Ok' || !data.routes.length) return null;
        const r = data.routes[0];
        const result = {
            distanceM:  r.distance,
            durationSec: r.duration,
            geometry: r.geometry.coordinates.map(([lon, lat]) => [lat, lon]),
        };
        osrmCache[key] = result;
        return result;
    } catch { return null; }
}

// ── Travel cost calculation ────────────────────────────────────────────────
function travelCost(distanceM, durationSec) {
    const mode = settings.mode;
    if (mode === 'walk') {
        return { cost: 0, tooFar: durationSec > MAX_WALK_SECONDS };
    }
    if (mode === 'transit') {
        // Flat TTC fare (2-hr transfer covers multi-stop trip)
        return { cost: settings.transitFare, tooFar: false };
    }
    // Driving
    const km = distanceM / 1000;
    const cls = settings.carClass;
    let cost;
    if (cls === 'ev') {
        cost = km * (settings.evRate / 100);
    } else {
        const l100 = CAR_FUEL[cls] || 9;
        cost = km * (l100 / 100) * (settings.gasPrice / 100);
    }
    return { cost, tooFar: false };
}

// ── Deal prices (community flyer database) ────────────────────────────────
async function fetchDealPrices() {
    if (!gpDb) return;
    const today = new Date().toISOString().slice(0, 10);
    const queryCollection = (name) => gpDb.collection(name)
        .where('region',     '==', 'ontario')
        .where('valid_from', '<=', today)
        .where('valid_to',   '>=', today)
        .get();
    try {
        // Community flyer data + machine-scraped data, merged (cheaper-wins).
        const [flyerSnap, scrapedSnap] = await Promise.all([
            queryCollection('flyer_prices'),
            queryCollection('scraped_prices'),
        ]);

        const deals = {};
        const fold = (snap) => snap.forEach(doc => {
            const row = doc.data();
            const key = `${row.chain}:${(row.barcode || row.item_name.toLowerCase().trim())}`;
            if (!deals[key] || row.price < deals[key].price) {
                deals[key] = {
                    price:       row.price,
                    unit:        row.unit,
                    validTo:     row.valid_to,
                    chain:       row.chain,
                    itemName:    row.item_name,
                    unitPriceMl: row.unit_price_ml || null,
                    unitPriceG:  row.unit_price_g  || null,
                    totalMl:     row.total_ml      || null,
                    totalG:      row.total_g       || null,
                };
            }
        });
        fold(flyerSnap);
        fold(scrapedSnap);
        window.gpDealPrices = deals;
        if (typeof updateDealsCountBadge === 'function') updateDealsCountBadge();
    } catch (e) {
        console.warn('fetchDealPrices error', e);
    }
}

function dealLookup(item, chain) {
    if (!window.gpDealPrices) return null;
    const normName = item.name.toLowerCase().trim();

    // 1. Exact barcode match
    const byBarcode = item.barcode ? window.gpDealPrices[`${chain}:${item.barcode}`] : null;
    if (byBarcode) return byBarcode;

    // 2. Exact name match
    const byName = window.gpDealPrices[`${chain}:${normName}`];
    if (byName) return byName;

    // 3. Base-name fuzzy match. Scan ALL of this chain's deals that plausibly match
    //    the item, and pick the BEST PER-mL (or per-g) among them — not just the
    //    first. This is what lets "Coca-Cola" on the list auto-resolve to a chain's
    //    cheapest unit-price soda deal across pack sizes.
    const catalogTotalMl = extractTotalMl(item.name);
    const catalogTotalG  = extractTotalG(item.name);
    const itemNorm = normalizeDealName(item.name);

    let bestUnitMl = null;   // {deal} with lowest unitPriceMl
    let bestUnitG  = null;
    let flatFallback = null; // first sizeless matching deal (used only if no sized deal)

    for (const deal of Object.values(window.gpDealPrices)) {
        if (deal.chain !== chain) continue;
        const dealBase = deal.itemName.toLowerCase().trim();
        const dealNorm = normalizeDealName(deal.itemName);
        // Match on raw substring OR normalized substring (catches size/varieties noise).
        const matches = normName.includes(dealBase) || dealBase.includes(normName)
            || (itemNorm && dealNorm && (itemNorm.includes(dealNorm) || dealNorm.includes(itemNorm)));
        if (!matches) continue;
        // Don't compare across product forms (whole vs chunks vs sliced, etc.).
        if (!sameForm(item.name, deal.itemName)) continue;

        if (deal.unitPriceMl && (!bestUnitMl || deal.unitPriceMl < bestUnitMl.unitPriceMl)) bestUnitMl = deal;
        if (deal.unitPriceG  && (!bestUnitG  || deal.unitPriceG  < bestUnitG.unitPriceG))   bestUnitG  = deal;
        if (!flatFallback) flatFallback = deal;
    }

    // Prefer per-mL, then per-g. If the catalog item itself has a size, price that
    // exact size; otherwise price one representative pack (the cheapest-per-mL deal's
    // own pack price) and expose the unit price for display/comparison.
    if (bestUnitMl) {
        const price = catalogTotalMl
            ? parseFloat((bestUnitMl.unitPriceMl * catalogTotalMl).toFixed(2))
            : bestUnitMl.price;
        return { ...bestUnitMl, price };
    }
    if (bestUnitG) {
        const price = catalogTotalG
            ? parseFloat((bestUnitG.unitPriceG * catalogTotalG).toFixed(2))
            : bestUnitG.price;
        return { ...bestUnitG, price };
    }
    // No sized deal for this chain — fall back to a flat-price match if any.
    return flatFallback;
}

// "Form" words mark a distinct product form (a tub of chunks ≠ a whole melon).
// They are product identity, never noise: two names must share the SAME set of
// form words to be considered the same concept.
const FORM_WORDS = [
    'whole', 'half', 'halves', 'quarter', 'quarters', 'chunk', 'chunks',
    'slice', 'sliced', 'slices', 'cut', 'cubed', 'diced', 'wedge', 'wedges',
    'piece', 'pieces', 'portion', 'portions', 'tri pack', 'tri-pack',
    'mini', 'minis', 'shredded', 'ground', 'fillet', 'fillets', 'boneless', 'bone-in',
];
function formWordSet(name) {
    const n = ' ' + (name || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ') + ' ';
    const set = new Set();
    for (const w of FORM_WORDS) {
        if (n.includes(' ' + w + ' ')) set.add(w.replace(/s$|es$/, '').replace('-', ' '));
    }
    return set;
}
// True if two names carry the same product form (so they may be compared).
function sameForm(a, b) {
    const fa = formWordSet(a), fb = formWordSet(b);
    if (fa.size !== fb.size) return false;
    for (const w of fa) if (!fb.has(w)) return false;
    return true;
}

// Normalize a flyer/deal name to a comparison key: drop sizes, pack counts,
// trademark junk, French boilerplate, and "selected varieties" filler so that
// look-alike flyer lines collapse to the same key. Used to dedupe the dropdown.
function normalizeDealName(name) {
    return (name || '')
        .toLowerCase()
        .replace(/[®™®™�]/g, ' ')                    // trademark chars / mojibake
        .replace(/\d+\s*x\s*\d+(?:\.\d+)?\s*(?:ml|l|g|kg|lb|lbs|oz)\b/gi, ' ') // "12x355ml" pack sizes
        .replace(/\d+(?:\.\d+)?\s*(?:ml|l|litre|liter|g|kg|lb|lbs|pound|pounds|oz)\b/gi, ' ') // "2 l", "500g", "11 lb"
        .replace(/\baverage\b/gi, ' ')  // "11 lb AVERAGE" → drop filler after size strip
        .replace(/\bselected varieties\b/gi, ' ')
        .replace(/\bmini cans?\b/gi, ' ')
        .replace(/\bpkg\b|\bbottles?\b/gi, ' ')
        .replace(/\bboissons gazeuses\b/gi, ' ')   // common French boilerplate
        .replace(/\bsoft drinks?\b|\bbeverages?\b/gi, ' ')
        .replace(/[^a-z0-9 ]/g, ' ')                                 // punctuation
        .replace(/\s+/g, ' ')
        .trim();
}

// Parse "24x355mL" or "355mL" → total mL from a product name string
function extractTotalMl(name) {
    const multi = name.match(/(\d+)\s*x\s*(\d+(?:\.\d+)?)\s*ml/i);
    if (multi) return parseInt(multi[1]) * parseFloat(multi[2]);
    const single = name.match(/(\d+(?:\.\d+)?)\s*(?:L|litre|liter)\b/i);
    if (single) return parseFloat(single[1]) * 1000;
    const ml = name.match(/(\d+(?:\.\d+)?)\s*ml/i);
    if (ml) return parseFloat(ml[1]);
    return null;
}

// Parse "500g", "1kg", or imperial "11 lb"/"8 oz" → total grams from a name string
function extractTotalG(name) {
    const kg = name.match(/(\d+(?:\.\d+)?)\s*kg\b/i);
    if (kg) return parseFloat(kg[1]) * 1000;
    const lb = name.match(/(\d+(?:\.\d+)?)\s*(?:lb|lbs|pound)s?\b/i);
    if (lb) return parseFloat(lb[1]) * 453.592;
    const oz = name.match(/(\d+(?:\.\d+)?)\s*oz\b/i);
    if (oz) return parseFloat(oz[1]) * 28.3495;
    const g = name.match(/(\d+(?:\.\d+)?)\s*g\b/i);
    if (g) return parseFloat(g[1]);
    return null;
}

function effectivePrice(item, chain) {
    const deal = dealLookup(item, chain);
    const manual = item.prices[chain];
    if (deal && deal.price > 0) {
        if (manual == null || deal.price < manual) {
            return {
                price: deal.price, isDeal: true, validTo: deal.validTo,
                unitPriceMl: deal.unitPriceMl || null,
                unitPriceG:  deal.unitPriceG  || null,
                dealName:    deal.itemName || null,
            };
        }
    }
    if (manual != null && manual > 0) return { price: manual, isDeal: false, validTo: null };
    return null;
}

// ── Basket cost for a set of stores ──────────────────────────────────────
function basketCost(storeSubset) {
    // For each list item, find cheapest price among stores in subset
    const chains = storeSubset.map(s => s.chain);
    let total = 0;
    const assignments = []; // {item, chain, price, qty, subtotal, isDeal, validTo}
    const missing = [];

    for (const entry of list) {
        const item = getCatalogItem(entry.itemId);
        if (!item) continue;

        let bestEp = null;
        let bestChain = null;
        for (const c of chains) {
            const ep = effectivePrice(item, c);
            if (!ep) continue;
            if (bestEp === null) { bestEp = ep; bestChain = c; continue; }
            // Rank by per-mL (then per-g) when both candidates expose one — that's
            // the "best value across sizes" comparison. Otherwise rank by price.
            const better =
                (ep.unitPriceMl != null && bestEp.unitPriceMl != null) ? ep.unitPriceMl < bestEp.unitPriceMl :
                (ep.unitPriceG  != null && bestEp.unitPriceG  != null) ? ep.unitPriceG  < bestEp.unitPriceG  :
                ep.price < bestEp.price;
            if (better) { bestEp = ep; bestChain = c; }
        }

        if (bestEp === null) {
            missing.push(item);
        } else {
            const subtotal = bestEp.price * entry.qty;
            total += subtotal;
            assignments.push({
                item, chain: bestChain, price: bestEp.price, qty: entry.qty, subtotal,
                isDeal: bestEp.isDeal, validTo: bestEp.validTo,
                unitPriceMl: bestEp.unitPriceMl || null, unitPriceG: bestEp.unitPriceG || null,
            });
        }
    }

    return { total, assignments, missing };
}

// ── Permutations ─────────────────────────────────────────────────────────
function permutations(arr) {
    if (arr.length <= 1) return [arr];
    const result = [];
    for (let i = 0; i < arr.length; i++) {
        const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
        for (const perm of permutations(rest)) result.push([arr[i], ...perm]);
    }
    return result;
}

// ── Frozen-last constraint ────────────────────────────────────────────────
function frozenStore(storeSubset, assignments) {
    // Returns the store chain that should be visited last (has most frozen items)
    if (!settings.frozenLast) return null;
    const hasFrozen = list.some(e => getCatalogItem(e.itemId)?.frozen);
    if (!hasFrozen) return null;

    const frozenCount = {};
    for (const a of assignments) {
        if (a.item.frozen) frozenCount[a.chain] = (frozenCount[a.chain] || 0) + a.qty;
    }
    if (!Object.keys(frozenCount).length) return null;
    return Object.entries(frozenCount).sort((a,b) => b[1]-a[1])[0][0];
}

// ── Best route order via OSRM ─────────────────────────────────────────────
async function bestRouteOrder(home, storeSubset, lastChain) {
    // Returns { order: [store,...], distanceM, durationSec, geometry }
    const osrmProfile = settings.mode === 'drive' ? 'car' : 'foot';

    let candidatePerms = permutations(storeSubset);

    // Apply frozen-last constraint
    if (lastChain) {
        candidatePerms = candidatePerms.filter(p => p[p.length - 1].chain === lastChain);
        if (!candidatePerms.length) candidatePerms = permutations(storeSubset);
    }

    let best = null;
    for (const perm of candidatePerms) {
        const waypoints = [home, ...perm.map(s => ({ lat: s.lat, lon: s.lon })), home];
        const route = await osrmRoute(waypoints, osrmProfile);
        if (!route) continue;
        if (!best || route.distanceM < best.distanceM) {
            best = { order: perm, distanceM: route.distanceM, durationSec: route.durationSec, geometry: route.geometry };
        }
    }

    return best;
}

// ── Subsets ───────────────────────────────────────────────────────────────
function subsets(arr, size) {
    if (size === 1) return arr.map(x => [x]);
    const result = [];
    for (let i = 0; i <= arr.length - size; i++) {
        for (const rest of subsets(arr.slice(i + 1), size - 1)) {
            result.push([arr[i], ...rest]);
        }
    }
    return result;
}

// ── Main optimizer ────────────────────────────────────────────────────────
async function findBestPlan() {
    collectSettings();
    saveSettings();

    const msg = document.getElementById('planMsg');
    const results = document.getElementById('planResults');
    results.style.display = 'none';

    if (!settings.homeLat) {
        showMsg(msg, 'Please set your address in Step 2 first.', 'error');
        return;
    }
    if (!list.length) {
        showMsg(msg, 'Your grocery list is empty. Add some items in Step 1 first.', 'error');
        return;
    }

    const btn = document.getElementById('findPlanBtn');
    btn.disabled = true;
    btn.textContent = 'Finding best plan…';
    showMsg(msg, 'Checking routes…', '');

    try {
        const { stores } = await loadStores();
        const home = { lat: settings.homeLat, lon: settings.homeLon };
        const candidates = nearestStorePerChain(settings.homeLat, settings.homeLon, stores);

        // Enumerate all subsets of size 1–3
        const allPlans = [];
        const allSubsets = [1, 2, 3].flatMap(size => subsets(candidates, size));
        let done = 0;
        for (const subset of allSubsets) {
            const label = subset.map(s => s.name).join(' + ');
            showMsg(msg, `Checking routes… (${done}/${allSubsets.length}) ${label}`, '');

            const { total: basketTotal, assignments, missing } = basketCost(subset);

            // Skip plans where no list items have prices at any store in this subset
            if (!assignments.length) { done++; continue; }

            const lastChain = frozenStore(subset, assignments);
            const route = await bestRouteOrder(home, subset, lastChain);
            done++;
            if (!route) continue;

                const { cost: travCost, tooFar } = travelCost(route.distanceM, route.durationSec);
                const grandTotal = basketTotal + travCost;

                // Estimate transit time differently
                let displayDuration = route.durationSec;
                if (settings.mode === 'transit') {
                    displayDuration = route.durationSec * 1.8 + subset.length * 300;
                }

                allPlans.push({
                    stores: route.order,
                    assignments,
                    missing,
                    basketTotal,
                    travCost,
                    grandTotal,
                    distanceM: route.distanceM,
                    durationSec: displayDuration,
                    geometry: route.geometry,
                    tooFar,
                });
        }

        if (!allPlans.length) {
            showMsg(msg, 'Could not calculate routes. Please try again.', 'error');
            return;
        }

        // Remove plans that are too far (walking)
        const viable = allPlans.filter(p => !p.tooFar);
        const plans = viable.length ? viable : allPlans;

        // Best plan = lowest grandTotal
        plans.sort((a, b) => a.grandTotal - b.grandTotal);
        const best = plans[0];

        // Best single-store plan for savings comparison
        const singlePlans = plans.filter(p => p.stores.length === 1);
        singlePlans.sort((a, b) => a.grandTotal - b.grandTotal);
        const bestSingle = singlePlans[0] || best;

        showMsg(msg, '', '');
        renderResults(best, bestSingle, plans);
        results.style.display = 'block';

    } catch (e) {
        console.error(e);
        showMsg(msg, 'An error occurred. Check your connection and try again.', 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Find My Best Plan';
    }
}

// ── Render results ──────────────────────────────────────────────────────
function renderResults(best, bestSingle, allPlans) {
    renderRecCard(best, bestSingle);
    renderPlanMap(best);
    renderStoreLists(best);
    renderComparisonTable(allPlans, best);
    setupPrintList(best);
}

function renderRecCard(best, bestSingle) {
    const card = document.getElementById('recCard');
    const storeNames = best.stores.map(s => `${s.name} (${s.address || s.chain})`).join(' and ');
    const savings = bestSingle.grandTotal - best.grandTotal;
    const isSplit = best.stores.length > 1;

    let html = '';
    if (isSplit && savings > 0.50) {
        html += `<div><strong>Best plan:</strong> Shop at ${storeNames}.</div>`;
        html += `<div class="rec-total">Total: ${fmt$(best.grandTotal)}`;
        if (best.travCost > 0) html += ` <span style="font-size:16px;font-weight:normal">(including ${fmt$(best.travCost)} travel)</span>`;
        html += `</div>`;
        html += `<div class="rec-savings">You save ${fmt$(savings)} compared to shopping only at ${bestSingle.stores[0].name}.</div>`;
    } else {
        card.classList.add('no-split');
        html += `<div><strong>Best plan:</strong> Shop at ${best.stores.map(s => s.name).join(' → ')}.</div>`;
        html += `<div class="rec-total">Total: ${fmt$(best.grandTotal)}`;
        if (best.travCost > 0) html += ` <span style="font-size:16px;font-weight:normal">(including ${fmt$(best.travCost)} travel)</span>`;
        html += `</div>`;
        if (isSplit && savings <= 0.50) {
            html += `<div style="color:#92400e">Splitting across stores saves less than $0.50 after travel costs — not worth the extra trip.</div>`;
        }
    }

    if (best.tooFar) {
        html += `<div style="color:#cc0000;margin-top:8px">⚠ Some stores may be too far to walk. Consider transit or driving.</div>`;
    }

    const travelMode = settings.mode === 'drive' ? 'driving' : settings.mode === 'transit' ? 'transit' : 'walking';
    html += `<div style="font-size:15px;color:#555;margin-top:10px">${fmtDist(best.distanceM)} · ~${fmtTime(best.durationSec)} by ${travelMode}</div>`;

    card.innerHTML = html;
}

function renderPlanMap(best) {
    const home = { lat: settings.homeLat, lon: settings.homeLon };

    // Clear old map
    for (const m of planMapMarkers) m.remove();
    for (const l of planMapLines) l.remove();
    planMapMarkers = [];
    planMapLines = [];

    if (!planMap) {
        planMap = L.map('planMap', { preferCanvas: true });
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            attribution: '© OpenStreetMap contributors',
            maxZoom: 19,
        }).addTo(planMap);
    }

    const bounds = [];

    // Home marker
    const homeMarker = L.circleMarker([home.lat, home.lon], {
        radius: 10, color: '#1e40af', fillColor: '#1e40af', fillOpacity: 1, weight: 2,
    }).bindTooltip('Home').addTo(planMap);
    planMapMarkers.push(homeMarker);
    bounds.push([home.lat, home.lon]);

    // Store markers
    best.stores.forEach((store, i) => {
        const marker = L.marker([store.lat, store.lon]).bindTooltip(
            `${i+1}. ${store.name}${store.address ? ' — ' + store.address : ''}`,
            { permanent: false }
        ).addTo(planMap);
        planMapMarkers.push(marker);
        bounds.push([store.lat, store.lon]);
    });

    // Route line
    if (best.geometry && best.geometry.length > 1) {
        const line = L.polyline(best.geometry, { color: '#1e40af', weight: 4, opacity: 0.8 }).addTo(planMap);
        planMapLines.push(line);
    }

    planMap.fitBounds(bounds, { padding: [40, 40] });
    setTimeout(() => planMap.invalidateSize(), 100);
}

function renderStoreLists(best) {
    const section = document.getElementById('storeListsSection');
    section.innerHTML = '';

    // Group assignments by chain
    const byChain = {};
    for (const a of best.assignments) {
        if (!byChain[a.chain]) byChain[a.chain] = [];
        byChain[a.chain].push(a);
    }

    // Render in visit order
    for (const [i, store] of best.stores.entries()) {
        const items = byChain[store.chain] || [];
        const subtotal = items.reduce((s, a) => s + a.subtotal, 0);

        const block = document.createElement('div');
        block.className = 'store-list-block';
        block.innerHTML = `
            <div class="store-list-header">
                <span>Stop ${i+1}: ${esc(store.name)}</span>
                <span class="store-list-address">${esc(store.address || '')}</span>
            </div>
            <div class="store-list-body">
                ${items.map(a => `
                    <div class="store-list-item-row">
                        <span class="store-list-item-name">
                            ${esc(a.item.name)}${a.item.frozen ? ' ❄' : ''}
                            ${a.isDeal ? `<span class="deal-badge" title="Sale until ${a.validTo}">🏷 sale until ${esc(a.validTo)}</span>` : ''}
                            ${a.unitPriceMl ? `<span class="unit-price-note">${fmt$(a.unitPriceMl * 1000)}/L</span>`
                              : a.unitPriceG ? `<span class="unit-price-note">${fmt$(a.unitPriceG * 1000)}/kg</span>` : ''}
                        </span>
                        <span class="store-list-item-qty">×${a.qty}</span>
                        <span class="store-list-item-price">${fmt$(a.subtotal)}</span>
                    </div>
                `).join('')}
                <div class="store-list-subtotal">
                    <span>Subtotal</span><span>${fmt$(subtotal)}</span>
                </div>
            </div>
            ${best.missing.length ? `<div class="missing-items-note">⚠ ${best.missing.map(i=>esc(i.name)).join(', ')} — no price found at these stores.</div>` : ''}
        `;
        section.appendChild(block);
    }
}

function renderComparisonTable(allPlans, best) {
    const table = document.getElementById('comparisonTable');
    table.innerHTML = `
        <thead>
            <tr>
                <th>Plan</th>
                <th>Basket</th>
                <th>Travel</th>
                <th>Total</th>
                <th>Distance</th>
                <th>Time</th>
            </tr>
        </thead>
        <tbody>
            ${allPlans.map(plan => {
                const label = plan.stores.map(s => s.name).join(' + ');
                const isBest = plan === best;
                return `<tr class="${isBest ? 'best-plan' : ''}">
                    <td>${isBest ? '★ ' : ''}${esc(label)}</td>
                    <td>${fmt$(plan.basketTotal)}</td>
                    <td>${plan.travCost > 0 ? fmt$(plan.travCost) : 'free'}</td>
                    <td><strong>${fmt$(plan.grandTotal)}</strong></td>
                    <td>${fmtDist(plan.distanceM)}</td>
                    <td>${fmtTime(plan.durationSec)}</td>
                </tr>`;
            }).join('')}
        </tbody>
    `;
}

// ── Print / PDF shopping list ─────────────────────────────────────────────
function setupPrintList(best) {
    const btn = document.getElementById('printListBtn');
    btn.onclick = () => generatePrintList(best);
}

function generatePrintList(best) {
    const printArea = document.getElementById('printArea');
    const byChain = {};
    for (const a of best.assignments) {
        if (!byChain[a.chain]) byChain[a.chain] = [];
        byChain[a.chain].push(a);
    }

    const now = new Date().toLocaleDateString('en-CA', { year: 'numeric', month: 'long', day: 'numeric' });
    let html = `<div class="print-title">Shopping List</div>`;
    html += `<div class="print-subtitle">Generated ${now} — Total: ${fmt$(best.grandTotal)}</div>`;

    for (const [i, store] of best.stores.entries()) {
        const items = byChain[store.chain] || [];
        const subtotal = items.reduce((s, a) => s + a.subtotal, 0);
        html += `<div class="print-store-block">`;
        html += `<div class="print-store-name">Stop ${i+1}: ${esc(store.name)}</div>`;
        if (store.address) html += `<div class="print-store-address">${esc(store.address)}</div>`;
        if (items.some(a => a.item.frozen)) {
            html += `<div class="print-store-note">❄ Buy frozen items last (keep cold)</div>`;
        }
        html += items.map(a => `
            <div class="print-item-row">
                <div class="print-checkbox"></div>
                <div class="print-item-name">${esc(a.item.name)}</div>
                <div class="print-item-qty">×${a.qty}</div>
                <div class="print-item-price">${fmt$(a.subtotal)}</div>
            </div>
        `).join('');
        html += `<div class="print-store-subtotal"><span>Subtotal</span><span>${fmt$(subtotal)}</span></div>`;
        html += `</div>`;
    }

    html += `<div class="print-grand-total"><span>Grand Total</span><span>${fmt$(best.grandTotal)}</span></div>`;

    printArea.innerHTML = html;
    window.print();
}

// ── Export / Import catalog ───────────────────────────────────────────────
function exportCatalog() {
    const data = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), catalog }, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url;
    a.download = `grocerypal-catalog-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

function importCatalog(file) {
    const msg = document.getElementById('ioStatus');
    const reader = new FileReader();
    reader.onload = e => {
        try {
            const data = JSON.parse(e.target.result);
            if (!Array.isArray(data.catalog)) throw new Error('Invalid format');
            catalog = data.catalog;
            saveCatalog();
            renderShoppingList();
            showMsg(msg, `Imported ${catalog.length} items.`, 'success');
        } catch {
            showMsg(msg, 'Import failed: invalid file.', 'error');
        }
    };
    reader.readAsText(file);
}

// ── Utility ──────────────────────────────────────────────────────────────
function esc(str) {
    return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function showMsg(el, text, type) {
    el.textContent = text;
    el.className = 'form-msg' + (type ? ' ' + type : '');
}

// ── Auth ──────────────────────────────────────────────────────────────────
function updateAuthUI(user) {
    window.gpAuthUser = user;
    const label   = document.getElementById('authUserLabel');
    const signIn  = document.getElementById('authSignInBtn');
    const signOut = document.getElementById('authSignOutBtn');
    if (user) {
        label.textContent  = user.email;
        signIn.style.display  = 'none';
        signOut.style.display = 'inline-block';
    } else {
        label.textContent  = '';
        signIn.style.display  = 'inline-block';
        signOut.style.display = 'none';
    }
    // Refresh submit button state in flyer-import if loaded
    if (typeof updateSubmitBtn === 'function') updateSubmitBtn();
}

function openSignInModal() {
    document.getElementById('signInModal').style.display = 'flex';
    document.getElementById('authEmail').focus();
    document.getElementById('authMsg').textContent = '';
}

function closeSignInModal() {
    document.getElementById('signInModal').style.display = 'none';
}

async function doSignIn() {
    const email    = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const msg      = document.getElementById('authMsg');
    if (!email || !password) { showMsg(msg, 'Enter email and password.', 'error'); return; }
    if (!gpAuth) { showMsg(msg, 'Firebase not configured.', 'error'); return; }

    showMsg(msg, 'Signing in…', '');
    try {
        const cred = await gpAuth.signInWithEmailAndPassword(email, password);
        updateAuthUI(cred.user);
        closeSignInModal();
    } catch (e) {
        showMsg(msg, e.message, 'error');
    }
}

async function doSignUp() {
    const email    = document.getElementById('authEmail').value.trim();
    const password = document.getElementById('authPassword').value;
    const msg      = document.getElementById('authMsg');
    if (!email || !password) { showMsg(msg, 'Enter email and password.', 'error'); return; }
    if (!gpAuth) { showMsg(msg, 'Firebase not configured.', 'error'); return; }

    showMsg(msg, 'Creating account…', '');
    try {
        const cred = await gpAuth.createUserWithEmailAndPassword(email, password);
        updateAuthUI(cred.user);
        showMsg(msg, 'Account created! You are now signed in.', 'success');
        setTimeout(closeSignInModal, 1200);
    } catch (e) {
        showMsg(msg, e.message, 'error');
    }
}

async function doSignOut() {
    if (gpAuth) await gpAuth.signOut();
    updateAuthUI(null);
}

// ── Init ─────────────────────────────────────────────────────────────────
function init() {
    catalog  = loadCatalog();
    list     = loadList();
    settings = { ...defaultSettings(), ...loadSettings() };

    // Build chain-dependent DOM before anything reads it.
    buildPriceGrid('price', '#addPriceGrid');
    buildPriceGrid('editPrice', '#editPriceGrid');
    populateChainSelect('flyerChainSelect');

    applySettingsToUI();
    renderShoppingList();
    renderCatalogResults('');

    // Auth
    if (gpAuth && gpDb) {
        gpAuth.onAuthStateChanged(user => {
            updateAuthUI(user);
        });
        fetchDealPrices();
    } else {
        updateAuthUI(null);
        const badge = document.getElementById('dealsCountBadge');
        if (badge) { badge.textContent = 'community deals unavailable — Firebase not configured'; }
    }

    document.getElementById('authSignInBtn')?.addEventListener('click', openSignInModal);
    document.getElementById('authSignOutBtn')?.addEventListener('click', doSignOut);
    document.getElementById('doSignInBtn')?.addEventListener('click', doSignIn);
    document.getElementById('doSignUpBtn')?.addEventListener('click', doSignUp);
    document.getElementById('cancelSignInBtn')?.addEventListener('click', closeSignInModal);
    document.getElementById('signInModal')?.addEventListener('click', e => {
        if (e.target === document.getElementById('signInModal')) closeSignInModal();
    });
    document.getElementById('authPassword')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doSignIn();
    });

    // Catalog search
    document.getElementById('catalogSearch').addEventListener('input', e => {
        renderCatalogResults(e.target.value);
    });
    document.getElementById('catalogSearch').addEventListener('blur', () => {
        setTimeout(() => {
            const box = document.getElementById('catalogResults');
            const q = document.getElementById('catalogSearch').value.trim();
            if (!q) box.classList.remove('visible');
        }, 200);
    });

    // Shopping list interactions (delegated)
    document.getElementById('shoppingList').addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (!btn) return;
        const id = btn.dataset.id;
        if (!id) return;

        if (btn.dataset.action === 'inc') {
            const entry = list.find(e => e.itemId === id);
            if (entry) { setQty(id, entry.qty + 1); renderShoppingList(); }
        } else if (btn.dataset.action === 'dec') {
            const entry = list.find(e => e.itemId === id);
            if (entry) { setQty(id, entry.qty - 1); renderShoppingList(); }
        } else if (btn.classList.contains('edit-item-btn')) {
            openEditModal(id);
        } else if (btn.classList.contains('remove-item-btn')) {
            removeFromList(id);
            renderShoppingList();
        }
    });

    // Add item
    document.getElementById('addItemBtn').addEventListener('click', handleAddItem);
    document.getElementById('newItemName').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleAddItem();
    });

    // Mode buttons
    document.querySelectorAll('.mode-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            setActiveMode(btn.dataset.mode);
            saveSettings();
        });
    });

    // Car class change
    document.getElementById('carClassSelect').addEventListener('change', updateCarSubfields);

    // Geocode
    document.getElementById('geocodeBtn').addEventListener('click', handleGeocode);
    document.getElementById('addressInput').addEventListener('keydown', e => {
        if (e.key === 'Enter') handleGeocode();
    });

    // Find plan
    document.getElementById('findPlanBtn').addEventListener('click', findBestPlan);

    // Edit modal
    document.getElementById('saveEditBtn').addEventListener('click', handleSaveEdit);
    document.getElementById('cancelEditBtn').addEventListener('click', closeEditModal);
    document.getElementById('deleteItemBtn').addEventListener('click', handleDeleteItem);
    document.getElementById('editModal').addEventListener('click', e => {
        if (e.target === document.getElementById('editModal')) closeEditModal();
    });

    // Export / import
    document.getElementById('exportCatalogBtn').addEventListener('click', exportCatalog);
    document.getElementById('importCatalogBtn').addEventListener('click', () => {
        document.getElementById('importFileInput').click();
    });
    document.getElementById('importFileInput').addEventListener('change', e => {
        if (e.target.files[0]) importCatalog(e.target.files[0]);
        e.target.value = '';
    });

    // Clear local data
    document.getElementById('clearLocalStorageBtn').addEventListener('click', () => {
        if (!confirm('Clear all local data? This will erase your catalog, shopping list, and saved settings. This cannot be undone.')) return;
        localStorage.clear();
        location.reload();
    });

    // Flyer JSON import
    document.getElementById('importFlyerJsonBtn').addEventListener('click', openFlyerJsonModal);
    document.getElementById('flyerJsonSubmitBtn').addEventListener('click', submitFlyerJson);
    document.getElementById('flyerJsonLocalOnlyBtn').addEventListener('click', () => submitFlyerJson(true));
    document.getElementById('flyerJsonCancelBtn').addEventListener('click', closeFlyerJsonModal);
    document.getElementById('flyerJsonModal').addEventListener('click', e => {
        if (e.target === document.getElementById('flyerJsonModal')) closeFlyerJsonModal();
    });

    // Settings persistence on any change
    document.getElementById('gasPriceInput').addEventListener('change', () => { collectSettings(); saveSettings(); });
    document.getElementById('evRateInput').addEventListener('change', () => { collectSettings(); saveSettings(); });
    document.getElementById('transitFareInput').addEventListener('change', () => { collectSettings(); saveSettings(); });
    document.getElementById('frozenLastCheck').addEventListener('change', () => { collectSettings(); saveSettings(); });
    document.getElementById('carClassSelect').addEventListener('change', () => { collectSettings(); saveSettings(); });
}

// ── Flyer JSON import ─────────────────────────────────────────────────────
function openFlyerJsonModal() {
    document.getElementById('flyerJsonInput').value = '';
    document.getElementById('flyerJsonMsg').textContent = '';
    document.getElementById('flyerJsonModal').style.display = 'flex';
    document.getElementById('flyerJsonInput').focus();
}

function closeFlyerJsonModal() {
    document.getElementById('flyerJsonModal').style.display = 'none';
}

async function submitFlyerJson(localOnly = false) {
    const btn    = localOnly ? document.getElementById('flyerJsonLocalOnlyBtn') : document.getElementById('flyerJsonSubmitBtn');
    const msg    = document.getElementById('flyerJsonMsg');
    const raw    = document.getElementById('flyerJsonInput').value.trim();
    const addLocal = localOnly || document.getElementById('flyerJsonLocalCheck').checked;

    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        showMsg(msg, 'Invalid JSON — check the format and try again.', 'error');
        return;
    }

    const { chain, valid_from, valid_to, region = 'ontario', items } = parsed;
    if (!chain || !valid_from || !valid_to || !Array.isArray(items) || !items.length) {
        showMsg(msg, 'Missing required fields: chain, valid_from, valid_to, items.', 'error');
        return;
    }

    // Submit to Firestore if signed in and not local-only
    if (!localOnly && gpDb && window.gpAuthUser) {
        const rows = items.map(it => ({
            user_id:    window.gpAuthUser.uid,
            region,
            chain,
            item_name:  it.item_name,
            barcode:    it.barcode ? String(it.barcode) : null,
            price:      parseFloat(parseFloat(it.price).toFixed(2)),
            unit:       it.unit || 'each',
            frozen:     !!it.frozen,
            valid_from,
            valid_to,
            created_at: new Date().toISOString(),
        }));

        btn.disabled = true;
        showMsg(msg, 'Submitting…', '');
        try {
            const batch = gpDb.batch();
            for (const row of rows) batch.set(gpDb.collection('flyer_prices').doc(), row);
            await batch.commit();
            showMsg(msg, `✓ ${rows.length} items submitted to community database.`, 'success');
            await fetchDealPrices();
            if (typeof updateDealsCountBadge === 'function') updateDealsCountBadge();
        } catch (e) {
            showMsg(msg, 'Submit failed: ' + (e.message || e), 'error');
            btn.disabled = false;
            return;
        }
        btn.disabled = false;
    } else if (!localOnly && gpDb && !window.gpAuthUser) {
        showMsg(msg, 'Sign in first to submit to the community database.', 'error');
        return;
    }

    // Merge into local catalog
    if (addLocal) {
        for (const it of items) {
            const normName = it.item_name.toLowerCase().trim();
            const barcodeStr = it.barcode ? String(it.barcode) : null;
            let existing = catalog.find(c =>
                (barcodeStr && c.barcode === barcodeStr) ||
                c.name.toLowerCase().trim() === normName
            );
            if (existing) {
                if (existing.prices[chain] == null || existing.prices[chain] > it.price) {
                    existing.prices[chain] = parseFloat(it.price);
                }
            } else {
                catalog.push({
                    id: uuid(),
                    name:     it.item_name,
                    category: it.frozen ? 'frozen' : 'pantry',
                    barcode:  barcodeStr,
                    frozen:   !!it.frozen,
                    prices:   { ...emptyPrices(), [chain]: parseFloat(it.price) },
                });
            }
        }
        saveCatalog();
        renderShoppingList();
        const localMsg = gpDb && window.gpAuthUser
            ? ` Also added ${items.length} items to your local catalog.`
            : `Added ${items.length} items to your local catalog.`;
        showMsg(msg, (msg.textContent || '') + localMsg, 'success');
    }

    setTimeout(closeFlyerJsonModal, 2000);
}

document.addEventListener('DOMContentLoaded', init);
