/* Daybook service worker.
 *
 * Two jobs: keep the app itself openable with no connection, and hold the
 * offline food pack. It deliberately never touches USDA, Anthropic or your
 * Apps Script relay — those are live data and a stale cached answer would be
 * worse than an honest failure.
 *
 * Bump VERSION whenever you change this file or index.html and want every
 * device to drop what it has cached.
 */
const VERSION = 'v1';
const SHELL   = 'daybook-shell-' + VERSION;
const FONTS   = 'daybook-fonts-' + VERSION;

// Live endpoints. Requests to these are passed straight through, uncached.
const LIVE = [
  'api.nal.usda.gov',
  'api.anthropic.com',
  'script.google.com',
  'script.googleusercontent.com'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // allSettled: a missing foods.json must not stop the app shell caching.
    await Promise.allSettled([
      cache.add(new Request('./', { cache: 'reload' })),
      cache.add(new Request('./foods.json', { cache: 'reload' }))
    ]);
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== SHELL && k !== FONTS).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  let url;
  try { url = new URL(req.url); } catch (e) { return; }
  if (LIVE.some(h => url.hostname === h || url.hostname.endsWith('.' + h))) return;

  if (url.pathname.endsWith('foods.json')) {
    event.respondWith(pack(url));
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(page(req));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (sameOrigin || isFont) {
    event.respondWith(revalidate(req, sameOrigin ? SHELL : FONTS));
  }
});

/* The page itself: network first so a deploy lands immediately, cache as the
   fallback when there's nothing to reach. */
async function page(req) {
  const cache = await caches.open(SHELL);
  try {
    const net = await fetch(req);
    if (net && net.ok) cache.put('./', net.clone());
    return net;
  } catch (e) {
    return (await cache.match(req)) || (await cache.match('./')) ||
      new Response('Daybook is offline and has nothing cached yet.',
        { status: 503, headers: { 'Content-Type': 'text/plain' } });
  }
}

/* The food pack is ~1 MB and changes maybe twice a year, so it is cache-first
   with no background revalidation — refetching it on every load would be a
   waste of mobile data. Settings asks for ?refresh=1 to force an update. */
async function pack(url) {
  const cache = await caches.open(SHELL);
  const key = new Request(url.origin + url.pathname);
  const forced = url.searchParams.has('refresh');

  if (!forced) {
    const hit = await cache.match(key);
    if (hit) return hit;
  }
  try {
    const net = await fetch(key, { cache: 'no-cache' });
    if (net && net.ok) await cache.put(key, net.clone());
    return net;
  } catch (e) {
    return (await cache.match(key)) ||
      new Response('{"missing":true}', { headers: { 'Content-Type': 'application/json' } });
  }
}

/* Everything else same-origin, plus the two Google Fonts hosts: serve what we
   have straight away and quietly freshen it for next time. */
async function revalidate(req, bucket) {
  const cache = await caches.open(bucket);
  const hit = await cache.match(req);
  const net = fetch(req).then(r => {
    if (r && (r.ok || r.type === 'opaque')) cache.put(req, r.clone());
    return r;
  }).catch(() => null);
  return hit || (await net) || new Response('', { status: 504 });
}
