// Objektverwaltung: kritische Objekte (Schulen, Pflegeeinrichtungen, Gefahrstoffbetriebe, ...)
// direkt auf der Karte anlegen/bearbeiten. Lesen duerfen alle Rollen, Schreiben nur stab/admin
// (serverseitig durchgesetzt, siehe backend/src/routes/objects.js) - das Formular wird fuer
// Mitglieder read-only dargestellt.

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
  };
}

async function loadObjects() {
  const objects = await api.get('/objects');
  renderObjects(objects);
}

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
  dialog.querySelector('.error-message').textContent = '';
}

function openObjectDialog(mode, object) {
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

  setDialogMode(mode);
  document.getElementById('object-dialog').showModal();
}

window.selectObject = function selectObject(obj) {
  openObjectDialog(objectsCanEdit ? 'edit' : 'view', obj);
};

async function submitObjectForm(event) {
  event.preventDefault();
  const fields = objectFormFields();
  const errorEl = document.querySelector('#object-dialog .error-message');
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
  if (!confirm('Dieses Objekt wirklich löschen?')) return;
  try {
    await api.delete(`/objects/${editingObjectId}`);
    document.getElementById('object-dialog').close();
    await loadObjects();
  } catch (err) {
    alert(err.message);
  }
}

function initObjectsUi(user) {
  objectsCanEdit = user.role !== 'mitglied';

  document.getElementById('object-form').addEventListener('submit', submitObjectForm);
  document.getElementById('object-cancel-button').addEventListener('click', () => {
    document.getElementById('object-dialog').close();
  });
  document.getElementById('object-delete-button').addEventListener('click', deleteCurrentObject);

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
