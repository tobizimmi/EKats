// Objekt-Detailseite (Konzept Teil 2, Baustein B): eigenständige, tiefe Ansicht aller kritischen
// Objekte - filterbare/durchsuchbare Tabelle mit frei wählbaren Spalten (inkl. wehr-eigener
// Zusatzfelder), "Muss überprüft werden"-Ansicht, Massenbearbeitung und Sammel-PDF-Export. Anlegen
// und Bearbeiten mit Kartenposition bleibt bewusst ausschließlich auf der Karte (index.html) - diese
// Seite ergänzt, ersetzt nicht.

const OBJECT_CATEGORY_LABELS = {
  schule_kita: 'Schule/Kita',
  krankenhaus_pflege: 'Krankenhaus/Pflegeeinrichtung',
  industrie_gefahrstoff: 'Industrie/Gefahrstoffbetrieb',
  versammlungsstaette: 'Versammlungsstätte',
  sonstiges: 'Sonstiges',
};

const FIRE_WATER_SUPPLY_LABELS = {
  hydrant_unterflur: 'Hydrant (Unterflur)',
  hydrant_ueberflur: 'Hydrant (Überflur)',
  loeschwasserbrunnen: 'Löschwasserbrunnen',
  zisterne: 'Zisterne',
  loeschteich: 'Löschteich',
  offenes_gewaesser: 'Offenes Gewässer',
  keine_angabe: 'Keine Angabe',
};

function boolLabel(v) {
  if (v === null || v === undefined) return '–';
  return v ? 'ja' : 'nein';
}

function isOverdue(obj) {
  return !!obj.next_review_at && new Date(obj.next_review_at).getTime() < Date.now();
}

let objektePage = {
  table: null,
  allObjects: [],
  fieldDefinitions: [],
  overdueOnly: false,
  map: null,
};

function baseColumns() {
  return [
    { key: 'name', label: 'Name', default: true, get: (o) => o.name },
    {
      key: 'preview',
      label: 'Karte',
      default: true,
      get: () => '',
      mount: (td, o) => renderObjectMiniMap(td, o),
    },
    { key: 'category', label: 'Kategorie', default: true, get: (o) => OBJECT_CATEGORY_LABELS[o.category] || o.category },
    { key: 'address', label: 'Adresse', default: true, get: (o) => o.address || '–' },
    {
      key: 'nextReview',
      label: 'Fälligkeit',
      default: true,
      get: (o) => (o.next_review_at ? `${formatTimestamp(o.next_review_at)}${isOverdue(o) ? ' (ÜBERFÄLLIG)' : ''}` : '–'),
    },
    { key: 'reviewInterval', label: 'Turnus (Monate)', default: false, get: (o) => o.review_interval_months ?? '–' },
    { key: 'lastReviewed', label: 'Zuletzt überprüft', default: false, get: (o) => formatTimestamp(o.last_reviewed_at) },
    { key: 'contactName', label: 'Ansprechpartner', default: false, get: (o) => o.contact_name || '–' },
    { key: 'contactPhone', label: 'Telefon', default: false, get: (o) => o.contact_phone || '–' },
    {
      key: 'fireWaterSupplyType',
      label: 'Löschwasserversorgung',
      default: false,
      get: (o) => FIRE_WATER_SUPPLY_LABELS[o.fire_water_supply_type] || '–',
    },
    { key: 'fireAlarmSystem', label: 'Brandmeldeanlage', default: false, get: (o) => boolLabel(o.fire_alarm_system) },
    { key: 'occupantCountMax', label: 'Max. Personenzahl', default: false, get: (o) => o.occupant_count_max ?? '–' },
    { key: 'elevators', label: 'Aufzüge', default: false, get: (o) => boolLabel(o.elevators) },
    { key: 'pvBatterySystem', label: 'PV-/Batteriespeicher', default: false, get: (o) => boolLabel(o.pv_battery_system) },
    { key: 'assemblyPoint', label: 'Sammelplatz', default: false, get: (o) => o.assembly_point || '–' },
    { key: 'builtYear', label: 'Baujahr', default: false, get: (o) => o.built_year ?? '–' },
  ];
}

