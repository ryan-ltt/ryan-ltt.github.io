# Walk Your City — Project Briefing

## What It Does

A personal web app for tracking which city streets you have physically walked. For each supported city (Toronto, Vancouver, Montréal, Padova), every walkable street segment is displayed on an interactive Leaflet map. Clicking a segment marks it as walked on a specific date. A progress bar and status line show streets and kilometres covered. A History tab lets you pick any past date to see which streets you walked that day. A Generate Route tab lets you generate a walking route of a specified distance from a start point, with GPX export.

## Tech Stack

| Layer | Technology |
|---|---|
| Mapping | Leaflet.js 1.9.4 (CDN via unpkg) |
| Tile source | OpenStreetMap (`tile.openstreetmap.org`) |
| Auth + cloud DB | Supabase (vendored `supabase.min.js`, ~192 KB) |
| Offline tile caching | Service Worker (`sw.js`) |
| Street data pipeline | Python 3 + OSM Overpass API (developer tool, not browser) |
| Guest storage | `localStorage` |
| Signed-in storage | Supabase Postgres table `walks` + realtime subscription |
| Build system | None — plain static HTML/CSS/JS, no bundler |

## File Overview

### `index.html`
Single-page application shell. Contains:
- Header with site nav, city dropdown, and auth bar (sign in / sign out / email).
- IO bar: city selector, import/export JSON buttons, reset button, status line.
- Progress bar (`#progressFill`) showing % of streets fully walked.
- Three tabs: "mark walks", "history", and "generate route". Each has a map+sidebar layout (`#mapLayoutMark`, `#mapLayoutHistory`, `#mapLayoutRoute`) with a fullscreen button.
- Generate route tab has three control rows: (1) address input + find button, (2) distance, time estimate, loop toggle, generate, download gpx, (3) status line. A colour legend sits below.
- Sign-in modal (fixed overlay) supporting both sign-in and sign-up flows (email + password, no magic link). Error shown inline.
- Auth bar lives in the header `<nav>` (top-right), not the IO bar.
- Script tags: Leaflet → `supabase.min.js` → `walk-your-city.js`.

### `walk-your-city.js` (strict mode, no bundler)

**State**
- `walks` — `Map<wayId, 'YYYY-MM-DD'>` of every marked segment.
- `polylines` / `historyPolylines` — `Map<wayId, LeafletPolyline>` for mark and history tab maps.
- `routePolylines` — `Map<wayId, LeafletPolyline>` for the route tab background layer.
- `routeHighlight` — `LeafletPolyline[]` for the generated route (purple = new, red = already walked).
- `routeStartMarker`, `routeStartLatLon`, `routeStartWayId` — current start point state.
- `routeGraph`, `lastRouteCity` — lazily built graph, invalidated on city change.
- `lastRouteWayIds` — way IDs of last generated route, used for GPX export.
- `lastTurnaroundNode` — excluded from the next generate to ensure a different route each press.
- `cityData`, `cityState` — raw JSON and derived index structures for the current city.
- `currentUser` — Supabase user object or `null`.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — hardcoded publishable credentials.

