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
const VERSION = '2026-10-08a';
const PREFIX  = 'daybook-';
const SHELL   = PREFIX + 'shell-' + VERSION;
const FONTS   = PREFIX + 'fonts-' + VERSION;

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
    // caches.keys() is origin-wide, not scope-wide. On a shared origin like
    // username.github.io every project sits in the same cache storage, so this
    // has to stay inside our own prefix or it wipes the neighbours.
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.startsWith(PREFIX) && k !== SHELL && k !== FONTS)
      .map(k => caches.delete(k)));
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
    // waitUntil keeps the worker alive for the background refresh after the
    // cached page has already been handed back.
    event.respondWith(page(req, event));
    return;
  }

  const sameOrigin = url.origin === self.location.origin;
  const isFont = url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com';
  if (sameOrigin || isFont) {
    event.respondWith(revalidate(req, sameOrigin ? SHELL : FONTS));
  }
});

/* The page itself: cache first, so the app opens instantly however slow the
   connection is -- the log lives on the phone, and sync catches up on its own
   once there's a network to catch up with. The network copy is fetched in the
   background every time; when it differs from what was served, it replaces the
   cached one and the open page is told, so it can offer a reload. With nothing
   cached yet (the very first open) the network is all there is. */
function isShell(url) {
  const scope = new URL(self.registration.scope);
  if (url.origin !== scope.origin) return false;
  const p = url.pathname;
  return p === scope.pathname || p === scope.pathname + 'index.html';
}
async function page(req, event) {
  const cache = await caches.open(SHELL);
  const url = new URL(req.url);
  if (!isShell(url)) {
    // Some other page on the site, opened directly: not ours to cache.
    try { return await fetch(req); }
    catch (e) { return (await cache.match(req)) || offline(); }
  }
  const hit = await cache.match('./');
  // A copy to compare against: the original is about to be handed to the page.
  const fresh = refreshShell(cache, hit && hit.clone(), event && (event.resultingClientId || event.clientId));
  if (event) event.waitUntil(fresh);
  if (hit) return hit;
  return (await fresh) || offline();
}
/* Resolves to the network copy, or null. The old copy is read before anything
   is overwritten, so the comparison is against what this page is running. */
async function refreshShell(cache, hit, clientId) {
  try {
    const net = await fetch('./', { cache: 'no-cache' });
    if (!net || !net.ok) return null;
    if (hit) {
      const [a, b] = await Promise.all([hit.text(), net.clone().text()]);
      if (a === b) return net;
      await cache.put('./', net.clone());
      await tell(clientId);
      return net;
    }
    await cache.put('./', net.clone());
    return net;
  } catch (e) {
    return null;
  }
}
/* The page being opened doesn't exist as a client until its document starts
   running, and on a fast connection the check can finish before that. So wait
   for that particular page to appear, then tell it -- and any other open copy,
   which is running the old version too. */
async function tell(clientId) {
  const msg = { type: 'daybook-update' };
  for (let i = 0; clientId && i < 40; i++) {
    const c = await self.clients.get(clientId);
    if (c) break;
    await new Promise(r => setTimeout(r, 250));
  }
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  all.forEach(c => c.postMessage(msg));
}
function offline() {
  return new Response('Daybook is offline and has nothing cached yet.',
    { status: 503, headers: { 'Content-Type': 'text/plain' } });
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