function customFieldColumns(definitions) {
  return definitions.map((def) => ({
    key: `custom:${def.key}`,
    label: def.label,
    default: false,
    get: (o) => {
      const value = o.custom_fields ? o.custom_fields[def.key] : undefined;
      if (value === undefined || value === null || value === '') return '–';
      if (def.field_type === 'boolean') return boolLabel(value);
      if (def.field_type === 'select') {
        const opt = (def.options || []).find((x) => x.value === value);
        return opt ? opt.label : value;
      }
      return String(value);
    },
  }));
}

// Kleine, nicht-interaktive Leaflet-Karte je Zeile - dieselbe Idee wie die (in Task 126 folgende)
// Kartenskizzen-Vorschau, hier zunaechst nur mit Positions-Marker ohne Skizzen-Overlay.
function renderObjectMiniMap(td, obj) {
  td.classList.add('object-minimap-cell');
  if (obj.lat === null || obj.lon === null || obj.lat === undefined || obj.lon === undefined) {
    td.textContent = '–';
    return;
  }
  const mapEl = document.createElement('div');
  mapEl.className = 'object-minimap';
  td.appendChild(mapEl);

  const miniMap = L.map(mapEl, {
    attributionControl: false,
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    touchZoom: false,
    boxZoom: false,
    keyboard: false,
  }).setView([obj.lat, obj.lon], 15);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(miniMap);
  L.circleMarker([obj.lat, obj.lon], { radius: 6, color: '#b3261e', fillColor: '#b3261e', fillOpacity: 0.9 }).addTo(miniMap);
  // Innerhalb einer zu dem Zeitpunkt noch layoutlosen Zelle initialisiert Leaflet mit falscher
  // Groesse - invalidateSize() nach dem naechsten Layout-Tick korrigiert das zuverlaessig.
  setTimeout(() => miniMap.invalidateSize(), 0);
}

function applyOverdueFilter(objects) {
  return objektePage.overdueOnly ? objects.filter(isOverdue) : objects;
}

async function loadObjects() {
  objektePage.allObjects = await api.get('/objects');
  objektePage.table.setData(applyOverdueFilter(objektePage.allObjects));
  if (objektePage.map) renderObjekteMapMarkers();
}

// ---------------------------------------------------------------------------
// Optionale Karte neben der Tabelle (Nutzerwunsch) - rein zur Orientierung/Navigation, das
// eigentliche Anlegen/Bearbeiten mit Kartenposition bleibt bewusst auf index.html (siehe
// Datei-Kopfkommentar). Wird erst beim ersten Einblenden initialisiert, weil Leaflet einen bereits
// sichtbaren, korrekt bemessenen Container braucht (sonst falsche Kachel-Ausrichtung).
function objekteMapMarkerIcon(id) {
  return L.divIcon({
    className: 'object-marker',
    html: `<div class="object-marker-inner">${id}</div>`,
    iconSize: [24, 20],
    iconAnchor: [12, 10],
  });
}

function renderObjekteMapMarkers() {
  objektePage.map.markersLayer.clearLayers();
  const withCoords = applyOverdueFilter(objektePage.allObjects).filter((o) => o.lat !== null && o.lon !== null);
  withCoords.forEach((obj) => {
    const marker = L.marker([obj.lat, obj.lon], { icon: objekteMapMarkerIcon(obj.id) });
    marker.bindTooltip(`#${obj.id} · ${obj.name}`);
    marker.on('click', () => openDetailDialog(obj));
    marker.addTo(objektePage.map.markersLayer);
  });
  if (withCoords.length > 0) {
    objektePage.map.instance.fitBounds(L.latLngBounds(withCoords.map((o) => [o.lat, o.lon])).pad(0.15));
  }
}

function toggleObjekteMap() {
  const container = document.getElementById('objekte-map');
  const button = document.getElementById('objekte-map-toggle');
  const showing = container.hidden;
  container.hidden = !showing;
  button.textContent = showing ? 'Karte ausblenden' : 'Karte anzeigen';
  if (!showing) return;

  if (!objektePage.map) {
    const instance = L.map(container).setView([51.1657, 10.4515], 6);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende',
    }).addTo(instance);
    objektePage.map = { instance, markersLayer: L.layerGroup().addTo(instance) };
  }
  // invalidateSize: der Container war beim urspruenglichen L.map()-Aufruf ggf. noch hidden
  // (Groesse 0x0) - ohne diesen Aufruf bleibt die Karte bis zum naechsten Browser-Resize verzerrt.
  requestAnimationFrame(() => objektePage.map.instance.invalidateSize());
  renderObjekteMapMarkers();
}