**Key functions**
- `init()` — bootstraps all three maps, wires DOM listeners, restores auth session, registers service worker, loads Toronto as default city. Wires fullscreen buttons for all three tabs and a global Escape key listener. Also listens for `visibilitychange` to call `invalidateAll()` on tab focus restore (fixes canvas repaint after alt-tab).
- `invalidateAll()` — calls `invalidateSize()` on all three Leaflet maps.
- `loadCity(cityKey)` — fetches `data/<cityKey>.json`, builds state, renders map + sidebar, subscribes to realtime. Also clears all route state.
- `switchTab(tab)` — shows/hides tab panes, calls `renderRouteBackground()` when switching to route tab.
- `buildState(data)` — builds two indices from raw JSON: `ways` (`Map<wayId, wayObject>`) and `streets` (`Map<streetKey, {name, wayIds[], totalLengthM}>`). Street keys are lowercased/underscored/stripped names.
- `renderMap()` — creates one `L.polyline` per way segment (clickable → `toggleWay()`). All maps use `preferCanvas: true` for performance with up to 88K polylines.
- `styleForMark(date)` — grey/transparent (unwalked), green (walked another day), dark green full opacity (walked today). Line weight scales 2–8 px with zoom.
- `toggleWay(wayId)` — core interaction: updates `walks` Map, saves to localStorage, upserts/deletes from Supabase if signed in, surgically updates mark map polyline, route background polyline, and sidebar row in-place.
- `subscribeRealtime(cityKey)` — Supabase realtime subscription on `walks` table filtered by city; applies INSERT/UPDATE/DELETE live.
- `migrateLocalStorageIfNeeded()` — one-time migration on sign-in: bulk-upserts all cities' localStorage data to Supabase in 500-row batches, then marks completion in localStorage.
- `mergeImport(data)` — async; after merging JSON into `walks`, also upserts all rows to Supabase if signed in.
- `renderHistoryTab()` — draws all ways faintly, highlights selected day's walks in blue (`#2563eb`), auto-fits map to that day's segments.
- `renderList()` — re-renders the full sidebar street list. Streets with at least one walked segment sort first, then alphabetically.
- `segLabel(w)` — formats cross-street label: `"Oak St → Elm Ave"`, `"from Oak St"`, `"to Elm Ave"`, or length fallback.
- `enterFullscreen(layoutId, mapObj)` / `exitFullscreen(layoutId, mapObj)` — add/remove `.fullscreen` class. On exit, forces reflow then calls `invalidateSize()` and re-renders the relevant map.
- `buildRouteGraph()` — builds an adjacency list graph from `cityState.ways`. Nodes are way endpoints keyed by `lat.toFixed(6),lon.toFixed(6)`. Edges are bidirectional with `{ to, wayId, cost: length_m }`.
- `dijkstra(graph, startNodeId, penaltyFactor, extraPenalised?)` — binary min-heap Dijkstra. Edge cost = `length_m * penaltyFactor` if the way is in `walks` or `extraPenalised`, else `length_m`. Returns `{ dist: Float64Array, prev }`.
- `buildLoopRoute(graph, startNodeId, targetM, excludeNode?)` — 3 Dijkstra calls: (1) unpenalised for geographic radius band, (2) penalised outbound, (3) penalised return from turnaround with outbound ways as `extraPenalised`. Picks turnaround node from shuffled band whose `penDistOut * 2` is closest to `targetM`, excluding `excludeNode` for variety. Stores chosen node in `lastTurnaroundNode`.
- `buildLinearRoute(graph, startNodeId, targetM)` — 2 Dijkstra calls: unpenalised for geographic band, penalised for path. Picks endpoint closest to `targetM`.
- `generateRoute()` — async; validates state, builds graph lazily, finds start node, calls loop/linear builder, renders result.
- `renderRouteBackground()` — draws all ways on route map: walked streets in green (matching mark tab colours), unwalked faintly grey. Updated in-place by `toggleWay`.
- `renderGeneratedRoute(wayIds)` — draws route highlight: purple (`ROUTE_COLOR`) for new streets, red/rose (`ROUTE_OVERLAP_COLOR`) for already-walked segments. Fits map bounds, updates status and sidebar.
- `renderRouteSidebar(wayObjects)` — ordered list of route segments; click flies to segment and flashes orange.
- `exportGpx()` — builds GPX 1.1 XML from `lastRouteWayIds`, triggers browser download.
- `geocodeAddress(address)` — Nominatim search bounded to current city's geographic extent (derived from `cityData.ways` at call time).
- `findClosestWay(lat, lon)` — O(n) scan of all way geometry segments, returns wayId of closest.

