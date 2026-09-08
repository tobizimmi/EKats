// Gemeinsame Datenpunkt-Layer-Logik fuer Dashboard (map.js) und Addon-Einzelseiten (addon.js):
// DWD-Unwetterwarnungen liefern keine Einzelkoordinate, nur eine Bundesland-Zuordnung
// (payload.bundeslandCode, siehe backend/src/fetchers/dwdUnwetter.js) - die werden deshalb als
// eingefaerbte Bundesland-Flaeche statt als Punkt-Marker dargestellt. Alle anderen Quellen bleiben
// unveraendert ein Kreis-Marker an lat/lon.

let bundeslandFeaturesByCode = new Map();

async function loadBundeslandFeatures() {
  if (bundeslandFeaturesByCode.size > 0) return bundeslandFeaturesByCode;
  try {
    const geojson = await api.get('/bundeslaender');
    geojson.features.forEach((feature) => bundeslandFeaturesByCode.set(feature.properties.code, feature));
  } catch (err) {
    console.warn('[bundesland] Bundesland-Flaechen konnten nicht geladen werden:', err);
  }
  return bundeslandFeaturesByCode;
}

// Erstellt den Leaflet-Layer fuer einen einzelnen Datenpunkt - Flaeche fuer dwd_unwetter (falls die
// zugehoerige Bundesland-Geometrie bereits geladen ist), sonst ein farbiger Kreis-Marker wie
// bisher. Gibt null zurueck, wenn der Datenpunkt nicht darstellbar ist (keine Koordinate/Flaeche).
function createDatapointLayer(dp) {
  const color = SEVERITY_COLORS[Math.min(severityScore(dp), 4)];

  if (dp.source === 'dwd_unwetter' && dp.payload && dp.payload.bundeslandCode) {
    const feature = bundeslandFeaturesByCode.get(dp.payload.bundeslandCode);
    if (!feature) return null;
    return L.geoJSON(feature, {
      style: { color, weight: 2, fillColor: color, fillOpacity: 0.25 },
    });
  }

  if (dp.lat === null || dp.lon === null) return null;
  return L.circleMarker([dp.lat, dp.lon], {
    radius: 8,
    color,
    fillColor: color,
    fillOpacity: 0.85,
    weight: 2,
  });
}
