const CACHE_NAME = 'zscore-lite-v4';
const CORE_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './css/styles.css',
  './js/app.js',
  './js/scoring-engine.js',
  './js/db.js',
  './js/tts.js',
  './js/remote-button.js',
  './js/wakelock.js',
  './js/match-controller.js',
  './js/match-stats-view.js',
  './js/ui-setup.js',
  './js/ui-scoreboard.js',
  './js/ui-history.js',
  './js/records.js',
  './js/fx.js',
  './js/share-image.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(CORE_ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Íconos: no cambian nunca, cache-first (más rápido, no hace falta red).
// Todo lo demás (HTML/CSS/JS/manifest): red primero, para que las
// actualizaciones se vean apenas hay conexión. Si no hay red (cancha sin
// señal), cae a la copia guardada y la app sigue funcionando igual.
self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET') return;
  const isIcon = new URL(event.request.url).pathname.includes('/icons/');

  if (isIcon) {
    event.respondWith(
      caches.match(event.request).then((cached) => cached || fetch(event.request))
    );
    return;
  }

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
