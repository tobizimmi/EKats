// Eigenständige Objekt-Detailseite (Nutzerwunsch, Vorbild: Detailansicht des ursprünglichen lokalen
// Feuerwehr-Objektverwaltungstools) - ersetzt den bisherigen Dialog auf objekte.html durch eine
// navigierbare Seite mit eigener URL (?id=<objectId>), Kopfbereich mit Aktions-Buttons und
// zweispaltigem Layout (Themenblöcke links, Karte+Metadaten rechts). Es gibt keinen
// Einzelobjekt-GET-Endpunkt - die Wehr-weite Objektliste ist ohnehin klein, daher wird sie komplett
// geladen und das gesuchte Objekt clientseitig herausgefiltert (gleiches Muster wie objekte-page.js).

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

function isOverdue(obj) {
  return !!obj.next_review_at && new Date(obj.next_review_at).getTime() < Date.now();
}

// Baut einen Themenblock wie im Objekt-Formular (js/objects.js) - Label/Wert-Raster mit
// Abschnitts-Überschrift, aber read-only. Felder mit Wert "–" werden trotzdem angezeigt, damit das
// Fehlen einer Angabe sichtbar ist statt der Block bei einem leeren Pflichtfeld einfach zu
// verschwinden.
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

// Formatiert einen Zusatzfeld-Wert passend zum field_type fuer die schreibgeschuetzte Anzeige -
// gleiche Typliste wie loadCustomFieldsForDialog() in js/objects.js, hier aber nur lesend.
function formatCustomFieldValue(def, value) {
  if (def.field_type === 'boolean') {
    return yesNoBadge(!!value);
  }
  if (value === undefined || value === null || value === '') {
    return null;
  }
  if (def.field_type === 'date') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? value : d.toLocaleDateString('de-DE');
  }
  if (def.field_type === 'select') {
    const opt = (def.options || []).find((o) => o.value === value);
    return opt ? opt.label : value;
  }
  return value;
}

function renderObjektDetail(obj, customFieldDefs) {
  document.getElementById('objekt-detail-title').textContent = obj.name;
  document.getElementById('objekt-detail-subtitle').textContent =
    `#${obj.id} · ${OBJECT_CATEGORY_LABELS[obj.category] || obj.category}${obj.city ? ' · ' + obj.city : ''}`;

  const container = document.getElementById('objekt-detail-sections');
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
    detailSection('Gebäude- und Anlagentechnik (DIN 14095)', [
      ['Löschwasserversorgung: Ergiebigkeit', obj.fire_water_supply_capacity_lpm ? `${obj.fire_water_supply_capacity_lpm} l/min` : null],
      ['Löschwasserversorgung: Lage/Standort', obj.fire_water_supply_location],
      ['Brandmeldeanlage vorhanden', yesNoBadge(obj.fire_alarm_system)],
      ['Aufschaltstelle der Brandmeldeanlage', obj.fire_alarm_monitoring_station],
      ['Max. Personenzahl', obj.occupant_count_max],
      ['Aufzüge vorhanden', yesNoBadge(obj.elevators)],
      ['Rauch-/Wärmeabzugsanlage vorhanden', yesNoBadge(obj.smoke_heat_exhaust_system)],
      ['PV-/Batteriespeicheranlage vorhanden', yesNoBadge(obj.pv_battery_system)],
      ['PV-/Batterie: Lage der Notabschaltung', obj.pv_battery_disconnect_location],
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
  if (obj.notes) {
    container.appendChild(detailSection('Notizen', [['Sonstige Hinweise', obj.notes]]));
  }
  if (customFieldDefs && customFieldDefs.length > 0) {
    const values = obj.custom_fields || {};
    container.appendChild(
      detailSection(
        'Zusatzfelder',
        customFieldDefs.map((def) => [def.label, formatCustomFieldValue(def, values[def.key])])
      )
    );
  }

  document.getElementById('objekt-detail-meta').innerHTML = '';
  const metaGrid = document.getElementById('objekt-detail-meta');
  [
    ['Erstellt am', formatTimestamp(obj.created_at)],
    ['Zuletzt geändert', formatTimestamp(obj.updated_at)],
  ].forEach(([label, value]) => {
    const labelEl = document.createElement('div');
    labelEl.className = 'detail-field-label';
    labelEl.textContent = label;
    const valueEl = document.createElement('div');
    valueEl.className = 'detail-field-value';
    valueEl.style.marginBottom = '0.6rem';
    valueEl.textContent = value;
    metaGrid.appendChild(labelEl);
    metaGrid.appendChild(valueEl);
  });

  document.getElementById('objekt-detail-pdf-link').href = `api/objects/${obj.id}/datasheet/pdf`;
  document.getElementById('objekt-detail-edit-link').href = `./?object=${obj.id}`;

  if (obj.lat !== null && obj.lon !== null) {
    const map = L.map('objekt-detail-map', { zoomControl: true }).setView([obj.lat, obj.lon], 16);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OpenStreetMap-Mitwirkende',
    }).addTo(map);
    L.marker([obj.lat, obj.lon]).addTo(map).bindPopup(`<strong>${obj.name}</strong><br>${obj.address || ''}`).openPopup();
    document.getElementById('objekt-detail-coords').textContent = `${obj.lat}, ${obj.lon}`;
  } else {
    document.getElementById('objekt-detail-map').textContent = 'Keine Koordinaten hinterlegt.';
    document.getElementById('objekt-detail-coords').textContent = '';
  }
}