**Storage format (v2)**
```json
{ "version": 2, "city": "toronto", "walks": { "way/123": "2026-04-01" } }
```
Stored under `walkYourCity_<city>` in localStorage. The app migrates v1 (plain walked ID arrays) to v2 on load.

**Known bug — Reset**
`resetData()` calls `Object.keys(CITIES)` where `CITIES` is an array, so it gets string indices `['0','1','2']` instead of city names. `localStorage.removeItem('walkYourCity_0')` etc. are no-ops. Only the in-memory `walks` Map is cleared.

### `walk-your-city.css`
- Monospace font (Monaco) throughout.
- `.map-layout`: flexbox, map fills remaining width, sidebar fixed at 280 px, both 600 px tall.
- `.map-layout.fullscreen`: `position: fixed; inset: 0; z-index: 500` — covers the full viewport. Map and sidebar both stretch to 100% height. A floating close button (`.fullscreen-close-btn`) is revealed via `display: block` at top-left.
- Progress bar: 6 px green fill with CSS `transition: width 0.3s ease`.
- `.street-header.some-walked` → green tint background; `.all-walked` → dark green name text.
- Route tab: `.route-controls-row` for each row of controls, `.route-legend` + `.route-legend-swatch` for the colour legend, `#mapRoute` / `#sidePanelRoute` sized same as other maps.
- Responsive at 700 px: map + sidebar stack vertically (applies to all three tab maps).

### `sw.js`
Minimal service worker for offline tile caching:
- Cache name: `osm-tiles-v1`, max 2000 tiles.
- Cache-first strategy for all `tile.openstreetmap.org` requests.
- FIFO eviction: when limit is reached, deletes `keys[0]` before caching the new tile.

### `fetch-city-data.py` (developer tool, not run by browser)
Data generation pipeline:
1. Overpass query — fetches all `highway` ways within the city's OSM relation boundary.
2. Filters to named ways with walkable highway types; excludes motorways, trunks, link roads.
3. Splits ways at intersections (block-level segments), derives `from`/`to` cross-street labels.
4. Drops segments < 10 m.
5. Collapses dual carriageways: same-named ways within 80 m and < 30° bearing difference get a shared `groupId` (union-find).
6. Writes `data/<city>.json`.

City OSM relations: Toronto (324211), Vancouver (1852574), Montréal (1634158), Padova (44836). Waits 5 s between cities to be polite to Overpass.

**Adding new cities (`--add`):** `python fetch-city-data.py --add "City Name"` looks up the OSM relation via Nominatim, prompts to pick if multiple matches, then automatically patches the `CITIES` dict in the script itself and adds the `<option>` to `index.html`. No manual edits needed. Re-fetching existing cities: `--cities toronto vancouver`.

### `data/toronto.json`, `vancouver.json`, `montreal.json`, `padova.json`
Pre-generated static files committed to git. Must be manually regenerated by running `fetch-city-data.py`.

| City | Segments | Dual-carriageway groups | File size |
|---|---|---|---|
| Toronto | 54,137 | 6,444 | ~17.5 MB |
| Vancouver | 16,086 | 1,823 | ~5.2 MB |
| Montréal | 88,237 | 8,539 | ~33.3 MB |
| Padova | 10,404 | 1,740 | ~3.7 MB |

Each `way` object: `id`, `name`, `highway`, `geometry` (`[lat, lon][]`), `length_m`, `from`, `to`, optional `groupId`.

Last fetched: 2026-04-29.

### `supabase.min.js`
Vendored Supabase JS client (~192 KB, minified). Exposes `window.supabase`. Bundled locally to avoid third-party CDN dependency (recent switch from jsDelivr).

## Supabase `walks` Table Schema (inferred)