// Baut einen Themenblock wie im Objekt-Formular (js/objects.js) - Label/Wert-Raster mit
// Abschnitts-Ueberschrift, aber read-only. Felder mit Wert "–" werden trotzdem angezeigt (Konsistenz
// mit dem Formular, das dieselben Felder zeigt), damit das Fehlen einer Angabe sichtbar ist statt der
// Block bei einem leeren Pflichtfeld einfach zu verschwinden.
function detailSection(title, fields) {
  const section = document.createElement('div');
  section.className = 'dialog-section';
  const heading = document.createElement('h4');
  heading.className = 'dialog-section-title';
  heading.textContent = title;
  section.appendChild(heading);
  const grid = document.createElement('div');
  grid.className = 'detail-grid';
  fields.forEach(([label, value]) => {
    const field = document.createElement('div');
    const labelEl = document.createElement('div');
    labelEl.className = 'detail-field-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'detail-field-value';
    if (value instanceof Node) {
      valueEl.appendChild(value);
    } else {
      valueEl.textContent = value ?? '–';
    }
    field.appendChild(labelEl);
    field.appendChild(valueEl);
    grid.appendChild(field);
  });
  section.appendChild(grid);
  return section;
}

function yesNoBadge(value) {
  const span = document.createElement('span');
  span.className = `badge ${value ? 'badge-yes' : 'badge-no'}`;
  span.textContent = value ? 'Ja' : 'Nein';
  return span;
}

function openDetailDialog(obj) {
  const dialog = document.getElementById('objekte-detail-dialog');
  document.getElementById('objekte-detail-title').textContent = `#${obj.id} · ${obj.name}`;
  const container = document.getElementById('objekte-detail-content');
  container.innerHTML = '';

  const addressLine = [obj.street, obj.house_number].filter(Boolean).join(' ');
  const cityLine = [obj.postal_code, obj.city].filter(Boolean).join(' ');

  container.appendChild(
    detailSection('Stammdaten', [
      ['Anschrift', [addressLine, cityLine].filter(Boolean).join(', ') || obj.address],
      ['Ortsteil', obj.district],
      ['Objekttyp', OBJECT_CATEGORY_LABELS[obj.category] || obj.category],
    ])
  );

  container.appendChild(
    detailSection('Ansprechpartner', [
      ['Name', obj.contact_name],
      ['Telefon', obj.contact_phone],
      ['E-Mail', obj.contact_email],
      ['Notfalltelefon', obj.emergency_phone],
    ])
  );

  container.appendChild(
    detailSection('Planstatus', [
      ['Offizieller Einsatzplan', yesNoBadge(obj.has_official_plan)],
      ['FW-eigener Plan', yesNoBadge(obj.has_fw_plan)],
      ['Plandatum', obj.plan_date ? new Date(obj.plan_date).toLocaleDateString('de-DE') : null],
      ['Planersteller', obj.plan_creator],
    ])
  );

  container.appendChild(
    detailSection('Gebäudedaten', [
      ['Baujahr', obj.built_year],
      ['Etagen/Stockwerke', obj.floors],
      ['Fläche', obj.area],
    ])
  );

  container.appendChild(
    detailSection('Besonderheiten & Gefahren', [
      ['Besonderheiten', obj.special_features],
      ['Besondere Gefahren', obj.hazards],
      ['Löschwasserversorgung', FIRE_WATER_SUPPLY_LABELS[obj.fire_water_supply_type]],
      ['Zufahrt/Schlüsseldepot', obj.access_info],
      ['Sammelplatz', obj.assembly_point],
    ])
  );

  container.appendChild(
    detailSection('Überprüfung', [
      [
        'Fälligkeit',
        obj.next_review_at ? `${formatTimestamp(obj.next_review_at)}${isOverdue(obj) ? ' (ÜBERFÄLLIG)' : ''}` : null,
      ],
    ])
  );

  document.getElementById('objekte-detail-map-link').href = `./?object=${obj.id}`;
  dialog.showModal();
}

