// Individuelles Dashboard (Konzept Teil 2, Baustein D): Baukasten aus Widgets, die bestehende
// Ansichten kapseln (Karte, Prioritaets-Leiste, Objekt-Uebersicht) plus zwei neue Widget-Typen
// (DWD-Wetterbild, Pegel-Liniendiagramm). Layout liegt in derselben user_preference-Tabelle wie die
// Spaltenwahl der Themenseiten (Migration 011, siehe js/data-table.js), unter dem Schluessel
// 'dashboard_layout' - Zuruecksetzen loescht einfach die Zeile, die Seite faellt auf
// DEFAULT_WIDGETS zurueck (kein serverseitiger Default noetig, gleiches Muster wie dort).

const DASHBOARD_PREF_KEY = 'dashboard_layout';

const DEFAULT_WIDGETS = [
  { id: 'karte', type: 'karte' },
  { id: 'prioritaet', type: 'prioritaet' },
  { id: 'objekte', type: 'objekte' },
  { id: 'dwd-bild', type: 'dwd-bild' },
];

// Singleton-Typen zeigen ohnehin die gesamte Wehr-Lage - ein zweites Exemplar waere nur eine Kopie,
// deshalb hoechstens einmal im Layout erlaubt. Pegel-Liniendiagramme sind bewusst mehrfach moeglich
// (ein Widget je beobachteter Station).
const WIDGET_CATALOG = {
  karte: { label: 'Karte', icon: '📍', singleton: true },
  prioritaet: { label: 'Prioritäts-Leiste', icon: '🚦', singleton: true },
  objekte: { label: 'Objekt-Übersicht', icon: '🏫', singleton: true },
  'dwd-bild': { label: 'DWD-Wetterbild', icon: '🌩️', singleton: true },
  'pegel-chart': { label: 'Pegel-Liniendiagramm', icon: '📈', singleton: false },
};

const dash = {
  widgets: [],
  wehr: null,
  allObjects: [],
  pegelStations: [],
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

function saveLayout() {
  api.put(`/user-preferences/${DASHBOARD_PREF_KEY}`, { value: { widgets: dash.widgets } }).catch((err) => {
    console.error('[dashboard] Layout konnte nicht gespeichert werden:', err);
  });
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

function moveWidget(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= dash.widgets.length) return;
  const [item] = dash.widgets.splice(index, 1);
  dash.widgets.splice(target, 0, item);
  saveLayout();
  renderWidgets();
}

function removeWidget(index) {
  dash.widgets.splice(index, 1);
  saveLayout();
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

function renderKarteWidget(container) {
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
  // Innerhalb einer zu dem Zeitpunkt noch layoutlosen Karte initialisiert Leaflet mit falscher
  // Groesse - invalidateSize() nach dem naechsten Layout-Tick korrigiert das zuverlaessig (dieselbe
  // Notwendigkeit wie bei der Objekt-Mini-Vorschau, siehe js/objekte-page.js).
  setTimeout(() => map.invalidateSize(), 0);

  const link = document.createElement('a');
  link.href = './';
  link.className = 'widget-link';
  link.textContent = 'Zur vollständigen Karte →';
  container.appendChild(link);
}

async function renderPrioritaetWidget(container) {
  container.innerHTML = '<p class="muted">Lade…</p>';
  let datapoints;
  try {
    datapoints = await api.get('/datapoints');
  } catch (err) {
    container.innerHTML = '<p class="error-message">Konnte nicht geladen werden.</p>';
    return;
  }

  const counts = { critical: 0, high: 0, medium: 0, ok: 0 };
  datapoints.forEach((dp) => {
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
// Verifikationsstand - in dieser Sandbox nicht renderbar pruefbar, da maps.dwd.de per
// Netzwerk-Firewall blockiert ist, wie alle DWD-Hosts in diesem Projekt).
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
    '&layers=dwd:bluemarble,dwd:Warngebiete_Kreise,dwd:Warnungen_Gemeinden_vereinigt' +
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

async function renderPegelChartWidget(container, widget) {
  const externalId = widget.config?.externalId;
  if (!externalId) {
    container.innerHTML = '<p class="muted">Keine Station ausgewählt.</p>';
    return;
  }
  container.innerHTML = '<p class="muted">Lade…</p>';
  let history;
  try {
    history = await api.get(`/datapoints/history?source=pegelonline&externalId=${encodeURIComponent(externalId)}`);
  } catch (err) {
    container.innerHTML = '<p class="error-message">Konnte nicht geladen werden.</p>';
    return;
  }

  const points = history.filter((h) => h.value_numeric !== null && h.value_numeric !== undefined);
  if (points.length < 2) {
    container.innerHTML =
      '<p class="muted">Noch nicht genug Verlaufsdaten (sammelt sich mit jedem Abruf, alle 15 Min. - Rückblick 14 Tage).</p>';
    return;
  }

  const values = points.map((p) => p.value_numeric);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 220;
  const h = 70;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p.value_numeric - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1];
  const lastCoord = coords[coords.length - 1].split(',');

  container.innerHTML = `
    <svg class="widget-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="Pegelverlauf der letzten 14 Tage, aktueller Wert ${last.value_numeric} ${last.unit || ''}">
      <polyline points="${coords.join(' ')}" fill="none" stroke="var(--focus)" stroke-width="2" />
      <circle cx="${lastCoord[0]}" cy="${lastCoord[1]}" r="3" fill="var(--focus)" />
    </svg>
    <p class="muted widget-chart-caption">Aktuell: ${last.value_numeric} ${last.unit || ''} · Verlauf 14 Tage (min ${min}, max ${max})</p>
  `;
}

// --- Layout-Rendering ----------------------------------------------------------------------------

function renderWidgets() {
  const grid = document.getElementById('dashboard-grid');
  grid.innerHTML = '';

  dash.widgets.forEach((widget, index) => {
    const catalogEntry = WIDGET_CATALOG[widget.type];
    if (!catalogEntry) return;

    const card = document.createElement('div');
    card.className = 'widget-card';
    card.draggable = true;

    const header = document.createElement('div');
    header.className = 'widget-card-header';
    const title = document.createElement('h3');
    title.className = 'widget-card-title';
    title.textContent = `${catalogEntry.icon} ${widget.config?.title || catalogEntry.label}`;
    header.appendChild(title);

    const controls = document.createElement('div');
    controls.className = 'widget-card-controls';
    const upBtn = iconButton('↑', 'Nach oben verschieben', () => moveWidget(index, -1));
    upBtn.disabled = index === 0;
    const downBtn = iconButton('↓', 'Nach unten verschieben', () => moveWidget(index, 1));
    downBtn.disabled = index === dash.widgets.length - 1;
    const removeBtn = iconButton('✕', 'Widget entfernen', () => removeWidget(index));
    controls.append(upBtn, downBtn, removeBtn);
    header.appendChild(controls);
    card.appendChild(header);

    const body = document.createElement('div');
    body.className = 'widget-card-body';
    card.appendChild(body);

    // Reorder per natives HTML5-Drag-and-Drop (Desktop) - die Auf/Ab-Buttons oben sind der
    // Tastatur-/Touch-Fallback fuer alle, die keinen Drag-Vorgang ausloesen koennen oder wollen.
    card.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(index));
      card.classList.add('dragging');
    });
    card.addEventListener('dragend', () => card.classList.remove('dragging'));
    card.addEventListener('dragover', (e) => e.preventDefault());
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      const fromIndex = Number(e.dataTransfer.getData('text/plain'));
      if (Number.isNaN(fromIndex) || fromIndex === index) return;
      const [item] = dash.widgets.splice(fromIndex, 1);
      dash.widgets.splice(index, 0, item);
      saveLayout();
      renderWidgets();
    });

    grid.appendChild(card);

    switch (widget.type) {
      case 'karte':
        renderKarteWidget(body);
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
      default:
        body.textContent = 'Unbekannter Widget-Typ.';
    }
  });

  const addCard = document.createElement('button');
  addCard.type = 'button';
  addCard.className = 'widget-card widget-add-card';
  addCard.textContent = '+ Widget hinzufügen';
  addCard.addEventListener('click', openAddWidgetDialog);
  grid.appendChild(addCard);
}

