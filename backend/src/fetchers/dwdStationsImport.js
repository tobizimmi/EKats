// Wartungsjob: befuellt/aktualisiert die dwd_station-Lookup-Tabelle (Koordinaten + Bundesland je
// DWD-Stations-ID), die dwdWaldbrand.js fuer lat/lon/Bundesland der Waldbrandindex-Stationen braucht.
// Portiert aus FKatInfo (cron/import_dwd_stations.php), dort live geprueft am 2026-08-17.
//
// Quelle (ISO-8859-1-kodiert, feste Spalten mit wechselnder Breite):
// https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl/recent/KL_Tageswerte_Beschreibung_Stationen.txt
// Format je Zeile: Stations_id von_datum bis_datum Stationshoehe geoBreite geoLaenge Stationsname Bundesland Abgabe
// Da der Stationsname Leerzeichen/Klammern enthalten kann, wird NICHT stur auf Whitespace gesplittet:
// 1. die ersten 6 Felder (id/von/bis/hoehe/breite/laenge) per Regex extrahiert (immer numerisch),
// 2. im Rest-String nach einem der 16 bekannten Bundesland-Namen gesucht - alles davor ist der Name.

const { fetchBuffer } = require('./httpClient');
const { pool, query } = require('../db');

const STATIONS_URL =
  'https://opendata.dwd.de/climate_environment/CDC/observations_germany/climate/daily/kl/recent/KL_Tageswerte_Beschreibung_Stationen.txt';

const BUNDESLAND_NAME_TO_CODE = [
  ['Schleswig-Holstein', 'SH'],
  ['Hamburg', 'HH'],
  ['Niedersachsen', 'NI'],
  ['Bremen', 'HB'],
  ['Nordrhein-Westfalen', 'NW'],
  ['Hessen', 'HE'],
  ['Rheinland-Pfalz', 'RP'],
  ['Baden-Württemberg', 'BW'],
  ['Bayern', 'BY'],
  ['Saarland', 'SL'],
  ['Berlin', 'BE'],
  ['Brandenburg', 'BB'],
  ['Mecklenburg-Vorpommern', 'MV'],
  // Sachsen-Anhalt muss vor Sachsen geprueft werden, sonst Fehltreffer.
  ['Sachsen-Anhalt', 'ST'],
  ['Sachsen', 'SN'],
  ['Thüringen', 'TH'],
];

const LINE_REGEX = /^(\d+)\s+(\d{8})\s+(\d{8})\s+(-?\d+)\s+([\d.-]+)\s+([\d.-]+)\s+(.*)$/u;

function parseStationLine(line) {
  const trimmed = line.trim();
  if (trimmed === '' || !/^\d/.test(trimmed)) return null;

  const match = trimmed.match(LINE_REGEX);
  if (!match) return null;

  const [, stationId, , , , lat, lon, restRaw] = match;
  const rest = restRaw.trim();

  let bundeslandCode = null;
  let stationName = rest;
  for (const [name, code] of BUNDESLAND_NAME_TO_CODE) {
    const pos = rest.lastIndexOf(name);
    if (pos !== -1) {
      stationName = rest.slice(0, pos).trim();
      bundeslandCode = code;
      break;
    }
  }

  if (stationName === '' || Number.isNaN(Number(lat)) || Number.isNaN(Number(lon))) return null;

  return {
    stationId: stationId.padStart(5, '0'),
    stationName,
    lat: Number(lat),
    lon: Number(lon),
    bundeslandCode,
  };
}

async function importDwdStations() {
  const raw = await fetchBuffer(STATIONS_URL);
  const content = raw.toString('latin1');
  const lines = content.split(/\r\n|\n|\r/);
  if (lines.length < 2) {
    throw new Error('DWD-Stationsbeschreibungsdatei ist leer oder konnte nicht in Zeilen zerlegt werden.');
  }

  let imported = 0;
  let skipped = 0;

  for (const line of lines) {
    const station = parseStationLine(line);
    if (!station) {
      skipped += 1;
      continue;
    }
    await query(
      `INSERT INTO dwd_station (station_id, station_name, lat, lon, bundesland_code, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (station_id) DO UPDATE SET
         station_name = EXCLUDED.station_name,
         lat = EXCLUDED.lat,
         lon = EXCLUDED.lon,
         bundesland_code = EXCLUDED.bundesland_code,
         updated_at = now()`,
      [station.stationId, station.stationName, station.lat, station.lon, station.bundeslandCode]
    );
    imported += 1;
  }

  if (imported === 0) {
    throw new Error('Keine einzige Stationszeile konnte geparst werden - Dateiformat evtl. geaendert.');
  }

  return { imported, skipped };
}

if (require.main === module) {
  importDwdStations()
    .then(({ imported, skipped }) => {
      console.log(`dwd_station: ${imported} Stationen importiert/aktualisiert, ${skipped} Zeilen uebersprungen.`);
      return pool.end();
    })
    .catch((err) => {
      console.error('FEHLER beim Import der DWD-Stationen:', err);
      process.exitCode = 1;
      return pool.end();
    });
}

module.exports = { importDwdStations };
