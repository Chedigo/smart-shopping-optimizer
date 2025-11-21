/* service-worker.js
   Runtime caching:
   - CSS/JS/ikon + products.json: stale-while-revalidate (kjapt + bakgrunnsoppdatering)
   - /.netlify/functions/kassalapp: network-first m/ fallback til cache (prisene føles ferske)
   Kilder:
   - MDN/Workbox om strategier (SWR, network-first)  */

const VERSION = 'v1.3.0';
const PRECACHE = `sso-precache-${VERSION}`;
const RUNTIME_STATIC = 'sso-static';
const RUNTIME_API = 'sso-api';

// Hva vi vet vi trenger for å få appen opp
const PRECACHE_URLS = [
  '/',                 // Netlify dev kan trenge dette
  '/index.html',
  '/styles/tokens.css',
  '/styles/themes.css',
  '/styles/components/card.css',
  '/styles/components/button.css',
  '/styles/fixes.css',
  '/app.js',
  '/scripts/theme-toggle.js',
  '/manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(PRECACHE).then((cache) => cache.addAll(PRECACHE_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => ![PRECACHE, RUNTIME_STATIC, RUNTIME_API].includes(k))
        .map((k) => caches.delete(k))
    );
  })());
  self.clients.claim();
});

// Liten util: SWR (stale-while-revalidate) for statiske ressurser
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchPromise = fetch(request).then((networkResp) => {
    // Ikke cache opaque feil / upassende
    if (networkResp && networkResp.ok) {
      cache.put(request, networkResp.clone());
    }
    return networkResp;
  }).catch(() => cached);
  return cached || fetchPromise;
}

// Network-first for API, med fallback til cache
async function networkFirst(request, cacheName, { timeoutMs = 4500 } = {}) {
  const cache = await caches.open(cacheName);

  // Tidsavbrudd for å unngå heng (gir rask fallback offline)
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(request, { signal: controller.signal, cache: 'no-store' });
    clearTimeout(t);
    if (resp && resp.ok) {
      cache.put(request, resp.clone());
    }
    return resp;
  } catch (err) {
    clearTimeout(t);
    const cached = await cache.match(request);
    if (cached) return cached;

    // Minimal “offline response” for API-kall (HTTP 503 m/JSON)
    return new Response(JSON.stringify({ error: 'offline', detail: 'cached response missing' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8' }
    });
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Bare håndter GET
  if (req.method !== 'GET') return;

  // API (pris/proxy): Network-first
  if (url.pathname.startsWith('/.netlify/functions/kassalapp')) {
    event.respondWith(networkFirst(req, RUNTIME_API));
    return;
  }

  // Lokalt datasett: products.json → SWR
  if (url.pathname.endsWith('/data/products.json')) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_STATIC));
    return;
  }

  // Vår app sine statiske assets (CSS/JS/HTML) → SWR
  const isStatic = (
    url.origin === location.origin &&
    (
      url.pathname.endsWith('.css') ||
      url.pathname.endsWith('.js')  ||
      url.pathname.endsWith('.webmanifest') ||
      url.pathname === '/' ||
      url.pathname.endsWith('/index.html')
    )
  );
  if (isStatic) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_STATIC));
    return;
  }

  // Alt annet: la nettverket håndtere (du kan utvide ved behov)
});
