// warnung.bund.de (BBK) - Bundesweiter Warnaggregator hinter der NINA-App. Buendelt sechs
// Warnsysteme in einer einzigen, kostenlosen, unauthentifizierten API: MoWaS (amtliche
// Bevoelkerungswarnungen - Chemieunfaelle, Evakuierungen, Grossschadenslagen), DWD, das
// Laenderuebergreifende Hochwasserportal, BIWAPP, KATWARN und Polizeimeldungen.
//
// WICHTIG: KATWARN-Meldungen sind darueber erreichbar, obwohl KATWARN selbst keine nutzbare
// oeffentliche API hat (siehe README "Datenquellen") - dieser Aggregator loest diese
// Einschraenkung indirekt, ohne dass EKats selbst mit KATWARN spricht.
//
// Dokumentiert im inoffiziellen, aber vom bundesAPI-Projekt gepflegten OpenAPI-Spec
// https://github.com/bundesAPI/nina-api (openapi.yaml, verifiziert erreichbar ueber
// raw.githubusercontent.com). NICHT LIVE GEGEN warnung.bund.de GETESTET (aus dieser
// Entwicklungsumgebung nicht erreichbar) - vor Produktivbetrieb `npm run fetch -- bbk_warnung`
// pruefen (siehe README "Verifikationsstand der Fetcher").
//
// Endpunkt: GET /api31/dashboard/{ARS}.json - liefert alle aktiven Warnungen fuer eine Region.
// Die Region wird ueber den amtlichen Regionalschluessel (ARS, 12-stellig) adressiert; EKats kennt
// nur den 5-stelligen Kreis-Teil (AGS, siehe landkreis-Tabelle) - mit sieben Nullen aufgefuellt
// ("<ags>0000000") adressiert das laut der in der Recherche gefundenen URL-Konvention den gesamten
// Kreis (alle Gemeinden). Es wird PRO KREIS im Zustaendigkeitsgebiet jeder Wehr mit konfiguriertem
// Heimat-Landkreis abgefragt (dedupliziert ueber alle Wehren) - dadurch ist jede geschriebene Zeile
// bereits beim Abruf auf einen bekannten Kreis eingegrenzt (siehe payload.landkreisAgs, von
// utils/gebietFilter.js fuer die exakte Kreis-Filterung genutzt - praeziser als die
// Bundesland-Naeherung bei dwd_unwetter, da hier echte Kreis-Zuordnung statt nur Bundesland vorliegt).
// Betrifft eine Warnung mehrere Kreise im Gebiet, wird sie dem zuerst verarbeiteten Kreis zugeordnet
// (ueber (source, external_id) sowieso nur eine Zeile) - eine Mehrfach-Kreis-Zuordnung je Warnung
// waere ein Datenmodell-Umbau, der fuer den Nutzen hier nicht gerechtfertigt ist.
//
// Detailinformationen (Beschreibung/Verhaltenshinweise) stehen laut Spec unter einem zweiten
// Endpunkt GET /api31/warnings/{id}.json - wird best-effort nachgeladen; das genaue Antwortformat
// dieses zweiten Endpunkts ist NICHT im Detail verifiziert (anders als das Dashboard-Listing-Schema),
// deshalb mehrere plausible Formvarianten probiert. Schlaegt das fehl, bleibt die Meldung trotzdem
// mit Titel/Dringlichkeit/Quelle/Kreis nutzbar - kein Abbruch des gesamten Laufs.

const { fetchJson } = require('./httpClient');
const { upsertDatapoints } = require('./normalize');
const { query } = require('../db');
const { loadZustaendigkeitsgebiet } = require('../utils/zustaendigkeit');

const DASHBOARD_URL = (ags) => `https://warnung.bund.de/api31/dashboard/${ags}0000000.json`;
const DETAIL_URL = (id) => `https://warnung.bund.de/api31/warnings/${encodeURIComponent(id)}.json`;

// Offizielle CAP-Severity-Werte (OASIS Common Alerting Protocol, Standard hinter MoWaS/NINA) auf
// dieselbe 1-4-Aufloesung wie die DWD-Unwetterwarnstufen gemappt, damit severityScore() im
// Frontend (severity.js) beide Quellen gleich behandeln kann.
const CAP_SEVERITY_TO_LEVEL = { Minor: 1, Moderate: 2, Severe: 3, Extreme: 4 };
const LEVEL_TO_SEVERITY = { 1: 'gering', 2: 'mittel', 3: 'hoch', 4: 'extrem' };

async function loadRelevantAgsList() {
  const { rows: wehren } = await query('SELECT id FROM wehr WHERE home_landkreis_ags IS NOT NULL');
  const agsSet = new Set();
  for (const wehr of wehren) {
    const gebiet = await loadZustaendigkeitsgebiet(wehr.id);
    if (gebiet) gebiet.agsList.forEach((ags) => agsSet.add(ags));
  }
  return [...agsSet];
}

async function loadDetail(id) {
  try {
    const detail = await fetchJson(DETAIL_URL(id));
    const info = (Array.isArray(detail?.info) && detail.info[0]) || detail?.payload?.data || detail || {};
    return {
      description: info.description ?? null,
      instruction: info.instruction ?? null,
    };
  } catch (err) {
    return { description: null, instruction: null };
  }
}

async function fetchBbkWarnungen() {
  const agsList = await loadRelevantAgsList();
  if (agsList.length === 0) {
    return { source: 'bbk_warnung', fetched: 0, written: 0, skipped: 'keine Wehr mit Heimat-Landkreis konfiguriert' };
  }

  const items = [];
  const seenIds = new Set();

  for (const ags of agsList) {
    let entries;
    try {
      entries = await fetchJson(DASHBOARD_URL(ags));
    } catch (err) {
      console.warn(`[bbk_warnung] Kreis ${ags} uebersprungen (Abruf fehlgeschlagen):`, err.message);
      continue;
    }
    if (!Array.isArray(entries)) continue;

    for (const entry of entries) {
      const data = entry?.payload?.data;
      const id = entry?.id;
      if (!id || !data || seenIds.has(id)) continue;
      if (data.msgType === 'Cancel') continue; // aufgehobene Warnung, nicht mehr anzeigen
      seenIds.add(id);

      const level = CAP_SEVERITY_TO_LEVEL[data.severity] ?? null;
      const { description, instruction } = await loadDetail(id);

      items.push({
        source: 'bbk_warnung',
        external_id: id,
        title: entry.i18nTitle?.de || data.headline || 'Warnmeldung',
        lat: null,
        lon: null,
        value_numeric: level,
        unit: 'Warnstufe',
        severity: level !== null ? LEVEL_TO_SEVERITY[level] : null,
        item_timestamp: entry.sent ? new Date(entry.sent).toISOString() : null,
        valid_until: null,
        payload: {
          landkreisAgs: ags,
          provider: data.provider ?? null,
          event: data.transKeys?.event ?? null,
          description,
          instruction,
        },
      });
    }
  }

  const rows = await upsertDatapoints(items);
  return { source: 'bbk_warnung', fetched: items.length, written: rows.length, rows };
}

module.exports = { fetchBbkWarnungen };
