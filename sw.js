const CACHE_NAME = 'qdrop-v1';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './js/main.js',
  './js/peer-manager.js',
  './js/file-transfer.js',
  './js/ui-manager.js',
  './js/keepalive-worker.js',
  './assets/icons/icon.svg',
  './manifest.json',
  'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js',
  'https://cdn.jsdelivr.net/npm/qrious@4.0.2/dist/qrious.min.js',
  'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.js',
  'https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;800&display=swap',
  'https://fonts.gstatic.com/s/outfit/v11/QId1QZrSuo4A6741LD87r1s.woff2'
];

// Instalar Service Worker y guardar en caché los recursos estáticos
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activar Service Worker y limpiar cachés antiguas
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Interceptar peticiones y servir desde caché si está disponible
self.addEventListener('fetch', (event) => {
  // Evitar interceptar conexiones websocket o de señalización externas
  if (event.request.url.includes('peerjs') || event.request.url.startsWith('ws') || event.request.url.startsWith('http') === false) {
    return;
  }
  
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse;
      }
      
      return fetch(event.request).then((networkResponse) => {
        // Guardar nuevas peticiones en caché (si son válidas)
        if (networkResponse.status === 200 && event.request.method === 'GET') {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Fallback offline (podríamos retornar una página de error, pero al ser SPA el index.html ya está cacheado)
        return caches.match('./index.html');
      });
    })
  );
});
