// Übergabeprotokoll (Migration 019, routes/uebergabeprotokoll.js): strukturierte Schichtübergabe mit
// Status 'offen'/'erledigt' je Punkt - anders als das rein chronologische Einsatztagebuch
// (js/einsatztagebuch.js, gleiches Grundmuster) zwei getrennte Listen statt einer Zeitleiste, weil
// hier "was steht noch aus" die eigentliche Frage ist, nicht "was geschah wann".

const uebergabe = { currentUser: null, entries: [], editingEntryId: null };

async function toggleStatus(entry) {
  const nextStatus = entry.status === 'offen' ? 'erledigt' : 'offen';
  try {
    await api.patch(`/uebergabeprotokoll/${entry.id}`, { status: nextStatus });
    await loadEntries();
  } catch (err) {
    document.getElementById('uebergabe-list-error').textContent = err.message;
  }
}

async function deleteEntry(id) {
  if (!confirm('Diesen Übergabepunkt wirklich löschen?')) return;
  try {
    await api.delete(`/uebergabeprotokoll/${id}`);
    await loadEntries();
  } catch (err) {
    document.getElementById('uebergabe-list-error').textContent = err.message;
  }
}

// Bearbeitung passiert Inline direkt in der Zeile (statt ueber ein separates Formular wie bei
// Checklisten) - ein Uebergabepunkt ist ein einzelnes Freitextfeld, dafuer lohnt sich kein Umschalten
// zu einer entfernten Formular-Karte. editingEntryId steuert, welche der (bereits geladenen)
// uebergabe.entries gerade als Eingabefeld statt als Text gerendert wird.
function startEditEntry(id) {
  uebergabe.editingEntryId = id;
  renderEntries(uebergabe.entries);
}

function cancelEditEntry() {
  uebergabe.editingEntryId = null;
  renderEntries(uebergabe.entries);
}

async function saveEntryEdit(id, message) {
  const errorEl = document.getElementById('uebergabe-list-error');
  errorEl.textContent = '';
  const trimmed = message.trim();
  if (!trimmed) return;
  try {
    await api.patch(`/uebergabeprotokoll/${id}`, { message: trimmed });
    uebergabe.editingEntryId = null;
    await loadEntries();
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function renderEntry(entry, canWrite) {
  const el = document.createElement('div');
  el.className = 'tagebuch-entry';

  if (canWrite && uebergabe.editingEntryId === entry.id) {
    const textarea = document.createElement('textarea');
    textarea.className = 'tagebuch-entry-edit-textarea';
    textarea.rows = 2;
    textarea.maxLength = 4000;
    textarea.value = entry.message;
    el.appendChild(textarea);

    const editActions = document.createElement('div');
    editActions.className = 'tagebuch-entry-actions';
    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'primary';
    saveBtn.textContent = 'Speichern';
    saveBtn.addEventListener('click', () => saveEntryEdit(entry.id, textarea.value));
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'secondary';
    cancelBtn.textContent = 'Abbrechen';
    cancelBtn.addEventListener('click', cancelEditEntry);
    editActions.append(saveBtn, cancelBtn);
    el.appendChild(editActions);
    return el;
  }

  const message = document.createElement('div');
  message.className = 'tagebuch-entry-message';
  message.textContent = entry.message;
  el.appendChild(message);

  const footer = document.createElement('div');
  footer.className = 'tagebuch-entry-footer';
  const meta = document.createElement('span');
  meta.className = 'muted';
  meta.textContent =
    entry.status === 'erledigt'
      ? `Erledigt von ${entry.resolved_by_email || 'Unbekannt'} · ${formatTimestamp(entry.resolved_at)}`
      : `Angelegt von ${entry.created_by_email || 'Unbekannt'} · ${formatTimestamp(entry.created_at)}`;
  footer.appendChild(meta);

  if (canWrite) {
    const actions = document.createElement('div');
    actions.className = 'tagebuch-entry-actions';
    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'secondary';
    toggleBtn.textContent = entry.status === 'offen' ? 'Als erledigt markieren' : 'Wieder öffnen';
    toggleBtn.addEventListener('click', () => toggleStatus(entry));
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'secondary';
    editBtn.textContent = 'Bearbeiten';
    editBtn.addEventListener('click', () => startEditEntry(entry.id));
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', () => deleteEntry(entry.id));
    actions.append(toggleBtn, editBtn, deleteBtn);
    footer.appendChild(actions);
  }
  el.appendChild(footer);
  return el;
}

function renderEntries(entries) {
  uebergabe.entries = entries;
  const offenContainer = document.getElementById('uebergabe-offen');
  const erledigtContainer = document.getElementById('uebergabe-erledigt');
  offenContainer.innerHTML = '';
  erledigtContainer.innerHTML = '';

  const canWrite = uebergabe.currentUser && uebergabe.currentUser.role !== 'mitglied';
  const offen = entries.filter((e) => e.status === 'offen');
  const erledigt = entries.filter((e) => e.status === 'erledigt');

  if (offen.length === 0) {
    offenContainer.innerHTML = '<p class="muted">Keine offenen Punkte.</p>';
  } else {
    offen.forEach((entry) => offenContainer.appendChild(renderEntry(entry, canWrite)));
  }

  if (erledigt.length === 0) {
    erledigtContainer.innerHTML = '<p class="muted">Noch nichts erledigt.</p>';
  } else {
    erledigt.forEach((entry) => erledigtContainer.appendChild(renderEntry(entry, canWrite)));
  }
}

async function loadEntries() {
  const errorEl = document.getElementById('uebergabe-list-error');
  errorEl.textContent = '';
  try {
    const entries = await api.get('/uebergabeprotokoll');
    renderEntries(entries);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function initUebergabeForm() {
  const form = document.getElementById('uebergabe-form');
  const errorEl = document.getElementById('uebergabe-form-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const messageEl = document.getElementById('uebergabe-message');
    const message = messageEl.value.trim();
    if (!message) return;
    try {
      await api.post('/uebergabeprotokoll', { message });
      messageEl.value = '';
      await loadEntries();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function bootstrapUebergabeprotokollPage() {
  const user = await initHeader();
  if (!user) return;
  uebergabe.currentUser = user;
  registerServiceWorker();

  initUebergabeForm();
  await loadEntries();
}

document.addEventListener('DOMContentLoaded', bootstrapUebergabeprotokollPage);
