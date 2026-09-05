// Hochwasserzentralen-API (Laenderuebergreifendes Hochwasserportal, LHP). Kein API-Key noetig laut
// Anbieter-Doku (hochwasserzentralen.de/webservices).
//
// WICHTIGER HINWEIS ZUM VERIFIKATIONSSTAND (anders als die uebrigen vier Fetcher):
// Diese Sandbox-Umgebung hat aus Netzwerkrichtlinien-Gruenden KEINEN ausgehenden Zugriff auf
// hochwasserzentralen.de (im Gegensatz zu PEGELONLINE/DWD/NASA, die gegen den bereits produktiven
// FKatInfo-Connector abgeglichen werden konnten - siehe deren Dateien fuer den Unterschied in
// Vertrauenswuerdigkeit). Endpunkt-URL und Feldnamen unten sind nach bestem Wissen aus der
// oeffentlichen Dokumentation rekonstruiert, aber NICHT live gegen eine echte Antwort verifiziert.
// Vor Produktivbetrieb unbedingt pruefen:
//   curl -s https://www.hochwasserzentralen.de/webservices/laender.json | head -c 2000
// und PEGEL_URL/PEGEL_FIELD_CANDIDATES unten an die tatsaechliche Struktur anpassen. Bis dahin
// scheitert dieser Fetcher defensiv (loggt eine Warnung, wirft aber keinen Fehler, der die anderen
// Scheduler-Jobs mitreisst - siehe scheduler.js).

const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');

const PEGEL_URL = 'https://www.hochwasserzentralen.de/webservices/pegel_alle.json';

// Mehrere bekannte Namens-Varianten pro Feld, da die exakte Antwortstruktur ungeprueft ist.
function pick(obj, candidates) {
  for (const key of candidates) {
    if (obj[key] !== undefined && obj[key] !== null && obj[key] !== '') return obj[key];
  }
  return null;
}

function toNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}

function meldestufeToSeverity(stufe) {
  const n = toNumber(stufe);
  if (n === null) return null;
  if (n <= 0) return 'kein_hochwasser';
  if (n === 1) return 'meldestufe_1';
  if (n === 2) return 'meldestufe_2';
  if (n === 3) return 'meldestufe_3';
  return 'meldestufe_4_plus';
}

async function fetchHochwasserzentralen() {
  let raw;
  try {
    raw = await fetchJson(PEGEL_URL);
  } catch (err) {
    console.warn(
      '[hochwasserzentralen] Abruf fehlgeschlagen - Endpunkt/Feldnamen sind unverifiziert, siehe ' +
        'Kommentar am Dateianfang. Original-Fehler:',
      err.message
    );
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'Abruf fehlgeschlagen (unverifizierter Endpunkt)' };
  }

  const list = Array.isArray(raw) ? raw : Array.isArray(raw?.pegel) ? raw.pegel : Array.isArray(raw?.data) ? raw.data : null;
  if (!list) {
    console.warn('[hochwasserzentralen] Unerwartetes Antwortformat - ueberspringe diesen Lauf.');
    return { source: 'hochwasserzentralen', fetched: 0, written: 0, skipped: 'unerwartetes Antwortformat' };
  }

  const items = [];
  for (const entry of list) {
    const lat = toNumber(pick(entry, ['lat', 'latitude', 'breite', 'geoBreite']));
    const lon = toNumber(pick(entry, ['lon', 'lng', 'longitude', 'laenge', 'geoLaenge']));
    const id = pick(entry, ['id', 'pegel_id', 'pegelId', 'ags', 'nummer']);
    const name = pick(entry, ['name', 'ort', 'pegelname', 'station']);
    const gewaesser = pick(entry, ['gewaesser', 'fluss', 'gewaesser_name']);
    const land = pick(entry, ['land', 'bundesland']);
    const stufe = pick(entry, ['stufe', 'meldestufe', 'warnstufe']);
    const wert = toNumber(pick(entry, ['wert', 'value', 'aktuellerWert', 'wasserstand']));
    const einheit = pick(entry, ['einheit', 'unit']) || 'cm';
    const zeitstempel = pick(entry, ['zeitstempel', 'datum', 'timestamp', 'zeit']);

    if (id === null || (lat === null && lon === null)) continue;

    let timestamp = null;
    if (zeitstempel) {
      const t = new Date(zeitstempel);
      if (!Number.isNaN(t.getTime())) timestamp = t.toISOString();
    }

    items.push({
      source: 'hochwasserzentralen',
      external_id: String(id),
      title: [name, gewaesser].filter(Boolean).join(' / ') || 'Hochwassermeldestelle',
      lat,
      lon,
      value_numeric: wert,
      unit: einheit,
      severity: meldestufeToSeverity(stufe),
      item_timestamp: timestamp,
      valid_until: null,
      payload: { gewaesser, land, meldestufeRoh: stufe },
    });
  }

  const rows = await upsertDatapoints(items);
  return { source: 'hochwasserzentralen', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchHochwasserzentralen };
