// Service Worker fuer Modul 1: cached die App-Shell fuer den Offline-Hinweis (siehe js/offline.js
// fuer den eigentlichen Datenstand in IndexedDB) und zeigt Web-Push-Benachrichtigungen an. Kein
// voller Offline-Betrieb (das ist Modul 2) - API-Aufrufe gehen immer ans Netz, Kartenkacheln werden
// nicht vorab zwischengespeichert.

// Bewusst RELATIV zum Service-Worker-Skript (kein fuehrender "/"): die Cache API und
// self.registration.scope loesen relative URLs relativ zu self.location auf. So funktioniert
// dieselbe sw.js unveraendert egal ob die App an der Domain-Root oder einem Unterpfad
// (z.B. https://zimmimail.de/EKats/) haengt - siehe README "Deployment".
const CACHE_NAME = 'ekats-shell-v32';
const APP_SHELL = [
  './',
  'login.html',
  'forgot-password.html',
  'reset-password.html',
  'settings.html',
  'admin.html',
  'dashboard.html',
  'datenschutz.html',
  'impressum.html',
  'dwd-unwetter.html',
  'pegelonline.html',
  'hochwasserzentralen.html',
  'waldbrandindex.html',
  'firms.html',
  'bbk-warnungen.html',
  'kachelmann.html',
  'wetter-vorhersage.html',
  'blitzortung.html',
  'objekte.html',
  'objekt-detail.html',
  'einsatztagebuch.html',
  'css/style.css',
  'js/api.js',
  'js/severity.js',
  'js/header.js',
  'js/offline.js',
  'js/map.js',
  'js/bundesland.js',
  'js/gebiet-info.js',
  'js/list.js',
  'js/detail.js',
  'js/pegel-chart.js',
  'js/data-table.js',
  'js/weather-overview.js',
  'js/objects.js',
  'js/objekte-page.js',
  'js/objekt-detail-page.js',
  'js/object-sketch.js',
  'js/einsatztagebuch.js',
  'js/priority-bar.js',
  'js/dashboard.js',
  'js/addon.js',
  'js/wetter-vorhersage.js',
  'js/app.js',
  'js/auth.js',
  'js/forgot-password.js',
  'js/reset-password.js',
  'js/settings.js',
  'js/admin.js',
  'js/push.js',
  'js/sw-register.js',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet-geoman/leaflet-geoman.min.js',
  'vendor/leaflet-geoman/leaflet-geoman.css',
  'vendor/gridstack/gridstack-all.js',
  'vendor/gridstack/gridstack.css',
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

  // Fremdorigin-Requests (Kartenkacheln von tile.openstreetmap.org) NICHT abfangen: ein fetch()
  // AUS dem Service Worker heraus unterliegt der connect-src-Direktive der CSP (nicht img-src, das
  // gilt nur fuer den regulaeren <img>-Ladepfad) - tile.openstreetmap.org steht bewusst nicht in
  // connect-src, wurde also von jedem fetch() hier drin geblockt und die Karte blieb grau. Durch
  // "return" ohne respondWith() laedt der Browser die Kachel ganz normal selbst (regulaerer
  // img-src-Pfad) - das entspricht ohnehin der dokumentierten Absicht, Kartenkacheln nicht
  // vorab zwischenzuspeichern.
  if (url.origin !== self.location.origin) {
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
