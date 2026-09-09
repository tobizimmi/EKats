// Individuelles Dashboard (Konzept Teil 2, Baustein D; Raster-Umbau: Nutzerwunsch nach freier
// Position/Größe je Widget statt nur Reihenfolge). Baukasten aus Widgets, die bestehende Ansichten
// kapseln (Karte, Prioritaets-Leiste, Objekt-Uebersicht, ...) plus mehrere schlanke, aus bereits
// vorhandenen Daten gespeiste Zusatz-Widgets. Layout liegt in derselben user_preference-Tabelle wie
// die Spaltenwahl der Themenseiten (Migration 011, siehe js/data-table.js), unter dem Schluessel
// 'dashboard_layout' - Zuruecksetzen loescht einfach die Zeile, die Seite faellt auf DEFAULT_WIDGETS
// zurueck (kein serverseitiger Default noetig, gleiches Muster wie dort).
//
// Raster: gridstack.js (MIT, lokal vendored unter vendor/gridstack/, siehe VERSION.txt dort) -
// anders als beim Kartenskizzen-Editor (Leaflet-Geoman) baut EKats hier NICHT auf einer eigenen
// Positionier-/Kollisionslogik, weil freies Ziehen+Groessenaendern mit automatischer
// Kollisionsvermeidung/Verdichtung viele Randfaelle hat, die eine gereifte Bibliothek bereits loest.
// Jedes Widget traegt x/y/w/h in Rastereinheiten (12 Spalten); gespeichert wird ausschliesslich das,
// was gridstack per grid.save(false) zurueckgibt (keine eigene Positions-Buchhaltung). Unterhalb von
// 700px Containerbreite schaltet gridstack per columnOpts.breakpoints automatisch auf eine Spalte um
// (Reihenfolge bleibt per Drag aenderbar, Resize-Griffe werden dort per CSS ausgeblendet) - die
// urspruengliche Mehrspalten-Anordnung bleibt dabei intern gecacht und kommt beim Zurueckwechseln
// unveraendert zurueck (gridstack-eigener Mechanismus, siehe GridStackEngine.save()).

const DASHBOARD_PREF_KEY = 'dashboard_layout';
const GRID_COLUMNS = 12;

