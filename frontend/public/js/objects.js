// Objektverwaltung: kritische Objekte (Schulen, Pflegeeinrichtungen, Gefahrstoffbetriebe, ...)
// direkt auf der Karte anlegen/bearbeiten, inkl. Aufgaben je Fahrzeug/Wache (PDF-Export),
// Datei-Anhaengen (Lageplaene) und Ueberpruefungs-Turnus. Lesen duerfen alle Rollen, Schreiben nur
// stab/admin (serverseitig durchgesetzt, siehe backend/src/routes/objects.js) - das Formular wird
// fuer Mitglieder read-only dargestellt.

const OBJECT_CATEGORY_LABELS = {
  schule_kita: 'Schule/Kita',
  krankenhaus_pflege: 'Krankenhaus/Pflegeeinrichtung',
  industrie_gefahrstoff: 'Industrie/Gefahrstoffbetrieb',
  versammlungsstaette: 'Versammlungsstätte',
  sonstiges: 'Sonstiges',
};

let objectsCanEdit = false;
let editingObjectId = null;
let activeSketchEditor = null;
let pendingLatLon = null;
let vehiclesCache = [];
let stationsCache = [];
let allObjectsCache = [];
let objectFieldDefinitionsCache = [];

function objectFormFields() {
  return {
    name: document.getElementById('object-name'),
    category: document.getElementById('object-category'),
    address: document.getElementById('object-address'),
    hazards: document.getElementById('object-hazards'),
    accessInfo: document.getElementById('object-access-info'),
    contactName: document.getElementById('object-contact-name'),
    contactPhone: document.getElementById('object-contact-phone'),
    notes: document.getElementById('object-notes'),
    reviewInterval: document.getElementById('object-review-interval'),
    fireWaterSupplyType: document.getElementById('object-fire-water-supply-type'),
    fireWaterSupplyCapacity: document.getElementById('object-fire-water-supply-capacity'),
    fireWaterSupplyLocation: document.getElementById('object-fire-water-supply-location'),
    fireAlarmSystem: document.getElementById('object-fire-alarm-system'),
    fireAlarmMonitoringStation: document.getElementById('object-fire-alarm-monitoring-station'),
    occupantCountMax: document.getElementById('object-occupant-count-max'),
    elevators: document.getElementById('object-elevators'),
    smokeHeatExhaustSystem: document.getElementById('object-smoke-heat-exhaust-system'),
    pvBatterySystem: document.getElementById('object-pv-battery-system'),
    pvBatteryDisconnectLocation: document.getElementById('object-pv-battery-disconnect-location'),
    assemblyPoint: document.getElementById('object-assembly-point'),
    builtYear: document.getElementById('object-built-year'),
  };
}

async function loadObjects() {
  allObjectsCache = await api.get('/objects');
  renderObjects(allObjectsCache);
  if (typeof renderObjectList === 'function') renderObjectList(allObjectsCache);
  return allObjectsCache;
}

async function loadVehiclesAndStations() {
  [vehiclesCache, stationsCache] = await Promise.all([api.get('/vehicles'), api.get('/stations')]);
}

function reviewStatusText(object) {
  if (!object.review_interval_months) return 'Kein Überprüfungs-Turnus definiert.';
  const due = object.next_review_at ? new Date(object.next_review_at) : null;
  const lastReviewed = object.last_reviewed_at ? formatTimestamp(object.last_reviewed_at) : 'nie';
  if (!due) return `Zuletzt überprüft: ${lastReviewed}`;
  const overdue = due.getTime() < Date.now();
  const dueText = due.toLocaleDateString('de-DE');
  return `Zuletzt überprüft: ${lastReviewed} · Fällig: ${dueText}${overdue ? ' (ÜBERFÄLLIG)' : ''}`;
}

// ---------------------------------------------------------------------------
// Dialog: Grunddaten
// ---------------------------------------------------------------------------