// --- "Widget hinzufügen"-Dialog -------------------------------------------------------------------

function availableWidgetTypes() {
  const present = new Set(dash.widgets.map((w) => w.type));
  return Object.entries(WIDGET_CATALOG).filter(([type, entry]) => !entry.singleton || !present.has(type));
}

async function openAddWidgetDialog() {
  const typeSelect = document.getElementById('widget-add-type');
  const pegelRow = document.getElementById('widget-add-pegel-row');
  const pegelSelect = document.getElementById('widget-add-pegel-station');
  const errorEl = document.getElementById('widget-add-error');
  errorEl.textContent = '';

  const options = availableWidgetTypes();
  typeSelect.innerHTML = options.map(([type, entry]) => `<option value="${type}">${entry.icon} ${entry.label}</option>`).join('');

  const updatePegelVisibility = () => {
    pegelRow.hidden = typeSelect.value !== 'pegel-chart';
  };
  typeSelect.onchange = updatePegelVisibility;
  updatePegelVisibility();

  if (pegelSelect.dataset.loaded !== 'true') {
    try {
      const stations = await api.get('/datapoints?source=pegelonline');
      dash.pegelStations = stations;
      pegelSelect.innerHTML = stations
        .map((s) => `<option value="${s.external_id}">${s.title}</option>`)
        .join('');
      pegelSelect.dataset.loaded = 'true';
    } catch (err) {
      pegelSelect.innerHTML = '';
      pegelRow.querySelector('span').textContent = 'Pegel-Station (kein Zugriff oder keine Daten)';
    }
  }

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

    if (type === 'pegel-chart') {
      const pegelSelect = document.getElementById('widget-add-pegel-station');
      const externalId = pegelSelect.value;
      if (!externalId) {
        errorEl.textContent = 'Keine Pegel-Station verfügbar.';
        return;
      }
      const station = dash.pegelStations.find((s) => s.external_id === externalId);
      dash.widgets.push({
        id: `pegel-${externalId}-${Date.now()}`,
        type,
        config: { externalId, title: station ? station.title : 'Pegel' },
      });
    } else {
      dash.widgets.push({ id: `${type}-${Date.now()}`, type });
    }

    saveLayout();
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

  await loadLayout();
  renderWidgets();

  document.getElementById('dashboard-reset-button').addEventListener('click', resetLayout);
  initAddWidgetDialog();
}

document.addEventListener('DOMContentLoaded', initDashboard);
