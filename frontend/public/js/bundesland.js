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

// Zeitschritt/-fenster fuer den Verlauf-Regler unten - deckt sich mit der vom DWD-GeoServer
// tatsaechlich gelieferten Aufloesung (Dimension "time", 5-Minuten-Raster, per GetCapabilities auf
// dem Produktivserver bestaetigt, siehe README). 2 Stunden Verlauf = 24 Schritte, ausreichend um eine
// Zugrichtung erkennbar zu machen, ohne die Steuerung unhandlich zu machen.
const RADAR_TIME_STEP_MINUTES = 5;
const RADAR_TIME_WINDOW_HOURS = 2;

// Haengt die Radar-Layer-Auswahl (Leaflet-eigenes Steuerelement, oben rechts auf der Karte) an -
// gemeinsam von map.js und addon.js aufgerufen, damit beide Kartenarten dieselbe Bedienung haben.
// tileerror liefert bei einer WMS-ServiceException KEINEN HTTP-Fehlerstatus (die Antwort ist meist
// ein HTTP-200-XML-Dokument, das der Browser nur als kaputtes Bild erkennt) - deshalb hier explizit
// abgefangen statt sich auf eine sichtbare Netzwerk-Fehlermeldung zu verlassen.
function addRadarLayerControl(map) {
  const radarLayer = createNiederschlagsradarLayer();
  let noticeShown = false;
  radarLayer.on('tileerror', (event) => {
    console.error(
      '[bundesland] Niederschlagsradar-Kachel fehlgeschlagen - Dienst evtl. nicht erreichbar oder ' +
        'Layer-Name/Zeitstempel abgelehnt. Zur Diagnose die fehlgeschlagene URL direkt im Browser ' +
        'oeffnen (liefert bei einem Fehler eine WMS-ServiceException als XML) oder GetCapabilities ' +
        'pruefen: https://maps.dwd.de/geoserver/dwd/wms?service=WMS&version=1.3.0&request=GetCapabilities',
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

  // Verlauf-Regler nur einblenden, waehrend der Radar-Layer tatsaechlich aktiv ist (Leaflets eigene
  // overlayadd/-remove-Events der Layer-Auswahl, feuern fuer jeden Overlay-Toggle - deshalb auf den
  // Radar-Layer gefiltert). Bewusst VOR L.control.layers() registriert, nicht danach - der Nutzer
  // kann die Checkbox erst anklicken, nachdem diese Funktion vollstaendig durchgelaufen ist, aber
  // robuster ist es trotzdem, auf ein Event erst zu warten, nachdem man es abonniert hat.
  let timeSlider = null;
  map.on('overlayadd', (event) => {
    if (event.layer !== radarLayer) return;
    if (!timeSlider) timeSlider = createRadarTimeSliderControl(radarLayer);
    timeSlider.addTo(map);
  });
  map.on('overlayremove', (event) => {
    if (event.layer !== radarLayer || !timeSlider) return;
    map.removeControl(timeSlider);
  });

  L.control.layers(null, { 'Niederschlagsradar (DWD)': radarLayer }, { collapsed: true }).addTo(map);
}

// Rundet auf das vom DWD-Dienst genutzte 5-Minuten-Raster ab - ein krummer Zeitstempel dazwischen
// liegt ausserhalb des tatsaechlich vorgehaltenen Rasters und koennte eine leere Kachel liefern.
function roundDownToRadarStep(date) {
  const rounded = new Date(date);
  rounded.setSeconds(0, 0);
  rounded.setMinutes(Math.floor(rounded.getMinutes() / RADAR_TIME_STEP_MINUTES) * RADAR_TIME_STEP_MINUTES);
  return rounded;
}

// Verlauf-Regler fuer das Niederschlagsradar (Nutzerwunsch: "Regenradar Historie per Slider bewegen").
// Bewusst nur rueckwaerts (letzte 2 Stunden bis jetzt) - der GetCapabilities-Abgleich auf dem
// Produktivserver zeigte zwar eine "-vorhersage" im Abstract des Layers, das tatsaechlich vorgehaltene
// time-Dimension-Fenster endete aber exakt bei "jetzt", nicht in der Zukunft. Echte Vorhersage-Frames
// sind damit unbestaetigt - ohne Live-Test gegen zukuenftige Zeitstempel nicht blind ergaenzt (gleiche
// Vorsicht wie beim Rest des Projekts, siehe README "Verifikationsstand").
function createRadarTimeSliderControl(radarLayer) {
  const control = L.control({ position: 'bottomleft' });
  control.onAdd = () => {
    const totalSteps = (RADAR_TIME_WINDOW_HOURS * 60) / RADAR_TIME_STEP_MINUTES;

    const div = L.DomUtil.create('div', 'radar-time-slider');
    L.DomEvent.disableClickPropagation(div);
    L.DomEvent.disableScrollPropagation(div);

    const title = document.createElement('div');
    title.className = 'radar-time-slider-title';
    title.textContent = 'Niederschlagsradar-Verlauf';
    div.appendChild(title);

    const row = document.createElement('div');
    row.className = 'radar-time-slider-row';

    const playButton = document.createElement('button');
    playButton.type = 'button';
    playButton.className = 'radar-time-slider-play';
    playButton.textContent = '▶';
    playButton.setAttribute('aria-label', 'Verlauf abspielen');

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = '0';
    slider.max = String(totalSteps);
    slider.step = '1';
    slider.value = String(totalSteps);
    slider.setAttribute('aria-label', 'Zeitpunkt im Regenradar-Verlauf');

    const label = document.createElement('span');
    label.className = 'radar-time-slider-label';

    function applyStep(step) {
      const minutesAgo = (totalSteps - Number(step)) * RADAR_TIME_STEP_MINUTES;
      const date = roundDownToRadarStep(new Date(Date.now() - minutesAgo * 60 * 1000));
      radarLayer.setParams({ time: date.toISOString() });
      label.textContent =
        Number(step) >= totalSteps
          ? 'Jetzt'
          : date.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    }

    slider.addEventListener('input', () => applyStep(slider.value));

    let playTimer = null;
    playButton.addEventListener('click', () => {
      if (playTimer) {
        clearInterval(playTimer);
        playTimer = null;
        playButton.textContent = '▶';
        return;
      }
      playButton.textContent = '⏸';
      playTimer = setInterval(() => {
        const next = Number(slider.value) + 1 > totalSteps ? 0 : Number(slider.value) + 1;
        slider.value = String(next);
        applyStep(next);
      }, 700);
    });

    row.appendChild(playButton);
    row.appendChild(slider);
    row.appendChild(label);
    div.appendChild(row);

    applyStep(slider.value);
    return div;
  };
  return control;
}
