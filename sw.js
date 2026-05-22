// ═══════════════════════════════════════════════════════════════
// SpotMe Caching · Service Worker
//
// Versionierung: CACHE_VERSION bei jedem Deploy hochzählen.
// Der Browser erkennt den neuen SW, löscht den alten Cache
// und installiert die neuen Dateien automatisch.
// ══════════════════════════════════════════════════════════════
const CACHE_VERSION = 'v15.0';
const CACHE_STATIC  = `spotme-caching-${CACHE_VERSION}`;
const CACHE_API     = `spotme-api-${CACHE_VERSION}`;

// Alle Dateien die offline verfügbar sein müssen.
// Schlägt eine Datei fehl, wird sie übersprungen (kein Totalausfall).
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/profil-caching.html',
  '/landing.html',
  '/404.html',
  '/manifest.json',
  'icons/splash-1125x2436.png'
];

// API-Antworten maximal so lange im Cache behalten (in Sekunden).
// Verhindert unbegrenztes Cache-Wachstum.
const API_CACHE_MAX_AGE = 60; // 1 Minute

// ── INSTALLATION ─────────────────────────────────────────────────
// Wird ausgeführt wenn der Browser den SW zum ersten Mal
// (oder nach einer Versionsänderung) registriert.
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => {
      // Promise.allSettled statt addAll: einzelne Fehler
      // brechen die Installation nicht ab.
      return Promise.allSettled(
        STATIC_ASSETS.map(url =>
          cache.add(url).catch(err =>
            console.warn(`[SW] Konnte nicht cachen: ${url}`, err)
          )
        )
      );
    })
    // SW übernimmt sofort ohne auf Tab-Reload zu warten.
    .then(() => self.skipWaiting())
  );
});

// ── AKTIVIERUNG ──────────────────────────────────────────────────
// Wird ausgeführt nachdem der alte SW abgelöst wurde.
// Hier alle veralteten Caches löschen.
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(key => key !== CACHE_STATIC && key !== CACHE_API)
          .map(key => {
            console.log(`[SW] Alter Cache gelöscht: ${key}`);
            return caches.delete(key);
          })
      )
    )
    // SW kontrolliert sofort alle offenen Tabs.
    .then(() => self.clients.claim())
  );
});

// ── FETCH ────────────────────────────────────────────────────────
// Jeder Request läuft durch diesen Handler.
self.addEventListener('fetch', event => {
  const { request } = event;
  const url = new URL(request.url);

  // Nur GET-Requests cachen — POST/PUT/DELETE immer ans Netz.
  if (request.method !== 'GET') return;

  // Externe Domains (Fonts, CDN) direkt ans Netz — nicht cachen.
  if (url.origin !== self.location.origin &&
      !url.hostname.includes('fonts.googleapis') &&
      !url.hostname.includes('fonts.gstatic') &&
      !url.hostname.includes('unpkg.com') &&
      !url.hostname.includes('openfreemap.org')) {
    return;
  }

  // ── API-Calls: Network First mit kurzem Cache-Fallback ──────
  // Zuerst Netzwerk versuchen. Bei Erfolg Antwort kurz cachen
  // (max. API_CACHE_MAX_AGE Sekunden) damit sie offline verfügbar ist.
  // Bei Netzwerkfehler: gecachte Antwort liefern falls vorhanden.
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(request.clone())
        .then(response => {
          if (!response.ok) return response; // Fehler nicht cachen
          const clone = response.clone();
          caches.open(CACHE_API).then(cache => {
            // Eigene Header mit Ablaufzeit hinzufügen
            const headers = new Headers(clone.headers);
            headers.append('sw-cached-at', Date.now().toString());
            clone.blob().then(body =>
              cache.put(request, new Response(body, {
                status: clone.status,
                statusText: clone.statusText,
                headers
              }))
            );
          });
          return response;
        })
        .catch(async () => {
          // Offline: aus Cache bedienen wenn nicht zu alt
          const cached = await caches.match(request);
          if (!cached) return new Response(
            JSON.stringify({ error: 'Offline – keine gecachten Daten' }),
            { status: 503, headers: { 'Content-Type': 'application/json' } }
          );
          const cachedAt = parseInt(cached.headers.get('sw-cached-at') || '0');
          const ageSeconds = (Date.now() - cachedAt) / 1000;
          if (ageSeconds > API_CACHE_MAX_AGE) {
            return new Response(
              JSON.stringify({ error: 'Offline – Cache zu alt' }),
              { status: 503, headers: { 'Content-Type': 'application/json' } }
            );
          }
          return cached;
        })
    );
    return;
  }

  // ── Statische Dateien: Cache First mit Netz-Fallback ────────
  // Zuerst im Cache schauen. Nicht gefunden → Netz.
  // Netz auch nicht erreichbar → 404-Seite aus Cache.
  event.respondWith(
    caches.match(request).then(cached => {
      if (cached) return cached;
      return fetch(request)
        .then(response => {
          // Erfolgreiche Antworten in Cache schreiben
          if (response.ok) {
            caches.open(CACHE_STATIC).then(cache =>
              cache.put(request, response.clone())
            );
          }
          return response;
        })
        .catch(() =>
          // Komplett offline und nicht im Cache → 404-Seite
          caches.match('/404.html')
        );
    })
  );
});
