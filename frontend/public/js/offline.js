// Offline-Fallback fuer Modul 1 (siehe CLAUDE.md 2.2): Service Worker cached die App-Shell (sw.js),
// hier wird zusaetzlich der letzte Datenstand in IndexedDB gespeichert und bei Verbindungsverlust ein
// deutlich sichtbarer Hinweis mit Zeitstempel eingeblendet. Kein voller Offline-Betrieb (das ist erst
// Modul 2 mit echtem Sync) - nur "letzten bekannten Stand anzeigen, statt leerer Seite".

const DB_NAME = 'ekats-offline';
const STORE_NAME = 'snapshots';

function openOfflineDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveOfflineSnapshot(datapoints) {
  try {
    const db = await openOfflineDb();
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ data: datapoints, savedAt: new Date().toISOString() }, 'latest');
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  } catch (err) {
    console.warn('[offline] Snapshot konnte nicht gespeichert werden:', err);
  }
}

async function loadOfflineSnapshot() {
  try {
    const db = await openOfflineDb();
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get('latest');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch (err) {
    console.warn('[offline] Snapshot konnte nicht gelesen werden:', err);
    return null;
  }
}

function updateOfflineBanner(snapshotSavedAt) {
  const banner = document.getElementById('offline-banner');
  if (!banner) return;
  if (navigator.onLine) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  banner.textContent = snapshotSavedAt
    ? `Keine Verbindung – zeige letzten bekannten Stand vom ${new Date(snapshotSavedAt).toLocaleString('de-DE')}`
    : 'Keine Verbindung – noch kein gespeicherter Datenstand vorhanden.';
}

window.addEventListener('online', () => updateOfflineBanner());
window.addEventListener('offline', () => updateOfflineBanner());
