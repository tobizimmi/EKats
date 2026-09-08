// Gemeinsame Zustaendigkeitsgebiet-Info (Heimat-Landkreis + automatisch berechnete Nachbarn, siehe
// backend/src/routes/wehr.js), von list.js (Gruppierung) und weather-overview.js (Kopfzeile) genutzt.
// Eigenes kleines Modul statt in einer der beiden Dateien, weil list.js auch auf den Addon-Einzelseiten
// eingebunden ist, weather-overview.js aber nur auf dem Dashboard.

let gebietInfoCache = null;

async function loadGebietInfo() {
  if (gebietInfoCache) return gebietInfoCache;
  try {
    gebietInfoCache = await api.get('/wehr');
  } catch (err) {
    console.warn('[gebiet-info] Zustaendigkeitsgebiet-Info konnte nicht geladen werden:', err);
    gebietInfoCache = null;
  }
  return gebietInfoCache;
}

// Sortier-Rang je Landkreis-AGS fuer die Gruppen-Reihenfolge: Heimat zuerst (0), dann Nachbarn in
// derselben Reihenfolge wie vom Backend geliefert (alphabetisch, siehe loadNeighborLandkreise()).
function landkreisRank(ags, gebietInfo) {
  if (!gebietInfo) return 1;
  if (ags === gebietInfo.home_landkreis_ags) return 0;
  const idx = (gebietInfo.neighborLandkreise || []).findIndex((l) => l.ags === ags);
  return idx === -1 ? 1 : idx + 1;
}

// Gruppen-Schluessel/-Label/-Rang fuer einen Datenpunkt. Quellen mit ermittelter Kreis-Zuordnung
// (siehe backend LEFT JOIN LATERAL in routes/datapoints.js -> dp.landkreis_ags/landkreis_name)
// gruppieren nach Landkreis; die beiden bundeslandweiten Quellen ohne Geokoordinate
// (dwd_unwetter/waldbrandindex) gruppieren nach Bundesland - eine Kreis-Zuordnung waere geraten
// (siehe README "Warnungen als Flaeche statt Punkt").
function groupInfoForDatapoint(dp, gebietInfo) {
  if (dp.landkreis_ags) {
    const isHome = gebietInfo && dp.landkreis_ags === gebietInfo.home_landkreis_ags;
    return {
      key: `lk:${dp.landkreis_ags}`,
      label: dp.landkreis_name + (isHome ? ' (Heimat)' : ''),
      rank: landkreisRank(dp.landkreis_ags, gebietInfo),
    };
  }

  const bundeslandCode = dp.payload?.bundeslandCode;
  if (bundeslandCode) {
    const stateName = dp.payload?.state;
    return {
      key: `bl:${bundeslandCode}`,
      label: `Ganzes Bundesland (${stateName || bundeslandCode})`,
      rank: 1000,
    };
  }

  return { key: 'unbekannt', label: 'Ohne Gebietszuordnung', rank: 2000 };
}

// Gruppiert Datenpunkte nach Landkreis (Heimat zuerst, dann Nachbarn, dann bundeslandweite
// Sammelgruppen, dann Rest) - jede Gruppe behaelt ihre Datenpunkte in Original-Reihenfolge, Sortierung
// innerhalb der Gruppe ist Sache des Aufrufers (z.B. nach Dringlichkeit, siehe list.js).
function groupDatapointsByLandkreis(datapoints, gebietInfo) {
  const groups = new Map();
  datapoints.forEach((dp) => {
    const info = groupInfoForDatapoint(dp, gebietInfo);
    if (!groups.has(info.key)) {
      groups.set(info.key, { label: info.label, rank: info.rank, items: [] });
    }
    groups.get(info.key).items.push(dp);
  });
  return [...groups.values()].sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label, 'de'));
}