function setDialogMode(mode) {
  const dialog = document.getElementById('object-dialog');
  const fields = objectFormFields();
  const readOnly = mode === 'view';

  Object.values(fields).forEach((el) => {
    el.disabled = readOnly;
  });
  document.getElementById('object-dialog-title').textContent =
    mode === 'create' ? 'Neues Objekt' : mode === 'edit' ? 'Objekt bearbeiten' : 'Objekt-Details';
  document.getElementById('object-save-button').hidden = readOnly;
  document.getElementById('object-delete-button').hidden = mode !== 'edit';
  document.getElementById('object-mark-reviewed-button').hidden = mode !== 'edit';
  document.getElementById('object-extra-sections').hidden = mode === 'create';
  document.getElementById('object-task-form-row').hidden = mode !== 'edit';
  document.getElementById('object-attachment-form-row').hidden = mode !== 'edit';
  dialog.querySelector('#object-form > .error-message').textContent = '';
}

async function openObjectDialog(mode, object) {
  const fields = objectFormFields();
  editingObjectId = object ? object.id : null;

  fields.name.value = object?.name || '';
  fields.category.value = object?.category || 'sonstiges';
  fields.address.value = object?.address || '';
  fields.hazards.value = object?.hazards || '';
  fields.accessInfo.value = object?.access_info || '';
  fields.contactName.value = object?.contact_name || '';
  fields.contactPhone.value = object?.contact_phone || '';
  fields.notes.value = object?.notes || '';
  fields.reviewInterval.value = object?.review_interval_months || '';
  fields.fireWaterSupplyType.value = object?.fire_water_supply_type || '';
  fields.fireWaterSupplyCapacity.value = object?.fire_water_supply_capacity_lpm ?? '';
  fields.fireWaterSupplyLocation.value = object?.fire_water_supply_location || '';
  fields.fireAlarmSystem.checked = !!object?.fire_alarm_system;
  fields.fireAlarmMonitoringStation.value = object?.fire_alarm_monitoring_station || '';
  fields.occupantCountMax.value = object?.occupant_count_max ?? '';
  fields.elevators.checked = !!object?.elevators;
  fields.smokeHeatExhaustSystem.checked = !!object?.smoke_heat_exhaust_system;
  fields.pvBatterySystem.checked = !!object?.pv_battery_system;
  fields.pvBatteryDisconnectLocation.value = object?.pv_battery_disconnect_location || '';
  fields.assemblyPoint.value = object?.assembly_point || '';
  fields.builtYear.value = object?.built_year ?? '';
  document.getElementById('object-review-status').textContent = object ? reviewStatusText(object) : '';

  setDialogMode(mode);
  document.getElementById('object-dialog').showModal();

  await loadCustomFieldsForDialog(object?.custom_fields, mode);

  if (mode !== 'create' && object) {
    document.getElementById('object-datasheet-pdf-link').innerHTML =
      `<a class="button-link" href="api/objects/${object.id}/datasheet/pdf">PDF: Objekt-Datenblatt</a>`;
    await loadVehiclesAndStations();
    updateTaskTargetOptions();
    await Promise.all([loadTasksForDialog(object.id), loadAttachmentsForDialog(object.id), loadObjectSketchForDialog(object, mode)]);
  }
}

// ---------------------------------------------------------------------------
// Kartenskizze (Konzept Teil 2, Baustein B - siehe js/object-sketch.js)
// ---------------------------------------------------------------------------

async function loadObjectSketchForDialog(object, mode) {
  const previewEl = document.getElementById('object-sketch-preview');
  const editBtn = document.getElementById('object-sketch-edit-button');
  document.getElementById('object-sketch-editor').hidden = true;
  previewEl.hidden = false;
  if (activeSketchEditor) {
    activeSketchEditor.destroy();
    activeSketchEditor = null;
  }

  let sketchData = { geojson: null };
  try {
    sketchData = await api.get(`/objects/${object.id}/sketch`);
  } catch (err) {
    // Vorschau bleibt leer, wenn das Laden fehlschlaegt - kein Blocker fuer den restlichen Dialog.
  }
  renderObjectSketchPreview(previewEl, { lat: object.lat, lon: object.lon }, sketchData.geojson);

  editBtn.hidden = mode === 'view';
  editBtn.onclick = () => openObjectSketchEditor(object, sketchData.geojson);
}

