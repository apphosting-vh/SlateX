/* Slate service worker — offline-first app shell + runtime caching.
 * Bump CACHE_VERSION with every release so clients pick up new assets.
 */
const CACHE_VERSION = 'slate-v1.7.0';
const SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

// Resolve every app URL against the worker's own location so the same build
// works at the domain root, under a GitHub Pages project path (/repo/), or in
// any other subdirectory. The worker lives beside index.html.
const BASE_URL = new URL('./', self.location.href);
const appUrl = (path) => new URL(path, BASE_URL).href;

const APP_SHELL = [
  'index.html',
  'app-core.js',
  'manifest.json',
  'favicon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png'
].map(appUrl);

const INDEX_URL = appUrl('index.html');

// Cross-origin dependencies the app cannot boot without. Cached individually so a
// single CDN hiccup cannot fail the whole install.
const CDN_ASSETS = [
  'https://cdn.tailwindcss.com/3.4.16',
  'https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js',
  'https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js',
  'https://cdn.jsdelivr.net/npm/@babel/standalone@7.26.4/babel.min.js'
];

const CDN_ORIGINS = new Set([
  'https://cdn.jsdelivr.net',
  'https://cdn.tailwindcss.com'
]);

const NAV_TIMEOUT_MS = 4000;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    // Cache each shell asset independently: one missing icon must not abort the
    // whole install, which would leave the app without an offline shell.
    await Promise.all(APP_SHELL.map(async (assetUrl) => {
      try {
        const response = await fetch(new Request(assetUrl, { cache: 'reload' }));
        if (response.ok) {
          await shell.put(assetUrl, response.clone());
          // Updates only reach clients when this file's bytes change, so a
          // release that bumps APP_VERSION but forgets CACHE_VERSION would
          // never install. Say so loudly instead of failing silently.
          if (assetUrl.endsWith('app-core.js')) {
            const source = await response.text();
            const match = /APP_VERSION\s*=\s*'([^']+)'/.exec(source);
            const appVersion = match && match[1];
            // Compare the release number, ignoring any prerelease suffix.
            const cacheVersion = CACHE_VERSION.replace(/^slate-v/, '').split('-')[0];
            if (appVersion && appVersion !== cacheVersion) {
              console.warn(
                `[slate/sw] CACHE_VERSION (${CACHE_VERSION}) does not match app-core.js v${appVersion}. `
                + 'Bump CACHE_VERSION so installed apps can pick up this release.'
              );
            }
          }
        } else console.warn('[slate/sw] Shell asset responded', response.status, assetUrl);
      } catch (err) {
        console.warn('[slate/sw] Could not precache', assetUrl, err);
      }
    }));

    const runtime = await caches.open(RUNTIME_CACHE);
    await Promise.all(CDN_ASSETS.map(async (url) => {
      try {
        const response = await fetch(new Request(url, { mode: 'cors', cache: 'reload' }));
        if (response.ok || response.type === 'opaque') await runtime.put(url, response);
      } catch (err) {
        console.warn('[slate/sw] Could not precache', url, err);
      }
    }));
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => (key.startsWith('slate-') || key.startsWith('slate:')) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key))
    );
    if (self.registration.navigationPreload) {
      try { await self.registration.navigationPreload.disable(); } catch (err) { /* not supported */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
  if (data.type === 'CACHE_URLS' && Array.isArray(data.urls)) {
    event.waitUntil((async () => {
      const cache = await caches.open(RUNTIME_CACHE);
      await Promise.all(data.urls.map(async (url) => {
        try {
          const res = await fetch(url, { cache: 'no-cache' });
          if (res.ok) await cache.put(url, res);
        } catch (err) { /* best effort */ }
      }));
    })());
  }
});

function isCacheable(response) {
  return response && (response.ok || response.type === 'opaque');
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (isCacheable(response)) {
    cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const network = fetch(request)
    .then((response) => {
      if (isCacheable(response)) cache.put(request, response.clone()).catch(() => {});
      return response;
    })
    .catch(() => null);

  if (cached) return cached;
  const response = await network;
  if (response) return response;
  throw new Error('Offline and not cached');
}

async function networkFirstNavigation(request) {
  const cache = await caches.open(SHELL_CACHE);
  const fallback = (await cache.match(request, { ignoreSearch: true })) || (await cache.match(INDEX_URL));

  const network = fetch(request).then((response) => {
    // A proxy or captive portal can answer with a 5xx while the real app is
    // unreachable. Treat that as a failed navigation so the shell fallback wins.
    if (!response.ok) throw new Error(`Navigation failed with status ${response.status}`);
    cache.put(INDEX_URL, response.clone()).catch(() => {});
    return response;
  });

  try {
    return await Promise.race([
      network,
      new Promise((_, reject) => setTimeout(() => reject(new Error('Navigation timeout')), NAV_TIMEOUT_MS))
    ]);
  } catch (err) {
    if (fallback) return fallback;
    try { return await network; } catch (networkErr) {
      return new Response(
        '<!doctype html><meta charset="utf-8"><title>Offline</title><body style="font-family:system-ui;padding:40px;background:#0a0b0d;color:#eee"><h1 style="font-weight:600">Slate is offline</h1><p>Reconnect once so the app shell can finish installing.</p></body>',
        { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
      );
    }
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      staleWhileRevalidate(request, SHELL_CACHE).catch(() =>
        caches.match(request).then((hit) => hit || Response.error())
      )
    );
    return;
  }

  if (CDN_ORIGINS.has(url.origin)) {
    event.respondWith(
      staleWhileRevalidate(request, RUNTIME_CACHE).catch(() =>
        caches.match(request).then((hit) => hit || Response.error())
      )
    );
  }
});

// Deliberately no push notifications or background sync: this app never phones home.
