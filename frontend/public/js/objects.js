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
let pendingLatLon = null;
let vehiclesCache = [];
let stationsCache = [];
let allObjectsCache = [];

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
  document.getElementById('object-review-status').textContent = object ? reviewStatusText(object) : '';

  setDialogMode(mode);
  document.getElementById('object-dialog').showModal();

  if (mode !== 'create' && object) {
    await loadVehiclesAndStations();
    updateTaskTargetOptions();
    await Promise.all([loadTasksForDialog(object.id), loadAttachmentsForDialog(object.id)]);
  }
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