function openObjectSketchEditor(object, initialGeoJson) {
  document.getElementById('object-sketch-preview').hidden = true;
  document.getElementById('object-sketch-edit-button').hidden = true;
  document.getElementById('object-sketch-editor').hidden = false;
  document.getElementById('object-sketch-error').textContent = '';

  activeSketchEditor = new ObjectSketchEditor({
    toolbarEl: document.getElementById('object-sketch-toolbar'),
    mapContainerEl: document.getElementById('object-sketch-map'),
    errorEl: document.getElementById('object-sketch-error'),
    objectId: object.id,
    center: { lat: object.lat, lon: object.lon },
    initialGeoJson,
  });
}

function closeObjectSketchEditor() {
  if (activeSketchEditor) {
    activeSketchEditor.destroy();
    activeSketchEditor = null;
  }
  document.getElementById('object-sketch-editor').hidden = true;
  document.getElementById('object-sketch-preview').hidden = false;
  document.getElementById('object-sketch-edit-button').hidden = false;
}

async function saveObjectSketch() {
  if (!activeSketchEditor) return;
  const center = activeSketchEditor.center;
  const geojson = sketchLayersToGeoJson(activeSketchEditor.sketchLayers);
  const ok = await activeSketchEditor.save();
  if (!ok) return;
  closeObjectSketchEditor();
  renderObjectSketchPreview(document.getElementById('object-sketch-preview'), center, geojson);
}

// ---------------------------------------------------------------------------
// Zusatzfelder (je Wehr frei definierbar, siehe Admin-Bereich > Objekt-Zusatzfelder)
// ---------------------------------------------------------------------------

async function loadCustomFieldsForDialog(existingValues, mode) {
  const container = document.getElementById('object-custom-fields');
  const section = document.getElementById('object-custom-fields-section');
  container.innerHTML = '';

  try {
    objectFieldDefinitionsCache = await api.get('/object-fields');
  } catch (err) {
    objectFieldDefinitionsCache = [];
  }

  if (objectFieldDefinitionsCache.length === 0) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const readOnly = mode === 'view';
  objectFieldDefinitionsCache.forEach((def) => {
    const label = document.createElement('label');
    const isCheckbox = def.field_type === 'boolean';
    if (isCheckbox) label.className = 'checkbox-inline';

    const span = document.createElement('span');
    span.textContent = def.label + (def.required ? ' *' : '');

    let input;
    if (def.field_type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 2;
      input.maxLength = 2000;
    } else if (def.field_type === 'select') {
      input = document.createElement('select');
      const emptyOpt = document.createElement('option');
      emptyOpt.value = '';
      emptyOpt.textContent = def.required ? 'Bitte wählen' : 'Keine Angabe';
      input.appendChild(emptyOpt);
      (def.options || []).forEach((opt) => {
        const o = document.createElement('option');
        o.value = opt.value;
        o.textContent = opt.label;
        input.appendChild(o);
      });
    } else {
      input = document.createElement('input');
      input.type =
        def.field_type === 'boolean' ? 'checkbox' : def.field_type === 'number' ? 'number' : def.field_type === 'date' ? 'date' : 'text';
      if (def.field_type === 'text') input.maxLength = 300;
    }
    input.id = `object-custom-field-${def.key}`;
    input.dataset.fieldKey = def.key;
    input.dataset.fieldType = def.field_type;
    input.disabled = readOnly;

    const value = existingValues ? existingValues[def.key] : undefined;
    if (isCheckbox) {
      input.checked = !!value;
    } else if (value !== undefined && value !== null) {
      input.value = value;
    }

    if (isCheckbox) {
      label.appendChild(input);
      label.appendChild(span);
    } else {
      label.appendChild(span);
      label.appendChild(input);
    }
    container.appendChild(label);
  });
}

