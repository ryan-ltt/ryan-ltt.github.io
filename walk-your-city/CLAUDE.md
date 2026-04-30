# Walk Your City — Project Briefing

## What It Does

A personal web app for tracking which city streets you have physically walked. For each supported city (Toronto, Vancouver, Montréal, Padova), every walkable street segment is displayed on an interactive Leaflet map. Clicking a segment marks it as walked on a specific date. A progress bar and status line show streets and kilometres covered. A History tab lets you pick any past date to see which streets you walked that day.

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
- Two tabs: "mark walks" (main) and "history", each with a date picker, a fullscreen button, and a map+sidebar layout. Each map-layout (`#mapLayoutMark`, `#mapLayoutHistory`) contains a hidden `.fullscreen-close-btn` that surfaces in fullscreen mode.
- Sign-in modal (fixed overlay) supporting both sign-in and sign-up flows (email + password, no magic link). Error shown inline.
- Auth bar lives in the header `<nav>` (top-right), not the IO bar.
- Script tags: Leaflet → `supabase.min.js` → `walk-your-city.js`.

### `walk-your-city.js` (~780 lines, strict mode, no bundler)

**State**
- `walks` — `Map<wayId, 'YYYY-MM-DD'>` of every marked segment.
- `polylines` / `historyPolylines` — `Map<wayId, LeafletPolyline>` for each tab's map.
- `cityData`, `cityState` — raw JSON and derived index structures for the current city.
- `currentUser` — Supabase user object or `null`.
- `SUPABASE_URL` / `SUPABASE_ANON_KEY` — hardcoded publishable credentials.

**Key functions**
- `init()` — bootstraps maps, wires DOM listeners, restores auth session, registers service worker, loads Toronto as default city. Also wires fullscreen buttons for both tabs and a global Escape key listener.
- `loadCity(cityKey)` — fetches `data/<cityKey>.json`, builds state, renders map + sidebar, subscribes to realtime.
- `buildState(data)` — builds two indices from raw JSON: `ways` (`Map<wayId, wayObject>`) and `streets` (`Map<streetKey, {name, wayIds[], totalLengthM}>`). Street keys are lowercased/underscored/stripped names.
- `renderMap()` — creates one `L.polyline` per way segment (clickable → `toggleWay()`). Both maps use `preferCanvas: true` for performance with up to 88K polylines.
- `styleForMark(date)` — grey/transparent (unwalked), green (walked another day), dark green full opacity (walked today). Line weight scales 2–8 px with zoom.
- `toggleWay(wayId)` — core interaction: updates `walks` Map, saves to localStorage, upserts/deletes from Supabase if signed in, surgically updates the affected polyline style and sidebar row without re-rendering the full list.
- `subscribeRealtime(cityKey)` — Supabase realtime subscription on `walks` table filtered by city; applies INSERT/UPDATE/DELETE live.
- `migrateLocalStorageIfNeeded()` — one-time migration on sign-in: bulk-upserts all cities' localStorage data to Supabase in 500-row batches, then marks completion in localStorage.
- `mergeImport(data)` — async; after merging JSON into `walks`, also upserts all rows to Supabase if signed in.
- `renderHistoryTab()` — draws all ways faintly, highlights selected day's walks in blue (`#2563eb`), auto-fits map to that day's segments.
- `segLabel(w)` — formats cross-street label: `"Oak St → Elm Ave"`, `"from Oak St"`, `"to Elm Ave"`, or just the length as fallback.
- `enterFullscreen(layoutId, mapObj)` / `exitFullscreen(layoutId, mapObj)` — add/remove `.fullscreen` class on the map-layout div and call `mapObj.invalidateSize()` after 50 ms so Leaflet redraws to the new size.

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
- Responsive at 700 px: map + sidebar stack vertically.

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
```

**Toggle walk**
```
click map polyline or sidebar row → toggleWay(wayId)
  → update walks Map
  → saveProgress (localStorage, always)
  → db upsert/delete (if signed in)
  → update polyline style in-place
  → update sidebar row DOM in-place
  → refreshStreetHeader
  → updateStatus (progress bar + text)
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
