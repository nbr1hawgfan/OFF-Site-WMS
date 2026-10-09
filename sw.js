// Service worker: caches the app shell so it opens fast and installs as an app.
// App files are network-first (updates show up right away); data calls to
// Supabase are never cached.
const CACHE = 'lwh-wms-v0.6.0';
const SHELL = [
  './', 'index.html', 'css/app.css', 'js/config.js', 'js/print.js', 'js/app.js',
  'manifest.json', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Only these hosts serve versioned library files that are safe to cache.
const CDN_HOSTS = ['cdn.jsdelivr.net'];

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;

  if (url.origin === location.origin) {
    // network-first for our own files
    e.respondWith(
      fetch(e.request)
        .then(res => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then(c => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => caches.match(e.request).then(r => r || caches.match('index.html')))
    );
    return;
  }

  if (CDN_HOSTS.includes(url.hostname)) {
    // CDN libraries: cache-first (URLs are pinned to versions)
    e.respondWith(
      caches.match(e.request).then(r => r || fetch(e.request).then(res => {
        if (res.ok || res.type === 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, copy));
        }
        return res;
      }))
    );
  }
  // everything else (Supabase API, auth, storage) goes straight to the network
});
