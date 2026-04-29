const TILE_CACHE = 'osm-tiles-v1';
const MAX_TILES = 2000;

self.addEventListener('fetch', event => {
    const url = event.request.url;
    if (!url.includes('tile.openstreetmap.org')) return;

    event.respondWith(
        caches.open(TILE_CACHE).then(async cache => {
            const cached = await cache.match(event.request);
            if (cached) return cached;

            const response = await fetch(event.request);
            if (response.ok) {
                // Evict oldest entries if over limit
                const keys = await cache.keys();
                if (keys.length >= MAX_TILES) {
                    await cache.delete(keys[0]);
                }
                cache.put(event.request, response.clone());
            }
            return response;
        })
    );
});
