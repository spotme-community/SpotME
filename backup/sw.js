const CACHE_NAME = 'spotme-caching-v1';
const ASSETS = [
  '/',
  '/index.html',
  '/profil-caching.html',
  '/manifest.json'
];

// Installation: Assets cachen
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

// Aktivierung: alte Caches löschen
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
    ).then(() => self.clients.claim())
  );
});

// Fetch: Cache-First für statische Dateien, Network-First für API
self.addEventListener('fetch', event => {
  const { request } = event;
  
  // API-Aufrufe: Network First
  if (request.url.includes('/api/')) {
    event.respondWith(
      fetch(request)
        .then(response => {
          const clone = response.clone();
          caches.open('api-cache').then(cache => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
    return;
  }

  // Statische Assets: Cache First
  event.respondWith(
    caches.match(request)
      .then(cached => cached || fetch(request))
  );
});