// Singleton-Typen zeigen ohnehin die gesamte Wehr-Lage - ein zweites Exemplar waere nur eine Kopie,
// deshalb hoechstens einmal im Layout erlaubt. Pegel-Liniendiagramme sind bewusst mehrfach moeglich
// (ein Widget je beobachteter Station). w/h/minW/minH in Rastereinheiten (12 Spalten, siehe oben).
const WIDGET_CATALOG = {
  karte: { label: 'Karte', icon: '📍', singleton: true, w: 6, h: 4, minW: 4, minH: 3 },
  prioritaet: { label: 'Prioritäts-Leiste', icon: '🚦', singleton: true, w: 6, h: 2, minW: 3, minH: 2 },
  objekte: { label: 'Objekt-Übersicht', icon: '🏫', singleton: true, w: 4, h: 2, minW: 3, minH: 2 },
  'dwd-bild': { label: 'DWD-Wetterbild', icon: '🌩️', singleton: true, w: 6, h: 4, minW: 4, minH: 3 },
  'pegel-chart': { label: 'Pegel-Liniendiagramm', icon: '📈', singleton: false, w: 6, h: 3, minW: 4, minH: 2 },
  'waldbrand-trend': { label: 'Waldbrand-Trend', icon: '🔥', singleton: false, w: 6, h: 3, minW: 4, minH: 2 },
  'firms-map': { label: 'FIRMS-Hotspot-Karte', icon: '🛰️', singleton: true, w: 6, h: 4, minW: 4, minH: 3 },
  'wetter-vorhersage': { label: 'Wetter-Vorhersage', icon: '🌦️', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'blitz-zaehler': { label: 'Blitz-Zähler', icon: '⚡', singleton: true, w: 3, h: 2, minW: 2, minH: 2 },
  fahrzeugstatus: { label: 'Fahrzeugstatus', icon: '🚒', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'faellige-pruefungen': { label: 'Anstehende Überprüfungen', icon: '📋', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'bbk-feed': { label: 'BBK/NINA-Warnungen', icon: '📣', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'kachelmann-wetter': { label: 'Kachelmann-Wetter', icon: '🌡️', singleton: true, w: 3, h: 2, minW: 3, minH: 2 },
  uhr: { label: 'Uhr / Datum', icon: '🕘', singleton: true, w: 3, h: 2, minW: 2, minH: 2 },
  notiz: { label: 'Notiz-Pinnwand', icon: '📝', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  links: { label: 'Eigene Links', icon: '🔗', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'hochwasser-liste': { label: 'Hochwasserzentralen', icon: '🌊', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'unwetter-ticker': { label: 'DWD-Unwetter-Ticker', icon: '⛈️', singleton: true, w: 4, h: 3, minW: 3, minH: 2 },
  'status-zeile': { label: 'Gesamt-Statuszeile', icon: '📊', singleton: true, w: 12, h: 1, minW: 6, minH: 1 },
};

const DEFAULT_WIDGETS = [
  { id: 'karte', type: 'karte' },
  { id: 'status-zeile', type: 'status-zeile' },
  { id: 'prioritaet', type: 'prioritaet' },
  { id: 'objekte', type: 'objekte' },
  { id: 'dwd-bild', type: 'dwd-bild' },
];

const dash = {
  grid: null,
  widgets: [],
  wehr: null,
  allObjects: [],
  vehicles: [],
  pegelStations: [],
  waldbrandStations: [],
  datapoints: [],
  leafletMaps: {}, // widgetId -> Leaflet-Map-Instanz, fuer invalidateSize() nach Resize
  timers: [], // laufende setInterval-IDs (Uhr-Widget), vor jedem Neuaufbau geleert
};

function isOverdueLocal(obj) {
  return !!obj.next_review_at && new Date(obj.next_review_at).getTime() < Date.now();
}

async function loadLayout() {
  try {
    const pref = await api.get(`/user-preferences/${DASHBOARD_PREF_KEY}`);
    if (pref && Array.isArray(pref.value?.widgets)) {
      dash.widgets = pref.value.widgets;
      return;
    }
  } catch (err) {
    // Ohne (oder mit fehlerhafter) gespeicherter Praeferenz bleibt der Standard aktiv.
  }
  dash.widgets = DEFAULT_WIDGETS.map((w) => ({ ...w }));
}

// Persistiert dash.widgets unveraendert (fuer Config-Aenderungen wie Notiztext/Links, die keine
// Positionsaenderung sind). Positionsaenderungen laufen ueber syncPositionsAndSave().
function persistWidgets() {
  api.put(`/user-preferences/${DASHBOARD_PREF_KEY}`, { value: { widgets: dash.widgets } }).catch((err) => {
    console.error('[dashboard] Layout konnte nicht gespeichert werden:', err);
  });
}

// Liest die tatsaechlichen x/y/w/h aus gridstack aus (grid.save(false) - gridstack haelt bei
// Spaltenumschaltung auf 1 Spalte intern die Mehrspalten-Positionen vor und liefert hier weiterhin
// die "grosse" Anordnung zurueck, siehe Dateikopf) und schreibt sie in dash.widgets zurueck, bevor
// gespeichert wird.
function syncPositionsAndSave() {
  if (!dash.grid) return;
  const saved = dash.grid.save(false);
  const byId = Object.fromEntries(saved.filter((n) => n.id).map((n) => [n.id, n]));
  dash.widgets.forEach((w) => {
    const n = byId[w.id];
    if (n) {
      w.x = n.x;
      w.y = n.y;
      w.w = n.w;
      w.h = n.h;
    }
  });
  persistWidgets();
}

async function resetLayout() {
  try {
    await api.delete(`/user-preferences/${DASHBOARD_PREF_KEY}`);
  } catch (err) {
    console.error('[dashboard] Zuruecksetzen fehlgeschlagen:', err);
  }
  dash.widgets = DEFAULT_WIDGETS.map((w) => ({ ...w }));
  renderWidgets();
}

function removeWidget(widgetId) {
  dash.widgets = dash.widgets.filter((w) => w.id !== widgetId);
  renderWidgets();
}

function iconButton(text, label, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'widget-icon-button';
  b.textContent = text;
  b.setAttribute('aria-label', label);
  b.addEventListener('click', onClick);
  return b;
}

// --- Widget-Renderer ---------------------------------------------------------------------------

function renderKarteWidget(container, widget) {
  const mapEl = document.createElement('div');
  mapEl.className = 'widget-map';
  container.appendChild(mapEl);

  const withCoords = dash.allObjects.filter(
    (o) => o.lat !== null && o.lon !== null && o.lat !== undefined && o.lon !== undefined
  );
  const center =
    dash.wehr?.center_lat != null && dash.wehr?.center_lon != null
      ? [dash.wehr.center_lat, dash.wehr.center_lon]
      : withCoords.length
        ? [withCoords[0].lat, withCoords[0].lon]
        : [51.1657, 10.4515]; // Deutschland-Mittelpunkt als letzter Fallback, falls beides fehlt

  const map = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView(center, 11);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  withCoords.forEach((o) => {
    L.circleMarker([o.lat, o.lon], { radius: 5, color: '#b3261e', fillColor: '#b3261e', fillOpacity: 0.85 }).addTo(
      map
    );
  });
  // Innerhalb einer zu dem Zeitpunkt noch layoutlosen Kachel initialisiert Leaflet mit falscher
  // Groesse - invalidateSize() nach dem naechsten Layout-Tick korrigiert das zuverlaessig. Die
  // Map-Instanz wird zusaetzlich fuer spaetere Resize-Events der Kachel gemerkt (siehe initGrid()).
  setTimeout(() => map.invalidateSize(), 0);
  dash.leafletMaps[widget.id] = map;

  const link = document.createElement('a');
  link.href = './';
  link.className = 'widget-link';
  link.textContent = 'Zur vollständigen Karte →';
  container.appendChild(link);
}

function renderPrioritaetWidget(container) {
  const counts = { critical: 0, high: 0, medium: 0, ok: 0 };
  dash.datapoints.forEach((dp) => {
    const score = severityScore(dp);
    if (score >= 4) counts.critical += 1;
    else if (score === 3) counts.high += 1;
    else if (score === 1 || score === 2) counts.medium += 1;
    else counts.ok += 1;
  });
  // Ueberfaellige Objekt-Ueberpruefungen zaehlen genauso in "Kritisch" wie auf dem Karten-Dashboard
  // (js/priority-bar.js) - dieselbe Grundidee, hier eigenstaendig nachgebildet, da dieses Widget
  // unabhaengig von index.html funktionieren muss.
  counts.critical += dash.allObjects.filter(isOverdueLocal).length;

  container.innerHTML = '';
  const row = document.createElement('div');
  row.className = 'priority-bar widget-priority-bar';
  [
    ['critical', 'Kritisch'],
    ['high', 'Hoch'],
    ['medium', 'Mittel'],
    ['ok', 'Unauffällig'],
  ].forEach(([key, label]) => {
    const tile = document.createElement('div');
    tile.className = `priority-tile priority-${key}`;
    tile.innerHTML = `<span class="priority-tile-n">${counts[key]}</span><span class="priority-tile-l">${label}</span>`;
    row.appendChild(tile);
  });
  container.appendChild(row);
}

function renderObjekteWidget(container) {
  const overdue = dash.allObjects.filter(isOverdueLocal).length;
  const ok = dash.allObjects.length - overdue;
  container.innerHTML = `
    <div class="widget-objekte-stats">
      <div><span class="widget-stat-dot" style="background:var(--danger)"></span>${overdue} Objekte überfällig</div>
      <div><span class="widget-stat-dot" style="background:var(--ok)"></span>${ok} ok</div>
    </div>
    <a class="widget-link" href="objekte.html">Zur Objekt-Übersicht →</a>
  `;
}

// DWD-Wetterbild: bindet den offiziell von DWD dokumentierten WMS-Geodienst zum Einbetten von
// Kartenbildern auf fremden Webseiten ein (siehe README "DWD-Wetterbild-Widget" fuer den
// Verifikationsstand). Layer-Namen bewusst OHNE "dwd:"-Praefix: der Endpunkt
// "https://maps.dwd.de/geoserver/dwd/ows" ist bereits auf den Workspace "dwd" eingeschraenkt, ein
// zusaetzliches "dwd:" im layers-Parameter sucht dann faelschlich nach einem Layer, der woertlich
// "dwd:bluemarble" heisst (gibt es nicht) - derselbe Fehler, der beim Niederschlagsradar-Overlay
// (siehe createNiederschlagsradarLayer() in js/bundesland.js) live bestaetigt wurde, per
// GetCapabilities-Abgleich auf dem Produktivserver behoben.
function renderDwdBildWidget(container) {
  const lat = dash.wehr?.center_lat ?? 51.1657;
  const lon = dash.wehr?.center_lon ?? 10.4515;
  // Grobe Bounding-Box (~150 km je Richtung) um den Wehr-Kartenmittelpunkt, damit das Bild das
  // eigene Zustaendigkeitsgebiet statt ganz Deutschlands zeigt.
  const dLat = 0.9;
  const dLon = 1.4;
  const bbox = [lon - dLon, lat - dLat, lon + dLon, lat + dLat].join(',');
  const src =
    'https://maps.dwd.de/geoserver/dwd/ows?service=WMS&version=1.3&request=GetMap' +
    '&layers=bluemarble,Warngebiete_Kreise,Warnungen_Gemeinden_vereinigt' +
    `&bbox=${bbox}&width=420&height=300&srs=EPSG:4326&format=image/png`;

  const img = document.createElement('img');
  img.className = 'widget-dwd-image';
  img.alt = 'Aktuelle DWD-Warnkarte für das Zuständigkeitsgebiet';
  img.loading = 'lazy';
  img.addEventListener('error', () => {
    container.innerHTML =
      '<p class="muted">DWD-Kartenbild aktuell nicht erreichbar. <a href="https://www.dwd.de/DE/wetter/warnungen_aktuell/warnungen_aktuell_node.html" target="_blank" rel="noopener">Warnungen direkt bei DWD ansehen</a>.</p>';
  });
  img.src = src;
  container.appendChild(img);

  const note = document.createElement('p');
  note.className = 'muted widget-dwd-note';
  note.textContent = 'Quelle: DWD-Geodienste (maps.dwd.de)';
  container.appendChild(note);
}

// Duenner Wrapper um die geteilte Chart-Funktion (js/pegel-chart.js) - loest hier nur die
// Stations-Auswahl aus der Widget-Konfiguration auf.
async function renderPegelChartWidget(container, widget) {
  const externalId = widget.config?.externalId;
  if (!externalId) {
    container.innerHTML = '<p class="muted">Keine Station ausgewählt.</p>';
    return;
  }
  await renderPegelHistoryChart(container, externalId);
}

// Duenner Wrapper wie renderPegelChartWidget, nur fuer den Waldbrandgefahrenindex-Verlauf (seit der
// Erweiterung von HISTORY_SOURCES, siehe backend/src/fetchers/normalize.js).
async function renderWaldbrandTrendWidget(container, widget) {
  const externalId = widget.config?.externalId;
  if (!externalId) {
    container.innerHTML = '<p class="muted">Keine Station ausgewählt.</p>';
    return;
  }
  await renderWaldbrandHistoryChart(container, externalId);
}

// Nicht-interaktive Mini-Karte mit den aktuellen FIRMS-Hotspots (Ergaenzung zur bisherigen
// Listendarstellung auf der FIRMS-Themenseite) - gleiches Muster wie renderKarteWidget.
function renderFirmsMapWidget(container, widget) {
  const items = dash.datapoints.filter(
    (dp) => dp.source === 'firms' && dp.lat !== null && dp.lat !== undefined && dp.lon !== null && dp.lon !== undefined
  );

  const mapEl = document.createElement('div');
  mapEl.className = 'widget-map';
  container.appendChild(mapEl);

  const center =
    dash.wehr?.center_lat != null && dash.wehr?.center_lon != null
      ? [dash.wehr.center_lat, dash.wehr.center_lon]
      : items.length
        ? [items[0].lat, items[0].lon]
        : [51.1657, 10.4515];

  const map = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView(center, 9);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  items.forEach((dp) => {
    L.circleMarker([dp.lat, dp.lon], { radius: 5, color: '#ef6c00', fillColor: '#ef6c00', fillOpacity: 0.85 }).addTo(map);
  });
  setTimeout(() => map.invalidateSize(), 0);
  dash.leafletMaps[widget.id] = map;

  if (items.length === 0) {
    const hint = document.createElement('p');
    hint.className = 'muted';
    hint.textContent = 'Keine aktuellen Hotspots im Gebiet.';
    container.appendChild(hint);
  }
}

// --- Neue Widgets (Dashboard-Flexibilisierung) --------------------------------------------------

// Gemeinsamer Renderer fuer alle "Liste der letzten Meldungen je Quelle"-Widgets - nutzt dieselbe
// Optik wie die Wetter-Übersicht-Karte (js/weather-overview.js: .weather-item-list/.item-main/
// .item-meta), damit eine bereits bestehende, vertraute Darstellung wiederverwendet wird statt einer
// neuen.
function renderDatapointListWidget(container, sourceKey, { emptyText, limit = 5 } = {}) {
  const items = dash.datapoints.filter((dp) => dp.source === sourceKey);
  if (items.length === 0) {
    container.innerHTML = `<p class="muted">${emptyText || 'Keine aktuellen Meldungen im Gebiet.'}</p>`;
    return;
  }
  const sorted = [...items].sort((a, b) => severityScore(b) - severityScore(a)).slice(0, limit);
  const ul = document.createElement('ul');
  ul.className = 'plain-list weather-item-list';
  sorted.forEach((dp) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'item-main';
    main.textContent = dp.title || SOURCE_LABELS[dp.source] || dp.source;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = `${formatValue(dp)} · ${formatTimestamp(dp.item_timestamp)}`;
    li.appendChild(main);
    li.appendChild(meta);
    ul.appendChild(li);
  });
  container.innerHTML = '';
  container.appendChild(ul);
}

function renderWetterVorhersageWidget(container) {
  renderDatapointListWidget(container, 'wetter_vorhersage', {
    emptyText: 'Keine Vorhersage verfügbar.',
    limit: 3,
  });
}

function renderBbkFeedWidget(container) {
  renderDatapointListWidget(container, 'bbk_warnung', {
    emptyText: 'Keine aktuellen Bevölkerungswarnungen im Gebiet.',
  });
}

function renderUnwetterTickerWidget(container) {
  renderDatapointListWidget(container, 'dwd_unwetter', {
    emptyText: 'Keine aktuellen Unwetterwarnungen im Gebiet.',
  });
}

function renderHochwasserListeWidget(container) {
  renderDatapointListWidget(container, 'hochwasserzentralen', {
    emptyText: 'Keine aktuellen Hochwassermeldungen im Gebiet.',
  });
}

// Aktuelles Wetter (Kachelmann) ist - anders als die uebrigen Quellen - eine einzelne Momentaufnahme
// je Wehr-Standort statt einer Liste von Einzelmeldungen (siehe backend/src/fetchers/kachelmann.js),
// daher eigene Darstellung statt renderDatapointListWidget().
function renderKachelmannWetterWidget(container) {
  const item = dash.datapoints.find((dp) => dp.source === 'kachelmann');
  if (!item) {
    container.innerHTML =
      '<p class="muted">Keine Kachelmann-Daten verfügbar (kein Zugriff freigeschaltet oder noch kein Abruf erfolgt).</p>';
    return;
  }
  const payload = item.payload || {};
  container.innerHTML = `
    <div class="widget-kachelmann-temp">${item.value_numeric ?? '–'} ${item.unit || '°C'}</div>
    <div class="muted">${item.severity || ''}</div>
    <div class="muted widget-kachelmann-meta">
      ${payload.windSpeedKmh != null ? `Wind ${payload.windSpeedKmh} km/h · ` : ''}${payload.precipitation != null ? `Niederschlag ${payload.precipitation} mm` : ''}
    </div>
  `;
}

function renderBlitzZaehlerWidget(container) {
  const count = dash.datapoints.filter((dp) => dp.source === 'blitzortung').length;
  container.innerHTML = `
    <div class="widget-big-number">${count}</div>
    <div class="muted">Blitzeinschläge im Gebiet (aktueller Datenstand)</div>
  `;
}

function renderFahrzeugstatusWidget(container) {
  if (dash.vehicles.length === 0) {
    container.innerHTML = '<p class="muted">Keine Fahrzeuge hinterlegt.</p>';
    return;
  }
  const byStation = new Map();
  dash.vehicles.forEach((v) => {
    const key = v.station_name || 'Ohne Wache';
    byStation.set(key, (byStation.get(key) || 0) + 1);
  });
  const ul = document.createElement('ul');
  ul.className = 'plain-list';
  Array.from(byStation.entries())
    .sort((a, b) => a[0].localeCompare(b[0], 'de'))
    .forEach(([station, count]) => {
      const li = document.createElement('li');
      li.textContent = `${station}: ${count} Fahrzeug${count === 1 ? '' : 'e'}`;
      ul.appendChild(li);
    });
  container.innerHTML = '';
  container.appendChild(ul);
  const total = document.createElement('p');
  total.className = 'muted';
  total.textContent = `Gesamt: ${dash.vehicles.length} Fahrzeuge`;
  container.appendChild(total);
}

function renderFaelligePruefungenWidget(container) {
  const inThirtyDays = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const relevant = dash.allObjects
    .filter((o) => o.next_review_at && new Date(o.next_review_at).getTime() < inThirtyDays)
    .sort((a, b) => new Date(a.next_review_at) - new Date(b.next_review_at))
    .slice(0, 8);

  if (relevant.length === 0) {
    container.innerHTML = '<p class="muted">Keine Überprüfungen in den nächsten 30 Tagen fällig.</p>';
    return;
  }
  const ul = document.createElement('ul');
  ul.className = 'plain-list weather-item-list';
  relevant.forEach((o) => {
    const li = document.createElement('li');
    li.addEventListener('click', () => {
      window.location.href = `objekt-detail.html?id=${o.id}`;
    });
    li.style.cursor = 'pointer';
    const main = document.createElement('div');
    main.className = 'item-main';
    main.textContent = o.name;
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    const overdue = isOverdueLocal(o);
    meta.textContent = `${overdue ? 'ÜBERFÄLLIG seit' : 'fällig'} ${formatTimestamp(o.next_review_at)}`;
    if (overdue) meta.style.color = 'var(--danger)';
    li.appendChild(main);
    li.appendChild(meta);
    ul.appendChild(li);
  });
  container.innerHTML = '';
  container.appendChild(ul);
}

function renderUhrWidget(container, widget) {
  const time = document.createElement('div');
  time.className = 'widget-clock-time';
  const date = document.createElement('div');
  date.className = 'muted widget-clock-date';
  container.innerHTML = '';
  container.appendChild(time);
  container.appendChild(date);

  const update = () => {
    const now = new Date();
    time.textContent = now.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
    date.textContent = now.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });
  };
  update();
  dash.timers.push(setInterval(update, 30000));
}

function renderNotizWidget(container, widget) {
  const textarea = document.createElement('textarea');
  textarea.className = 'widget-note-textarea';
  textarea.rows = 4;
  textarea.placeholder = 'Notiz für alle Nutzer dieses Dashboards (z. B. aktueller Sammelpunkt) …';
  textarea.value = widget.config?.text || '';
  textarea.maxLength = 1000;
  let debounceTimer = null;
  textarea.addEventListener('input', () => {
    widget.config = { ...(widget.config || {}), text: textarea.value };
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(persistWidgets, 600);
  });
  container.appendChild(textarea);
}

function renderLinksWidget(container, widget) {
  const links = widget.config?.links || [];

  const list = document.createElement('ul');
  list.className = 'plain-list widget-links-list';
  links.forEach((link, index) => {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = link.url;
    a.target = '_blank';
    a.rel = 'noopener';
    a.textContent = link.label || link.url;
    li.appendChild(a);
    const removeBtn = iconButton('✕', 'Link entfernen', () => {
      const newLinks = links.filter((_, i) => i !== index);
      widget.config = { ...(widget.config || {}), links: newLinks };
      persistWidgets();
      renderLinksWidget(container, widget);
    });
    li.appendChild(removeBtn);
    list.appendChild(li);
  });
  container.innerHTML = '';
  container.appendChild(list);

  const form = document.createElement('form');
  form.className = 'widget-links-form';
  form.innerHTML = `
    <input type="text" class="widget-links-label" placeholder="Bezeichnung" maxlength="60" required />
    <input type="url" class="widget-links-url" placeholder="https://…" maxlength="500" required />
    <button type="submit" class="widget-icon-button" aria-label="Link hinzufügen">+</button>
  `;
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const label = form.querySelector('.widget-links-label').value.trim();
    const url = form.querySelector('.widget-links-url').value.trim();
    if (!label || !url) return;
    widget.config = { ...(widget.config || {}), links: [...links, { label, url }] };
    persistWidgets();
    renderLinksWidget(container, widget);
  });
  container.appendChild(form);
}

// Ein-Zeilen-Ampel ueber alle Datenquellen: pro Quelle die hoechste aktuell im Gebiet vorkommende
// Dringlichkeit als farbiger Punkt (dieselbe SEVERITY_COLORS-Skala wie die Karte, siehe severity.js).
const STATUS_ZEILE_SOURCES = [
  'dwd_unwetter',
  'bbk_warnung',
  'hochwasserzentralen',
  'pegelonline',
  'waldbrandindex',
  'firms',
  'blitzortung',
  'kachelmann',
];

function renderStatusZeileWidget(container) {
  const row = document.createElement('div');
  row.className = 'widget-status-row';
  STATUS_ZEILE_SOURCES.forEach((sourceKey) => {
    const items = dash.datapoints.filter((dp) => dp.source === sourceKey);
    const maxScore = items.reduce((max, dp) => Math.max(max, severityScore(dp)), 0);
    const dot = document.createElement('span');
    dot.className = 'widget-status-dot';
    dot.style.background = SEVERITY_COLORS[Math.min(maxScore, 4)];
    const chip = document.createElement('span');
    chip.className = 'widget-status-chip';
    chip.appendChild(dot);
    chip.append(SOURCE_LABELS[sourceKey] || sourceKey);
    row.appendChild(chip);
  });
  container.innerHTML = '';
  container.appendChild(row);
}

// --- Raster (gridstack.js) -----------------------------------------------------------------------

function buildWidgetCardElement(widget, catalogEntry) {
  const el = document.createElement('div');
  el.className = 'grid-stack-item';
  el.dataset.widgetId = widget.id;

  const content = document.createElement('div');
  content.className = 'grid-stack-item-content widget-card';

  const header = document.createElement('div');
  header.className = 'widget-card-header';

  const dragHandle = document.createElement('span');
  dragHandle.className = 'widget-drag-handle';
  dragHandle.setAttribute('aria-hidden', 'true');
  dragHandle.title = 'Ziehen zum Verschieben';
  dragHandle.textContent = '⠿';
  header.appendChild(dragHandle);

  const title = document.createElement('h3');
  title.className = 'widget-card-title';
  title.textContent = `${catalogEntry.icon} ${widget.config?.title || catalogEntry.label}`;
  header.appendChild(title);

  const controls = document.createElement('div');
  controls.className = 'widget-card-controls';
  controls.appendChild(iconButton('✕', 'Widget entfernen', () => removeWidget(widget.id)));
  header.appendChild(controls);

  content.appendChild(header);

  const body = document.createElement('div');
  body.className = 'widget-card-body';
  content.appendChild(body);

  el.appendChild(content);
  return { el, body };
}

function renderWidgetContent(widget, body) {
  switch (widget.type) {
    case 'karte':
      renderKarteWidget(body, widget);
      break;
    case 'prioritaet':
      renderPrioritaetWidget(body);
      break;
    case 'objekte':
      renderObjekteWidget(body);
      break;
    case 'dwd-bild':
      renderDwdBildWidget(body);
      break;
    case 'pegel-chart':
      renderPegelChartWidget(body, widget);
      break;
    case 'waldbrand-trend':
      renderWaldbrandTrendWidget(body, widget);
      break;
    case 'firms-map':
      renderFirmsMapWidget(body, widget);
      break;
    case 'wetter-vorhersage':
      renderWetterVorhersageWidget(body);
      break;
    case 'blitz-zaehler':
      renderBlitzZaehlerWidget(body);
      break;
    case 'fahrzeugstatus':
      renderFahrzeugstatusWidget(body);
      break;
    case 'faellige-pruefungen':
      renderFaelligePruefungenWidget(body);
      break;
    case 'bbk-feed':
      renderBbkFeedWidget(body);
      break;
    case 'kachelmann-wetter':
      renderKachelmannWetterWidget(body);
      break;
    case 'uhr':
      renderUhrWidget(body, widget);
      break;
    case 'notiz':
      renderNotizWidget(body, widget);
      break;
    case 'links':
      renderLinksWidget(body, widget);
      break;
    case 'hochwasser-liste':
      renderHochwasserListeWidget(body);
      break;
    case 'unwetter-ticker':
      renderUnwetterTickerWidget(body);
      break;
    case 'status-zeile':
      renderStatusZeileWidget(body);
      break;
    default:
      body.textContent = 'Unbekannter Widget-Typ.';
  }
}

function initGrid() {
  if (dash.grid) {
    dash.grid.destroy(false);
    dash.grid = null;
  }
  dash.timers.forEach((id) => clearInterval(id));
  dash.timers = [];
  dash.leafletMaps = {};

  const gridEl = document.getElementById('dashboard-grid');
  gridEl.innerHTML = '';

  dash.grid = GridStack.init(
    {
      column: GRID_COLUMNS,
      cellHeight: 90,
      margin: 8,
      float: true,
      animate: true,
      handle: '.widget-drag-handle',
      alwaysShowResizeHandle: 'mobile',
      columnOpts: { breakpoints: [{ w: 700, c: 1 }] },
    },
    gridEl
  );

  dash.grid.on('change', syncPositionsAndSave);
  dash.grid.on('resizestop', (event, el) => {
    const widgetId = el?.dataset?.widgetId;
    const map = widgetId ? dash.leafletMaps[widgetId] : null;
    if (map) setTimeout(() => map.invalidateSize(), 50);
  });
}

function renderWidgets() {
  initGrid();

  dash.widgets.forEach((widget) => {
    const catalogEntry = WIDGET_CATALOG[widget.type];
    if (!catalogEntry) return;

    const { el, body } = buildWidgetCardElement(widget, catalogEntry);
    const options = {
      id: widget.id,
      w: widget.w || catalogEntry.w,
      h: widget.h || catalogEntry.h,
      minW: catalogEntry.minW,
      minH: catalogEntry.minH,
    };
    if (Number.isFinite(widget.x) && Number.isFinite(widget.y)) {
      options.x = widget.x;
      options.y = widget.y;
    }
    dash.grid.addWidget(el, options);
    renderWidgetContent(widget, body);
  });

  // Positionen, die gridstack beim Auto-Platzieren neuer/migrierter Widgets vergeben hat, direkt
  // uebernehmen - ohne diesen Sync wuerde ein Widget ohne gespeicherte x/y beim naechsten Laden
  // erneut (ggf. anders) auto-platziert statt an der einmal gefundenen Stelle zu bleiben.
  syncPositionsAndSave();
}

// --- "Widget hinzufügen"-Dialog -------------------------------------------------------------------

function availableWidgetTypes() {
  const present = new Set(dash.widgets.map((w) => w.type));
  return Object.entries(WIDGET_CATALOG).filter(([type, entry]) => !entry.singleton || !present.has(type));
}

// Laedt (einmalig, gecacht in dash[cacheKey]) die aktuellen Stationen einer Quelle in ein <select> -
// gemeinsame Logik fuer den Pegel- und den Waldbrand-Stationsauswahl-Schritt im "Widget
// hinzufügen"-Dialog (beide brauchen einen externalId, um ein Verlaufs-Widget zu erzeugen).
async function loadStationOptions(sourceKey, selectEl, rowEl, cacheKey) {
  if (selectEl.dataset.loaded === 'true') return;
  try {
    const stations = await api.get(`/datapoints?source=${sourceKey}`);
    dash[cacheKey] = stations;
    selectEl.innerHTML = stations.map((s) => `<option value="${s.external_id}">${s.title}</option>`).join('');
    selectEl.dataset.loaded = 'true';
  } catch (err) {
    selectEl.innerHTML = '';
    rowEl.querySelector('span').textContent = `${rowEl.querySelector('span').textContent} (kein Zugriff oder keine Daten)`;
  }
}

async function openAddWidgetDialog() {
  const typeSelect = document.getElementById('widget-add-type');
  const pegelRow = document.getElementById('widget-add-pegel-row');
  const pegelSelect = document.getElementById('widget-add-pegel-station');
  const waldbrandRow = document.getElementById('widget-add-waldbrand-row');
  const waldbrandSelect = document.getElementById('widget-add-waldbrand-station');
  const errorEl = document.getElementById('widget-add-error');
  errorEl.textContent = '';

  const options = availableWidgetTypes();
  typeSelect.innerHTML = options.map(([type, entry]) => `<option value="${type}">${entry.icon} ${entry.label}</option>`).join('');

  const updateStationRowVisibility = () => {
    pegelRow.hidden = typeSelect.value !== 'pegel-chart';
    waldbrandRow.hidden = typeSelect.value !== 'waldbrand-trend';
  };
  typeSelect.onchange = updateStationRowVisibility;
  updateStationRowVisibility();

  await loadStationOptions('pegelonline', pegelSelect, pegelRow, 'pegelStations');
  await loadStationOptions('waldbrandindex', waldbrandSelect, waldbrandRow, 'waldbrandStations');

  document.getElementById('widget-add-dialog').showModal();
}

function initAddWidgetDialog() {
  const dialog = document.getElementById('widget-add-dialog');
  const form = document.getElementById('widget-add-form');
  const cancelBtn = document.getElementById('widget-add-cancel');
  const errorEl = document.getElementById('widget-add-error');

  cancelBtn.addEventListener('click', () => dialog.close());

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const type = document.getElementById('widget-add-type').value;
    const catalogEntry = WIDGET_CATALOG[type];
    if (!catalogEntry) return;

    if (type === 'pegel-chart' || type === 'waldbrand-trend') {
      const isWaldbrand = type === 'waldbrand-trend';
      const select = document.getElementById(isWaldbrand ? 'widget-add-waldbrand-station' : 'widget-add-pegel-station');
      const stations = isWaldbrand ? dash.waldbrandStations : dash.pegelStations;
      const externalId = select.value;
      if (!externalId) {
        errorEl.textContent = `Keine ${isWaldbrand ? 'Waldbrand-Station' : 'Pegel-Station'} verfügbar.`;
        return;
      }
      const station = stations.find((s) => s.external_id === externalId);
      dash.widgets.push({
        id: `${type}-${externalId}-${Date.now()}`,
        type,
        config: { externalId, title: station ? station.title : (isWaldbrand ? 'Waldbrand' : 'Pegel') },
      });
    } else {
      dash.widgets.push({ id: `${type}-${Date.now()}`, type });
    }

    renderWidgets();
    dialog.close();
  });
}

async function initDashboard() {
  const user = await initHeader();
  if (!user) return;

  try {
    dash.wehr = await api.get('/wehr');
  } catch (err) {
    dash.wehr = null;
  }
  try {
    dash.allObjects = await api.get('/objects');
  } catch (err) {
    dash.allObjects = [];
  }
  try {
    dash.vehicles = await api.get('/vehicles');
  } catch (err) {
    dash.vehicles = [];
  }
  try {
    dash.datapoints = await api.get('/datapoints');
  } catch (err) {
    dash.datapoints = [];
  }

  await loadLayout();
  renderWidgets();

  document.getElementById('dashboard-reset-button').addEventListener('click', resetLayout);
  document.getElementById('widget-add-button').addEventListener('click', openAddWidgetDialog);
  initAddWidgetDialog();
}

document.addEventListener('DOMContentLoaded', initDashboard);
