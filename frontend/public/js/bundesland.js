// Gemeinsame Datenpunkt-Layer-Logik fuer Dashboard (map.js) und Addon-Einzelseiten (addon.js):
// manche Quellen liefern keine Einzelkoordinate, nur eine Gebiets-Zuordnung, und werden deshalb als
// eingefaerbte Flaeche statt als Punkt-Marker dargestellt:
// - dwd_unwetter: nur ein Bundesland-Code (payload.bundeslandCode) -> Bundesland-Flaeche.
// - bbk_warnung: ein exakter Kreis (payload.landkreisAgs, siehe backend/src/fetchers/bbkWarnungen.js)
//   -> Kreis-Flaeche, praeziser als die Bundesland-Naeherung. Nutzt dieselben Polygone wie der
//   Zustaendigkeitsgebiet-Layer (GET /wehr/gebiet-geojson), da bbk_warnung ohnehin nur fuer Kreise im
//   eigenen Gebiet abgerufen wird - keine zusaetzliche Route noetig.
// Alle anderen Quellen bleiben unveraendert ein Kreis-Marker an lat/lon.

let bundeslandFeaturesByCode = new Map();
let landkreisFeaturesByAgs = new Map();

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

async function loadLandkreisFeatures() {
  if (landkreisFeaturesByAgs.size > 0) return landkreisFeaturesByAgs;
  try {
    const geojson = await api.get('/wehr/gebiet-geojson');
    geojson.features.forEach((feature) => landkreisFeaturesByAgs.set(feature.properties.ags, feature));
  } catch (err) {
    console.warn('[bundesland] Landkreis-Flaechen (Gebiet) konnten nicht geladen werden:', err);
  }
  return landkreisFeaturesByAgs;
}

// Erstellt den Leaflet-Layer fuer einen einzelnen Datenpunkt - Flaeche fuer dwd_unwetter/bbk_warnung
// (falls die zugehoerige Geometrie bereits geladen ist), sonst ein farbiger Kreis-Marker wie bisher.
// Gibt null zurueck, wenn der Datenpunkt nicht darstellbar ist (keine Koordinate/Flaeche).
function createDatapointLayer(dp) {
  const color = SEVERITY_COLORS[Math.min(severityScore(dp), 4)];

  if (dp.source === 'bbk_warnung' && dp.payload && dp.payload.landkreisAgs) {
    const feature = landkreisFeaturesByAgs.get(dp.payload.landkreisAgs);
    if (!feature) return null;
    return L.geoJSON(feature, {
      style: { color, weight: 2, fillColor: color, fillOpacity: 0.3 },
    });
  }

  if (dp.source === 'dwd_unwetter' && dp.payload && dp.payload.bundeslandCode) {
    const feature = bundeslandFeaturesByCode.get(dp.payload.bundeslandCode);
    if (!feature) return null;
    return L.geoJSON(feature, {
      style: { color, weight: 2, fillColor: color, fillOpacity: 0.25 },
    });
  }

  if (dp.lat === null || dp.lon === null) return null;
  const marker = L.circleMarker([dp.lat, dp.lon], {
    radius: 8,
    color,
    fillColor: color,
    fillOpacity: 0.85,
    weight: 2,
  });

  // Pegelstand permanent an der Messstelle einblenden statt nur im Tooltip-on-Hover/Klick-Panel -
  // bei einer Hochwasserlage soll der Wert auf einen Blick sichtbar sein, ohne jede Messstelle
  // einzeln anzuklicken. Einen HW100-Referenzwert (100-jaehrliches Hochwasser) gibt es dazu bewusst
  // nicht: weder PEGELONLINE (WSV) noch die Hochwasserzentralen-Schnittstelle liefern diesen Wert
  // (siehe README, Abschnitt "Individuelles Dashboard", Pegelstand-Absatz) - keine erfundene Zahl.
  if ((dp.source === 'pegelonline' || dp.source === 'hochwasserzentralen') && dp.value_numeric !== null && dp.value_numeric !== undefined) {
    marker.bindTooltip(`${dp.value_numeric}${dp.unit ? ` ${dp.unit}` : ''}`, {
      permanent: true,
      direction: 'right',
      offset: [8, 0],
      className: 'pegel-value-label',
    });
  }

  return marker;
}

// DWD-Niederschlagsradar als optionaler WMS-Overlay - macht die Zugrichtung von Niederschlag/Gewitter
// direkt auf der Karte sichtbar, nicht nur als Einzel-Warnung. Von map.js (Dashboard) und addon.js
// (Themenseiten) genutzt. Layer-Name "dwd:Niederschlagsradar" stammt aus einer von DWDs eigenem
// GeoServer generierten GetMap-Vorschau-URL (siehe README, Abschnitt "Gewitterzug/Niederschlags-
// bewegung") - im Entwicklungs-Sandbox nicht gegenpruefbar, da maps.dwd.de dort blockiert ist. Bewusst als
// zuschaltbarer Overlay (Standard AUS): schlaegt der Layer-Name doch fehl, bleiben nur Kacheln aus,
// kein Fehler und keine Beeintraechtigung der eigentlichen Lage-Daten.
function createNiederschlagsradarLayer() {
  return L.tileLayer.wms('https://maps.dwd.de/geoserver/dwd/wms', {
    layers: 'dwd:Niederschlagsradar',
    format: 'image/png',
    transparent: true,
    opacity: 0.6,
    attribution: 'Radardaten: Deutscher Wetterdienst (DWD)',
  });
}

// Haengt die Radar-Layer-Auswahl (Leaflet-eigenes Steuerelement, oben rechts auf der Karte) an -
// gemeinsam von map.js und addon.js aufgerufen, damit beide Kartenarten dieselbe Bedienung haben.
function addRadarLayerControl(map) {
  L.control.layers(null, { 'Niederschlagsradar (DWD)': createNiederschlagsradarLayer() }, { collapsed: true }).addTo(map);
}