async function deleteObjekt(objId) {
  if (!confirm('Dieses Objekt wirklich löschen? Aufgaben und Anhänge werden mitgelöscht.')) return;
  try {
    await api.delete(`/objects/${objId}`);
    window.location.href = 'objekte.html';
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Kartenskizze (js/object-sketch.js) - gleiches Vorgehen wie im Objekt-Dialog (js/objects.js),
// hier eigenstaendig nachgebildet, da diese Seite unabhaengig von index.html funktionieren muss.
// ---------------------------------------------------------------------------

let activeSketchEditor = null;

async function loadObjektSketch(obj) {
  const previewEl = document.getElementById('object-sketch-preview');
  const editBtn = document.getElementById('object-sketch-edit-button');
  document.getElementById('object-sketch-editor').hidden = true;
  previewEl.hidden = false;

  let sketchData = { geojson: null };
  try {
    sketchData = await api.get(`/objects/${obj.id}/sketch`);
  } catch (err) {
    // Vorschau bleibt leer, wenn das Laden fehlschlaegt - kein Blocker fuer den Rest der Seite.
  }
  renderObjectSketchPreview(previewEl, { lat: obj.lat, lon: obj.lon }, sketchData.geojson);
  editBtn.onclick = () => openObjektSketchEditor(obj, sketchData.geojson);
}

function openObjektSketchEditor(obj, initialGeoJson) {
  document.getElementById('object-sketch-preview').hidden = true;
  document.getElementById('object-sketch-edit-button').hidden = true;
  document.getElementById('object-sketch-editor').hidden = false;
  document.getElementById('object-sketch-error').textContent = '';

  activeSketchEditor = new ObjectSketchEditor({
    toolbarEl: document.getElementById('object-sketch-toolbar'),
    mapContainerEl: document.getElementById('object-sketch-map'),
    errorEl: document.getElementById('object-sketch-error'),
    objectId: obj.id,
    center: { lat: obj.lat, lon: obj.lon },
    initialGeoJson,
  });
}

function closeObjektSketchEditor() {
  if (activeSketchEditor) {
    activeSketchEditor.destroy();
    activeSketchEditor = null;
  }
  document.getElementById('object-sketch-editor').hidden = true;
  document.getElementById('object-sketch-preview').hidden = false;
  document.getElementById('object-sketch-edit-button').hidden = false;
}

async function saveObjektSketch() {
  if (!activeSketchEditor) return;
  const center = activeSketchEditor.center;
  const geojson = sketchLayersToGeoJson(activeSketchEditor.sketchLayers);
  const ok = await activeSketchEditor.save();
  if (!ok) return;
  closeObjektSketchEditor();
  renderObjectSketchPreview(document.getElementById('object-sketch-preview'), center, geojson);
}

(async function bootstrapObjektDetailPage() {
  const user = await initHeader();
  if (!user) return;
  registerServiceWorker();

  const objId = Number(new URLSearchParams(window.location.search).get('id'));
  const errorEl = document.getElementById('objekt-detail-error');
  if (!objId) {
    errorEl.textContent = 'Keine Objekt-ID angegeben.';
    return;
  }

  let obj;
  try {
    const objects = await api.get('/objects');
    obj = objects.find((o) => o.id === objId);
  } catch (err) {
    errorEl.textContent = err.message;
    return;
  }
  if (!obj) {
    errorEl.textContent = 'Objekt nicht gefunden.';
    return;
  }

  let customFieldDefs = [];
  try {
    customFieldDefs = await api.get('/object-fields');
  } catch (err) {
    customFieldDefs = [];
  }

  renderObjektDetail(obj, customFieldDefs);
  document.getElementById('objekt-detail-body').hidden = false;
  document.getElementById('objekt-detail-delete-button').addEventListener('click', () => deleteObjekt(obj.id));

  await loadObjektSketch(obj);
  document.getElementById('object-sketch-cancel-button').addEventListener('click', closeObjektSketchEditor);
  document.getElementById('object-sketch-save-button').addEventListener('click', saveObjektSketch);
})();