function updateBulkBar(selectedRows) {
  const bar = document.getElementById('objekte-bulk-bar');
  const countEl = document.getElementById('objekte-bulk-count');
  bar.hidden = selectedRows.length === 0;
  countEl.textContent = `${selectedRows.length} ausgewählt`;
  bar._selectedRows = selectedRows;
}

async function applyBulkEdit() {
  const errorEl = document.getElementById('objekte-bulk-error');
  errorEl.textContent = '';
  const bar = document.getElementById('objekte-bulk-bar');
  const selected = bar._selectedRows || [];
  const interval = document.getElementById('objekte-bulk-interval').value;
  if (!interval || selected.length === 0) {
    errorEl.textContent = 'Bitte ein Intervall angeben und mindestens ein Objekt auswählen.';
    return;
  }
  try {
    await Promise.all(
      selected.map((obj) => api.patch(`/objects/${obj.id}`, { reviewIntervalMonths: Number(interval) }))
    );
    document.getElementById('objekte-bulk-interval').value = '';
    objektePage.table.selectedKeys.clear();
    await loadObjects();
    updateBulkBar([]);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// Erzeugt die Datenblatt-PDFs sequentiell (statt aller gleichzeitig) - vermeidet, dass der Browser
// viele parallele Downloads als Popup-Flut blockiert, und haelt die Serverlast durch die
// Chromium-Rendering-Pipeline (siehe backend/src/pdf/renderHtml.js) in Grenzen.
async function exportSelectedOrFilteredPdfs() {
  const selected = objektePage.table.getSelectedRows();
  const targets = selected.length > 0 ? selected : objektePage.table.filteredRows();
  if (targets.length === 0) {
    alert('Keine Objekte für den PDF-Export ausgewählt/gefiltert.');
    return;
  }
  if (!confirm(`Datenblätter für ${targets.length} Objekt(e) als einzelne PDFs herunterladen?`)) return;

  for (const obj of targets) {
    try {
      const res = await fetch(`api/objects/${obj.id}/datasheet/pdf`, { credentials: 'include' });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `objektdatenblatt-${obj.name.replace(/[^a-z0-9]+/gi, '_')}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      await new Promise((resolve) => setTimeout(resolve, 300));
    } catch (err) {
      console.error(`[objekte] PDF-Export fehlgeschlagen für "${obj.name}":`, err);
    }
  }
}

(async function bootstrapObjektePage() {
  const user = await initHeader();
  if (!user) return;
  registerServiceWorker();

  try {
    objektePage.fieldDefinitions = await api.get('/object-fields');
  } catch (err) {
    objektePage.fieldDefinitions = [];
  }

  objektePage.table = new DataTable({
    containerEl: document.getElementById('objekte-table-container'),
    prefKey: 'columns:objekte',
    columns: [...baseColumns(), ...customFieldColumns(objektePage.fieldDefinitions)],
    searchText: (o) => `${o.name} ${o.address || ''}`,
    rowKey: (o) => o.id,
    selectable: true,
    onSelectionChange: updateBulkBar,
    onRowClick: openDetailDialog,
  });
  await objektePage.table.init();

  document.getElementById('objekte-overdue-toggle').addEventListener('click', (event) => {
    objektePage.overdueOnly = !objektePage.overdueOnly;
    event.target.classList.toggle('primary', objektePage.overdueOnly);
    objektePage.table.setData(applyOverdueFilter(objektePage.allObjects));
    if (objektePage.map) renderObjekteMapMarkers();
  });
  document.getElementById('objekte-pdf-export').addEventListener('click', exportSelectedOrFilteredPdfs);
  document.getElementById('objekte-map-toggle').addEventListener('click', toggleObjekteMap);
  document.getElementById('objekte-bulk-apply').addEventListener('click', applyBulkEdit);
  document.getElementById('objekte-bulk-clear').addEventListener('click', () => {
    objektePage.table.selectedKeys.clear();
    objektePage.table.renderTable();
    updateBulkBar([]);
  });
  document.getElementById('objekte-detail-close').addEventListener('click', () => {
    document.getElementById('objekte-detail-dialog').close();
  });

  await loadObjects();
})();
