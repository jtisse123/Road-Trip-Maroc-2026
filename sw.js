/* Road Trip Maroc — Service Worker (cache PWA + tuiles hors ligne) */
const APP_CACHE = "rtm-app-v8";
const TILE_CACHE = "rtm-tiles-v8";
const TILE_MAX = 6000; // nb max de tuiles conservées (permet le téléchargement hors-ligne de la zone)

const APP_ASSETS = [
  "./", "./index.html", "./styles.css", "./app.js", "./manifest.webmanifest",
  "./vendor/maplibre-gl.js", "./vendor/maplibre-gl.css",
  "./data/roadtrip.json", "./data/roadtrip.js",
  "./assets/icons/icon-192.png", "./assets/icons/icon-512.png",
  "./assets/icons/icon-maskable-512.png", "./assets/icons/apple-touch-icon.png",
  "./assets/icons/favicon-64.png",
];

const TILE_HOSTS = [
  "a.basemaps.cartocdn.com", "b.basemaps.cartocdn.com", "c.basemaps.cartocdn.com", "d.basemaps.cartocdn.com",
  "tile.openstreetmap.org", "a.tile.opentopomap.org", "b.tile.opentopomap.org", "c.tile.opentopomap.org",
  "tile.opentopomap.org", "server.arcgisonline.com",
];

self.addEventListener("install", (e) => {
  e.waitUntil(
    caches.open(APP_CACHE).then(c => c.addAll(APP_ASSETS)).then(() => self.skipWaiting()).catch(() => {})
  );
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys.filter(k => k !== APP_CACHE && k !== TILE_CACHE).map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

async function trimTiles() {
  const c = await caches.open(TILE_CACHE);
  const keys = await c.keys();
  if (keys.length > TILE_MAX) {
    for (let i = 0; i < keys.length - TILE_MAX; i++) await c.delete(keys[i]);
  }
}

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Tuiles cartographiques : cache d'abord, sinon réseau (et on met en cache)
  if (TILE_HOSTS.includes(url.hostname)) {
    e.respondWith((async () => {
      const c = await caches.open(TILE_CACHE);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res && (res.ok || res.type === "opaque")) { c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch (err) {
        return hit || Response.error();
      }
    })());
    return;
  }

  // App (même origine) : RÉSEAU d'abord (toujours la dernière version en ligne),
  // cache en repli si hors connexion. -> les mises à jour s'affichent automatiquement.
  if (url.origin === location.origin) {
    e.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok && res.type === "basic") {
          const c = await caches.open(APP_CACHE); c.put(req, res.clone());
        }
        return res;
      } catch (err) {
        const cached = await caches.match(req);
        if (cached) return cached;
        if (req.mode === "navigate") return caches.match("./index.html");
        throw err;
      }
    })());
  }
});
