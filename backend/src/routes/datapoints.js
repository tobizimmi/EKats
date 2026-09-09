const express = require('express');
const { query } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { loadZustaendigkeitsgebiet } = require('../utils/zustaendigkeit');
const { buildGebietCondition } = require('../utils/gebietFilter');
const { hasFeatureAccess } = require('../utils/featureAccess');

const router = express.Router();

const VALID_SOURCES = [
  'dwd_unwetter',
  'pegelonline',
  'hochwasserzentralen',
  'firms',
  'waldbrandindex',
  'bbk_warnung',
  'kachelmann',
  'wetter_vorhersage',
  'blitzortung',
];

// GET /api/datapoints?source=pegelonline&since=2026-01-01T00:00:00Z
// Liefert den aktuellen Stand je Quelle fuer Karte + Uebersichtsliste, gefiltert auf das
// Zustaendigkeitsgebiet der Wehr (Heimat-Landkreis + Nachbarlandkreise, siehe
// utils/zustaendigkeit.js). Drei Filterarten je nach Praezision der Quelle, siehe
// utils/gebietFilter.js: Kreis-genau (bbk_warnung), Bundesland-genau (dwd_unwetter, einzige Quelle
// wirklich ohne Geokoordinate), sonst per Geokoordinate gegen die Kreis-Polygone. Ist noch kein
// Heimat-Landkreis konfiguriert, kann keine Gebietsgrenze bestimmt werden - dann bewusst wie
// bisher ungefiltert (bundesweit) anzeigen, statt versehentlich alles auszublenden.
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const { source, since } = req.query;
    if (source && !VALID_SOURCES.includes(source)) {
      return res.status(400).json({ ok: false, error: `Unbekannte Quelle "${source}".` });
    }

    const conditions = [];
    const params = [];

    // Ab Phase 5 ist jede Quelle einzeln je Rolle/Nutzer rechtbar (Migration 009, siehe
    // utils/featureAccess.js) - nicht mehr nur Kachelmann. Eine Quelle ohne konfigurierte Regel
    // bleibt offen fuer alle (Rueckwaertskompatibilitaet); Kachelmann ist die einzige Ausnahme, die
    // ohne Regel geschlossen bleibt (DEFAULT_CLOSED_FEATURES).
    if (source) {
      const allowed = await hasFeatureAccess(req.user.id, req.user.role, req.user.wehrId, source);
      if (!allowed) {
        return res.status(403).json({ ok: false, error: 'Kein Zugriff auf diese Datenquelle.' });
      }
      params.push(source);
      conditions.push(`source = $${params.length}`);
    } else {
      // Ungefilterte Abfrage speist die kombinierte Lage-Uebersicht (Karte, Lage-Liste, Prioritaets-
      // Leiste). wetter_vorhersage liefert dutzende stuendliche Werte je Wehr (Zeitreihe, kein
      // Einzelereignis wie die uebrigen Quellen) und wuerde diese Ansicht nur zumuellen - bleibt
      // unabhaengig von der Zugriffssteuerung ausgeschlossen, ausschliesslich ueber die eigene
      // Themenseite (?source=wetter_vorhersage) und spaeter Dashboard-Widgets (Phase 6) abrufbar.
      const excludedSources = ['wetter_vorhersage'];
      for (const candidate of VALID_SOURCES) {
        if (candidate === 'wetter_vorhersage') continue;
        const allowed = await hasFeatureAccess(req.user.id, req.user.role, req.user.wehrId, candidate);
        if (!allowed) excludedSources.push(candidate);
      }
      params.push(excludedSources);
      conditions.push(`source != ALL($${params.length}::text[])`);
    }
    if (since) {
      params.push(since);
      conditions.push(`fetched_at >= $${params.length}`);
    }
    // Nur nicht abgelaufene Warnungen bzw. Werte ohne Gueltigkeitsende anzeigen.
    conditions.push('(valid_until IS NULL OR valid_until >= now())');

    const gebiet = await loadZustaendigkeitsgebiet(req.user.wehrId);
    const gebietCondition = buildGebietCondition(gebiet, params);
    if (gebietCondition) {
      conditions.push(gebietCondition);
    }

    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    // LEFT JOIN LATERAL statt fixer Zuordnung: ermittelt je Zeile den (einen) Landkreis - entweder
    // per ST_Contains aus der Geokoordinate, oder (fuer bbk_warnung) direkt aus dem beim Abruf schon
    // bekannten payload.landkreisAgs. Nur dwd_unwetter (wirklich keine Geokoordinate, kein bekannter
    // Kreis) bleibt ohne Landkreis-Zuordnung - das Frontend gruppiert diese Zeilen stattdessen unter
    // "ganzes Bundesland" (siehe payload.bundeslandCode). Grundlage fuer die Gruppierung "nach
    // Landkreis" im Frontend, siehe js/list.js + js/gebiet-info.js.
    const { rows } = await query(
      `SELECT live_datapoint.id, live_datapoint.source, live_datapoint.external_id, live_datapoint.title,
              live_datapoint.value_numeric, live_datapoint.unit, live_datapoint.severity,
              live_datapoint.item_timestamp, live_datapoint.fetched_at, live_datapoint.valid_until,
              live_datapoint.payload,
              ST_Y(live_datapoint.geom) AS lat, ST_X(live_datapoint.geom) AS lon,
              lk.ags AS landkreis_ags, lk.name AS landkreis_name
       FROM live_datapoint
       LEFT JOIN LATERAL (
         SELECT l.ags, l.name FROM landkreis l
         WHERE
           (live_datapoint.geom IS NOT NULL AND ST_Contains(l.geom, live_datapoint.geom))
           OR (live_datapoint.geom IS NULL AND l.ags = live_datapoint.payload->>'landkreisAgs')
         LIMIT 1
       ) lk ON true
       ${where}
       ORDER BY live_datapoint.fetched_at DESC
       LIMIT 2000`,
      params
    );

    return res.json({ ok: true, data: rows, meta: { gebietGefiltert: gebiet !== null } });
  } catch (err) {
    return next(err);
  }
});

// GET /api/datapoints/history?source=pegelonline&externalId=<uuid>
// Zeitreihe fuer das Pegel-Liniendiagramm-Widget (Konzept Teil 2, Baustein D) aus datapoint_history
// (Migration 013). Nur Quellen aus HISTORY_SOURCES in fetchers/normalize.js haben ueberhaupt
// Historien-Zeilen - fuer alle anderen liefert die Abfrage einfach ein leeres Array statt eines
// Fehlers, das Widget zeigt dann "keine Daten" statt eines API-Fehlers.
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const { source, externalId } = req.query;
    if (!source || !VALID_SOURCES.includes(source)) {
      return res.status(400).json({ ok: false, error: `Unbekannte Quelle "${source}".` });
    }
    if (!externalId) {
      return res.status(400).json({ ok: false, error: 'externalId fehlt.' });
    }

    const allowed = await hasFeatureAccess(req.user.id, req.user.role, req.user.wehrId, source);
    if (!allowed) {
      return res.status(403).json({ ok: false, error: 'Kein Zugriff auf diese Datenquelle.' });
    }

    const { rows } = await query(
      `SELECT value_numeric, unit, item_timestamp, fetched_at
       FROM datapoint_history
       WHERE source = $1 AND external_id = $2 AND fetched_at >= now() - interval '14 days'
       ORDER BY fetched_at ASC
       LIMIT 2000`,
      [source, externalId]
    );

    return res.json({ ok: true, data: rows });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