// Nur tatsaechlich ausgefuellte Werte senden - ein geleertes optionales Feld verschwindet dadurch
// aus custom_fields, statt als "null" fuer ein evtl. inzwischen umbenanntes/geloeschtes Feld
// mitgeschickt zu werden (die Feld-Definition entscheidet ohnehin serverseitig, was gueltig ist).
function collectCustomFieldValues() {
  const values = {};
  document.querySelectorAll('#object-custom-fields [data-field-key]').forEach((input) => {
    const key = input.dataset.fieldKey;
    const type = input.dataset.fieldType;
    if (type === 'boolean') {
      values[key] = input.checked;
    } else if (type === 'number') {
      values[key] = input.value === '' ? null : Number(input.value);
    } else {
      values[key] = input.value.trim() === '' ? null : input.value.trim();
    }
  });
  Object.keys(values).forEach((key) => {
    if (values[key] === null) delete values[key];
  });
  return values;
}

window.selectObject = function selectObject(obj) {
  openObjectDialog(objectsCanEdit ? 'edit' : 'view', obj);
};

async function submitObjectForm(event) {
  event.preventDefault();
  const fields = objectFormFields();
  const errorEl = document.querySelector('#object-form > .error-message');
  errorEl.textContent = '';

  const payload = {
    name: fields.name.value.trim(),
    category: fields.category.value,
    address: fields.address.value.trim() || null,
    hazards: fields.hazards.value.trim() || null,
    accessInfo: fields.accessInfo.value.trim() || null,
    contactName: fields.contactName.value.trim() || null,
    contactPhone: fields.contactPhone.value.trim() || null,
    notes: fields.notes.value.trim() || null,
    reviewIntervalMonths: fields.reviewInterval.value ? Number(fields.reviewInterval.value) : null,
    fireWaterSupplyType: fields.fireWaterSupplyType.value || null,
    fireWaterSupplyCapacityLpm: fields.fireWaterSupplyCapacity.value ? Number(fields.fireWaterSupplyCapacity.value) : null,
    fireWaterSupplyLocation: fields.fireWaterSupplyLocation.value.trim() || null,
    fireAlarmSystem: fields.fireAlarmSystem.checked,
    fireAlarmMonitoringStation: fields.fireAlarmMonitoringStation.value.trim() || null,
    occupantCountMax: fields.occupantCountMax.value ? Number(fields.occupantCountMax.value) : null,
    elevators: fields.elevators.checked,
    smokeHeatExhaustSystem: fields.smokeHeatExhaustSystem.checked,
    pvBatterySystem: fields.pvBatterySystem.checked,
    pvBatteryDisconnectLocation: fields.pvBatteryDisconnectLocation.value.trim() || null,
    assemblyPoint: fields.assemblyPoint.value.trim() || null,
    builtYear: fields.builtYear.value ? Number(fields.builtYear.value) : null,
    customFields: collectCustomFieldValues(),
  };

  try {
    if (editingObjectId) {
      await api.patch(`/objects/${editingObjectId}`, payload);
    } else {
      await api.post('/objects', { ...payload, lat: pendingLatLon.lat, lon: pendingLatLon.lng });
    }
    document.getElementById('object-dialog').close();
    await loadObjects();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function deleteCurrentObject() {
  if (!editingObjectId) return;
  if (!confirm('Dieses Objekt wirklich löschen? Aufgaben und Anhänge werden mitgelöscht.')) return;
  try {
    await api.delete(`/objects/${editingObjectId}`);
    document.getElementById('object-dialog').close();
    await loadObjects();
  } catch (err) {
    alert(err.message);
  }
}

async function markCurrentObjectReviewed() {
  if (!editingObjectId) return;
  try {
    const updated = await api.post(`/objects/${editingObjectId}/mark-reviewed`);
    document.getElementById('object-review-status').textContent = reviewStatusText(updated);
    await loadObjects();
  } catch (err) {
    alert(err.message);
  }
}

// ---------------------------------------------------------------------------
// Aufgaben (Fahrzeuge/Wachen) + PDF-Links
// ---------------------------------------------------------------------------

function updateTaskTargetOptions() {
  const type = document.getElementById('object-task-target-type').value;
  const select = document.getElementById('object-task-target-id');
  const list = type === 'vehicle' ? vehiclesCache : stationsCache;
  select.innerHTML = '';
  list.forEach((entry) => {
    const opt = document.createElement('option');
    opt.value = entry.id;
    opt.textContent = entry.name;
    select.appendChild(opt);
  });
}

async function loadTasksForDialog(objectId) {
  const tasks = await api.get(`/objects/${objectId}/tasks`);
  const list = document.getElementById('object-task-list');
  list.innerHTML = '';

  if (tasks.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Keine Aufgaben hinterlegt.';
    list.appendChild(li);
  }

  tasks.forEach((task) => {
    const li = document.createElement('li');
    const main = document.createElement('div');
    main.className = 'item-main';
    const targetLabel = task.vehicle_name ? `Fahrzeug: ${task.vehicle_name}` : `Wache: ${task.station_name}`;
    main.innerHTML = `<strong>${task.title}</strong><div class="item-meta">${targetLabel}${
      task.description ? ' · ' + task.description : ''
    }</div>`;
    li.appendChild(main);

    if (objectsCanEdit) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'secondary';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Löschen';
      deleteBtn.addEventListener('click', async () => {
        try {
          await api.delete(`/objects/${objectId}/tasks/${task.id}`);
          await loadTasksForDialog(objectId);
        } catch (err) {
          alert(err.message);
        }
      });
      li.appendChild(deleteBtn);
    }
    list.appendChild(li);
  });

  renderPdfLinks(objectId, tasks);
}

function renderPdfLinks(objectId, tasks) {
  const container = document.getElementById('object-pdf-links');
  container.innerHTML = '';

  const vehicleIds = [...new Set(tasks.filter((t) => t.vehicle_id).map((t) => t.vehicle_id))];
  const stationIds = [...new Set(tasks.filter((t) => t.station_id).map((t) => t.station_id))];

  if (vehicleIds.length === 0 && stationIds.length === 0) {
    container.textContent = 'Keine Aufgaben hinterlegt.';
    return;
  }

  const wrap = document.createElement('div');
  wrap.style.display = 'flex';
  wrap.style.flexWrap = 'wrap';
  wrap.style.gap = '0.5rem';

  vehicleIds.forEach((vehicleId) => {
    const vehicle = vehiclesCache.find((v) => v.id === vehicleId);
    const link = document.createElement('a');
    link.className = 'button-link';
    link.href = `api/objects/${objectId}/tasks/vehicle/${vehicleId}/pdf`;
    link.textContent = `PDF: ${vehicle ? vehicle.name : 'Fahrzeug'}`;
    wrap.appendChild(link);
  });
  stationIds.forEach((stationId) => {
    const station = stationsCache.find((s) => s.id === stationId);
    const link = document.createElement('a');
    link.className = 'button-link';
    link.href = `api/objects/${objectId}/tasks/station/${stationId}/pdf`;
    link.textContent = `PDF: ${station ? station.name : 'Wache'}`;
    wrap.appendChild(link);
  });
  container.appendChild(wrap);
}

async function addTaskToCurrentObject() {
  const errorEl = document.getElementById('object-task-error');
  errorEl.textContent = '';
  const title = document.getElementById('object-task-title').value.trim();
  const description = document.getElementById('object-task-description').value.trim();
  const targetType = document.getElementById('object-task-target-type').value;
  const targetId = document.getElementById('object-task-target-id').value;

  if (!title || !targetId) {
    errorEl.textContent = 'Titel und Fahrzeug/Wache sind erforderlich.';
    return;
  }

  try {
    await api.post(`/objects/${editingObjectId}/tasks`, {
      title,
      description: description || null,
      vehicleId: targetType === 'vehicle' ? Number(targetId) : null,
      stationId: targetType === 'station' ? Number(targetId) : null,
    });
    document.getElementById('object-task-title').value = '';
    document.getElementById('object-task-description').value = '';
    await loadTasksForDialog(editingObjectId);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Datei-Anhaenge
// ---------------------------------------------------------------------------

function formatFileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

async function loadAttachmentsForDialog(objectId) {
  const attachments = await api.get(`/objects/${objectId}/attachments`);
  const list = document.getElementById('object-attachment-list');
  list.innerHTML = '';

  if (attachments.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Keine Anhänge vorhanden.';
    list.appendChild(li);
  }

  attachments.forEach((attachment) => {
    const li = document.createElement('li');
    const link = document.createElement('a');
    link.href = `api/objects/${objectId}/attachments/${attachment.id}/file`;
    link.textContent = attachment.filename;
    const main = document.createElement('div');
    main.className = 'item-main';
    main.appendChild(link);
    const meta = document.createElement('div');
    meta.className = 'item-meta';
    meta.textContent = formatFileSize(attachment.size_bytes);
    main.appendChild(meta);
    li.appendChild(main);

    if (objectsCanEdit) {
      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'secondary';
      deleteBtn.type = 'button';
      deleteBtn.textContent = 'Löschen';
      deleteBtn.addEventListener('click', async () => {
        try {
          await api.delete(`/objects/${objectId}/attachments/${attachment.id}`);
          await loadAttachmentsForDialog(objectId);
        } catch (err) {
          alert(err.message);
        }
      });
      li.appendChild(deleteBtn);
    }
    list.appendChild(li);
  });
}

async function uploadAttachmentToCurrentObject() {
  const errorEl = document.getElementById('object-attachment-error');
  errorEl.textContent = '';
  const input = document.getElementById('object-attachment-file');
  if (!input.files[0]) {
    errorEl.textContent = 'Bitte eine Datei auswählen.';
    return;
  }

  const formData = new FormData();
  formData.append('file', input.files[0]);

  try {
    const res = await fetch(`api/objects/${editingObjectId}/attachments`, {
      method: 'POST',
      credentials: 'include',
      body: formData,
    });
    const json = await res.json();
    if (!res.ok || !json.ok) throw new Error(json.error || `Fehler (Status ${res.status}).`);
    input.value = '';
    await loadAttachmentsForDialog(editingObjectId);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Objekt-Übersichtsliste (sortier-/filterbar, Tab neben der Lage-Übersicht)
// ---------------------------------------------------------------------------

function isOverdue(object) {
  return !!object.next_review_at && new Date(object.next_review_at).getTime() < Date.now();
}

function renderObjectList(objects) {
  const search = document.getElementById('object-list-search').value.trim().toLowerCase();
  const categoryFilter = document.getElementById('object-list-category-filter').value;
  const overdueOnly = document.getElementById('object-list-overdue-filter').checked;
  const sortBy = document.getElementById('object-list-sort').value;

  const filtered = objects.filter((obj) => {
    if (categoryFilter && obj.category !== categoryFilter) return false;
    if (overdueOnly && !isOverdue(obj)) return false;
    if (search && !`${obj.name} ${obj.address || ''}`.toLowerCase().includes(search)) return false;
    return true;
  });

  filtered.sort((a, b) => {
    if (sortBy === 'category') {
      return (OBJECT_CATEGORY_LABELS[a.category] || '').localeCompare(OBJECT_CATEGORY_LABELS[b.category] || '');
    }
    if (sortBy === 'due') {
      const dueA = a.next_review_at ? new Date(a.next_review_at).getTime() : Infinity;
      const dueB = b.next_review_at ? new Date(b.next_review_at).getTime() : Infinity;
      return dueA - dueB;
    }
    return a.name.localeCompare(b.name);
  });

  const list = document.getElementById('object-list');
  list.innerHTML = '';

  if (filtered.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = 'Keine Objekte gefunden.';
    list.appendChild(li);
    return;
  }

  filtered.forEach((obj) => {
    const overdue = isOverdue(obj);
    const li = document.createElement('li');
    const row = document.createElement('div');
    row.className = 'situation-item-row';

    const dot = document.createElement('span');
    dot.className = `severity-dot severity-${overdue ? 4 : 0}`;
    row.appendChild(dot);

    const textWrap = document.createElement('div');
    const title = document.createElement('div');
    title.className = 'situation-item-title';
    title.textContent = obj.name;

    const metaParts = [OBJECT_CATEGORY_LABELS[obj.category] || obj.category];
    if (obj.address) metaParts.push(obj.address);
    if (obj.next_review_at) {
      const dueText = new Date(obj.next_review_at).toLocaleDateString('de-DE');
      metaParts.push(`Fällig: ${dueText}${overdue ? ' (ÜBERFÄLLIG)' : ''}`);
    }
    const meta = document.createElement('div');
    meta.className = 'situation-item-meta';
    meta.textContent = metaParts.join(' · ');

    textWrap.appendChild(title);
    textWrap.appendChild(meta);
    row.appendChild(textWrap);
    li.appendChild(row);
    li.addEventListener('click', () => window.selectObject(obj));
    list.appendChild(li);
  });
}

// Tab-Umschaltung ist generisch fuer eine beliebige Anzahl Tabs (siehe app.js initTabs()) - hier
// nur noch die Objekt-Listenfilter verdrahten.
function initObjectListTab() {
  ['object-list-search', 'object-list-category-filter', 'object-list-overdue-filter', 'object-list-sort'].forEach(
    (id) => {
      const el = document.getElementById(id);
      el.addEventListener(el.tagName === 'INPUT' && el.type === 'text' ? 'input' : 'change', () =>
        renderObjectList(allObjectsCache)
      );
    }
  );
}

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

function initObjectsUi(user) {
  objectsCanEdit = user.role !== 'mitglied';

  initObjectListTab();
  document.getElementById('object-form').addEventListener('submit', submitObjectForm);
  document.getElementById('object-cancel-button').addEventListener('click', () => {
    document.getElementById('object-dialog').close();
  });
  document.getElementById('object-delete-button').addEventListener('click', deleteCurrentObject);
  document.getElementById('object-mark-reviewed-button').addEventListener('click', markCurrentObjectReviewed);
  document.getElementById('object-task-target-type').addEventListener('change', updateTaskTargetOptions);
  document.getElementById('object-task-add-button').addEventListener('click', addTaskToCurrentObject);
  document.getElementById('object-attachment-upload-button').addEventListener('click', uploadAttachmentToCurrentObject);
  document.getElementById('object-sketch-cancel-button').addEventListener('click', closeObjectSketchEditor);
  document.getElementById('object-sketch-save-button').addEventListener('click', saveObjectSketch);
  // Native <dialog>-"close"-Event feuert unabhaengig davon, WIE geschlossen wurde (Abbrechen-Klick,
  // Esc-Taste, Formular-Submit mit method="dialog") - zuverlaessiger Ort, um eine evtl. offene
  // Leaflet-Editor-Instanz aufzuraeumen, statt jeden einzelnen Schliessen-Pfad einzeln abzudecken.
  document.getElementById('object-dialog').addEventListener('close', () => {
    if (activeSketchEditor) {
      activeSketchEditor.destroy();
      activeSketchEditor = null;
    }
  });

  const addButton = document.getElementById('add-object-button');
  if (!objectsCanEdit) {
    addButton.hidden = true;
    return;
  }

  addButton.addEventListener('click', () => {
    if (addButton.dataset.armed === 'true') {
      disarmObjectPlacement();
      addButton.dataset.armed = 'false';
      addButton.textContent = 'Objekt anlegen';
      return;
    }
    addButton.dataset.armed = 'true';
    addButton.textContent = 'Position auf der Karte anklicken … (Abbrechen)';
    armObjectPlacement((latlng) => {
      addButton.dataset.armed = 'false';
      addButton.textContent = 'Objekt anlegen';
      pendingLatLon = latlng;
      openObjectDialog('create', null);
    });
  });
}