| Column | Type | Notes |
|---|---|---|
| `user_id` | uuid | FK to auth.users |
| `city` | text | `'toronto'`, `'vancouver'`, `'montreal'` |
| `way_id` | text | e.g. `'way/123'` or `'way/123_1'` for split segments |
| `walked_on` | date | `'YYYY-MM-DD'` |
| — | unique | `(user_id, city, way_id)` |

## Key Data Flows

**City load**
```
loadCity(cityKey)
  → loadProgress from localStorage
  → loadProgressFromDB (if signed in, overwrites local)
  → saveProgress (sync DB result back to localStorage)
  → fetch("data/<city>.json")
  → buildState → renderMap → subscribeRealtime → renderList → updateStatus
  → clear all route state (graph, highlight, marker, GPX button)
  → if activeTab === 'route': renderRouteBackground()
```

**Toggle walk**
```
click map polyline or sidebar row → toggleWay(wayId)
  → update walks Map
  → saveProgress (localStorage, always)
  → db upsert/delete (if signed in)
  → update mark map polyline style in-place
  → update route background polyline style in-place
  → renderList (re-renders sidebar, visited streets sorted first)
  → updateStatus (progress bar + text)
```

**Generate route**
```
click generate → generateRoute()
  → buildRouteGraph() if city changed (lazy)
  → findClosestWay() to snap start point to graph node
  → buildLoopRoute() or buildLinearRoute() — 3 or 2 Dijkstra calls
  → renderGeneratedRoute() — purple (new) / red (walked) polylines
  → renderRouteSidebar()
  → show download gpx button
```

**Auth + migration**
```
sign in → onAuthStateChange('SIGNED_IN')
  → migrateLocalStorageIfNeeded (all 3 cities → Supabase, 500-row batches)
  → loadCity (now reads from DB)
```

**Realtime sync (multi-device)**
```
Supabase postgres_changes on walks table (filtered by city)
  → applyRealtimeChange → update walks Map → refresh polyline → updateStatus
```

## Important Implementation Notes

- **No build step.** Everything is plain static HTML/CSS/JS loaded directly in the browser.
- **Auth is opt-in.** The app is fully functional with only `localStorage`. Supabase enables cross-device sync. Email confirm is disabled in Supabase — users can sign up and log in immediately.
- **`toggleWay` is async.** The DB upsert/delete is awaited so errors surface in the console rather than silently failing.
- **In-place DOM updates.** `toggleWay()` surgically updates only the affected polyline and sidebar row — not the whole list. This matters for performance with 88K segments in Montréal.
- **Street grouping is client-side.** The sidebar groups segments by normalized name at runtime in `buildState()`. The `groups` array in the JSON is dual-carriageway metadata used only by the Python pipeline — the JS does not currently consume it.
- **`data/` JSON files are large.** Montréal is 33 MB. Loading a new city involves a full `fetch()` of that file; there is no lazy loading.
- **Supabase credentials are public (anon key).** This is intentional for a Supabase project — row-level security on the `walks` table enforces user isolation server-side.
- **Route graph is built lazily** on first generate press for a city, then cached in `routeGraph` until city changes. Building the graph for Toronto (~54K nodes) takes ~100ms.
- **Dijkstra uses a binary min-heap** (O(E log V)). Two runs per generate (unpenalised + penalised). A third run (penalised return from turnaround with outbound ways extra-penalised) encourages a different return path. Total ~3 Dijkstra calls per generate.
- **Route distance accuracy:** geographic (unpenalised) Dijkstra distances are used to identify the radius band; penalised Dijkstra is used only for path selection. This prevents the walked penalty from inflating apparent distances and producing short routes.
- **Canvas repaint after alt-tab:** `visibilitychange` listener calls `invalidateAll()` when the tab regains focus, forcing Leaflet to repaint all three canvas maps.
- **Known bug — Reset:** `resetData()` calls `Object.keys(CITIES)` where `CITIES` is an array, so it gets string indices instead of city names. Only the in-memory `walks` Map is cleared; localStorage entries are not removed.
