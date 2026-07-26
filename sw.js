/* WarrantDesk service worker — cache-first shell, network-only data.
   Bump CACHE_VERSION on every release so users get updates immediately. */
const CACHE_VERSION = 'warrantdesk-v6';
const SHELL = ['./', './index.html', './manifest.json', './icon.svg'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  // Never cache API/data calls — the app has its own cache + freshness logic
  if (url.origin !== location.origin) return;
  // Shell: cache-first, refresh in background (stale-while-revalidate)
  e.respondWith(
    caches.match(e.request).then(cached => {
      const fresh = fetch(e.request).then(r => {
        if (r.ok) caches.open(CACHE_VERSION).then(c => c.put(e.request, r.clone()));
        return r;
      }).catch(() => cached);
      return cached || fresh;
    })
  );
});
