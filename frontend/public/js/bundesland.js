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
// (Themenseiten) genutzt.
//
// DRITTER UND (jetzt echt) VERIFIZIERTER VERSUCH: der Nutzer hat GetCapabilities live gegen
// maps.dwd.de geprueft (per curl auf dem Produktivserver, siehe README) und den vollstaendigen
// Layer-Katalog geliefert. Die vorherigen zwei Versuche waren aus zwei verschiedenen Gruenden falsch:
// "dwd:Niederschlagsradar" hatte den RICHTIGEN Basisnamen, aber einen ueberfluessigen "dwd:"-Praefix
// - der Endpunkt "https://maps.dwd.de/geoserver/dwd/wms" ist bereits auf den Workspace "dwd"
// eingeschraenkt, ein zusaetzliches "dwd:" im layers-Parameter sucht dann faelschlich nach einem
// Layer, der woertlich "dwd:Niederschlagsradar" heisst (gibt es nicht). "dwd:RX-Produkt" war schlicht
// kein existierender Layer auf diesem GeoServer (stammte aus einem anderen Kontext). Laut
// GetCapabilities-XML heisst der Layer exakt "Niederschlagsradar" (ohne Praefix), unterstuetzt
// EPSG:3857 (Leaflets Standard-Projektion) und hat eine time-Dimension mit Default "current" - ohne
// TIME-Parameter zeigt er also automatisch den aktuellsten Stand, kein Zusatzparameter noetig. Laut
// Abstract sogar noch besser als erhofft: "Niederschlagsradar und -vorhersage, Alias fuer RV-Produkt
// (Aufloesung 1km), 5 minuetig" - enthaelt bereits eine kurzfristige Vorhersage-Komponente.
// Bewusst als zuschaltbarer Overlay (Standard AUS): schlaegt der Layer-Name doch fehl, bleiben nur
// Kacheln aus, kein Fehler und keine Beeintraechtigung der eigentlichen Lage-Daten (siehe tileerror-
// Handler unten als Absicherung).
function createNiederschlagsradarLayer() {
  return L.tileLayer.wms('https://maps.dwd.de/geoserver/dwd/wms', {
    layers: 'Niederschlagsradar',
    format: 'image/png',
    transparent: true,
    opacity: 0.6,
    attribution: 'Radardaten: Deutscher Wetterdienst (DWD)',
  });
}

// Haengt die Radar-Layer-Auswahl (Leaflet-eigenes Steuerelement, oben rechts auf der Karte) an -
// gemeinsam von map.js und addon.js aufgerufen, damit beide Kartenarten dieselbe Bedienung haben.
// Der Layer-Name ist unverifiziert (siehe createNiederschlagsradarLayer) - schlaegt er in der Praxis
// fehl, bliebe die Karte sonst wortlos leer und der eigentliche Fehler (Layer-Name/Dienst) unsichtbar.
// tileerror liefert bei einer WMS-ServiceException KEINEN HTTP-Fehlerstatus (die Antwort ist meist
// ein HTTP-200-XML-Dokument, das der Browser nur als kaputtes Bild erkennt) - deshalb hier explizit
// abgefangen statt sich auf eine sichtbare Netzwerk-Fehlermeldung zu verlassen.
function addRadarLayerControl(map) {
  const radarLayer = createNiederschlagsradarLayer();
  let noticeShown = false;
  radarLayer.on('tileerror', (event) => {
    console.error(
      '[bundesland] Niederschlagsradar-Kachel fehlgeschlagen - Layer-Name "dwd:Niederschlagsradar" evtl. ' +
        'falsch/veraltet. Zur Diagnose die fehlgeschlagene URL direkt im Browser oeffnen (liefert bei ' +
        'falschem Namen eine WMS-ServiceException als XML) oder GetCapabilities pruefen: ' +
        'https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0&request=GetCapabilities',
      event?.tile?.src
    );
    if (noticeShown) return;
    noticeShown = true;
    const notice = L.control({ position: 'bottomleft' });
    notice.onAdd = () => {
      const div = L.DomUtil.create('div', 'radar-error-notice');
      div.textContent = 'Regenradar konnte nicht geladen werden (DWD-Kartendienst nicht erreichbar oder Layer-Name veraltet).';
      return div;
    };
    notice.addTo(map);
  });
  L.control.layers(null, { 'Niederschlagsradar (DWD)': radarLayer }, { collapsed: true }).addTo(map);
}
