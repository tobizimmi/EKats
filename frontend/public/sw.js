// Service Worker fuer Modul 1: cached die App-Shell fuer den Offline-Hinweis (siehe js/offline.js
// fuer den eigentlichen Datenstand in IndexedDB) und zeigt Web-Push-Benachrichtigungen an. Kein
// voller Offline-Betrieb (das ist Modul 2) - API-Aufrufe gehen immer ans Netz, Kartenkacheln werden
// nicht vorab zwischengespeichert.

// Bewusst RELATIV zum Service-Worker-Skript (kein fuehrender "/"): die Cache API und
// self.registration.scope loesen relative URLs relativ zu self.location auf. So funktioniert
// dieselbe sw.js unveraendert egal ob die App an der Domain-Root oder einem Unterpfad
// (z.B. https://zimmimail.de/EKats/) haengt - siehe README "Deployment".
const CACHE_NAME = 'ekats-shell-v2';
const APP_SHELL = [
  './',
  'login.html',
  'settings.html',
  'admin.html',
  'datenschutz.html',
  'impressum.html',
  'css/style.css',
  'js/api.js',
  'js/severity.js',
  'js/header.js',
  'js/offline.js',
  'js/map.js',
  'js/list.js',
  'js/app.js',
  'js/auth.js',
  'js/settings.js',
  'js/admin.js',
  'js/push.js',
  'js/sw-register.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'manifest.webmanifest',
  'icons/icon.svg',
];
const SCOPE_PATH = new URL(self.registration ? self.registration.scope : './', self.location).pathname;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // API-Aufrufe: immer ans Netz, nie aus dem Cache beantworten (Live-Daten).
  if (url.pathname.startsWith(`${SCOPE_PATH}api/`)) {
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      const networkFetch = fetch(event.request)
        .then((response) => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => cached);
      return cached || networkFetch;
    })
  );
});

self.addEventListener('push', (event) => {
  if (!event.data) return;
  let payload;
  try {
    payload = event.data.json();
  } catch (err) {
    payload = { title: 'EKats', body: event.data.text() };
  }

  event.waitUntil(
    self.registration.showNotification(payload.title || 'EKats-Alarm', {
      body: payload.body || '',
      icon: 'icons/icon.svg',
      badge: 'icons/icon.svg',
      data: payload,
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow(self.registration.scope));
});
