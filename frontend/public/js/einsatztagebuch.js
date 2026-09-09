// Einsatztagebuch (Nutzerwunsch, siehe backend/sql/migrations/017_add_einsatztagebuch.sql fuer die
// Modellentscheidung: ein durchlaufendes Logbuch je Wehr statt eigener "Einsatz"-Datensaetze). Lesen
// fuer alle Rollen, Anlegen/Aendern/Loeschen nur stab/admin (Formular-Karte oben bleibt fuer
// 'mitglied' per data-role="stab-only" ausgeblendet, wie auf anderen Seiten auch).

const CATEGORY_LABELS = {
  meldung: 'Meldung',
  massnahme: 'Maßnahme',
  lage: 'Lageänderung',
  sonstiges: 'Sonstiges',
};

const tagebuch = {
  editingId: null,
  currentUser: null,
};

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function resetForm() {
  tagebuch.editingId = null;
  document.getElementById('tagebuch-form-title').textContent = 'Neuer Eintrag';
  document.getElementById('tagebuch-submit-button').textContent = 'Eintrag speichern';
  document.getElementById('tagebuch-cancel-edit-button').hidden = true;
  document.getElementById('tagebuch-entry-time').value = toDatetimeLocalValue(new Date());
  document.getElementById('tagebuch-category').value = '';
  document.getElementById('tagebuch-message').value = '';
  document.getElementById('tagebuch-form-error').textContent = '';
}

function startEdit(entry) {
  tagebuch.editingId = entry.id;
  document.getElementById('tagebuch-form-title').textContent = `Eintrag bearbeiten (#${entry.id})`;
  document.getElementById('tagebuch-submit-button').textContent = 'Änderung speichern';
  document.getElementById('tagebuch-cancel-edit-button').hidden = false;
  document.getElementById('tagebuch-entry-time').value = toDatetimeLocalValue(new Date(entry.entry_time));
  document.getElementById('tagebuch-category').value = entry.category || '';
  document.getElementById('tagebuch-message').value = entry.message;
  document.getElementById('tagebuch-form-error').textContent = '';
  document.getElementById('tagebuch-entry-time').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function deleteEntry(id) {
  if (!confirm('Diesen Tagebucheintrag wirklich löschen?')) return;
  try {
    await api.delete(`/einsatztagebuch/${id}`);
    await loadEntries();
  } catch (err) {
    document.getElementById('tagebuch-list-error').textContent = err.message;
  }
}

function renderEntries(entries) {
  const container = document.getElementById('tagebuch-entries');
  container.innerHTML = '';

  if (entries.length === 0) {
    container.innerHTML = '<p class="muted">Keine Einträge im gewählten Zeitraum.</p>';
    return;
  }

  const canWrite = tagebuch.currentUser && tagebuch.currentUser.role !== 'mitglied';

  entries.forEach((entry) => {
    const el = document.createElement('div');
    el.className = 'tagebuch-entry';

    const header = document.createElement('div');
    header.className = 'tagebuch-entry-header';
    const time = document.createElement('span');
    time.className = 'tagebuch-entry-time';
    time.textContent = formatTimestamp(entry.entry_time);
    header.appendChild(time);
    if (entry.category) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = CATEGORY_LABELS[entry.category] || entry.category;
      header.appendChild(badge);
    }
    el.appendChild(header);

    const message = document.createElement('div');
    message.className = 'tagebuch-entry-message';
    message.textContent = entry.message;
    el.appendChild(message);

    const footer = document.createElement('div');
    footer.className = 'tagebuch-entry-footer';
    const author = document.createElement('span');
    author.className = 'muted';
    author.textContent = entry.created_by_email || 'Unbekannt';
    footer.appendChild(author);

    if (canWrite) {
      const actions = document.createElement('div');
      actions.className = 'tagebuch-entry-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'secondary';
      editBtn.textContent = 'Bearbeiten';
      editBtn.addEventListener('click', () => startEdit(entry));
      const deleteBtn = document.createElement('button');
      deleteBtn.type = 'button';
      deleteBtn.className = 'secondary';
      deleteBtn.textContent = 'Löschen';
      deleteBtn.addEventListener('click', () => deleteEntry(entry.id));
      actions.append(editBtn, deleteBtn);
      footer.appendChild(actions);
    }
    el.appendChild(footer);

    container.appendChild(el);
  });
}

async function loadEntries() {
  const errorEl = document.getElementById('tagebuch-list-error');
  errorEl.textContent = '';

  const since = document.getElementById('tagebuch-filter-since').value;
  const until = document.getElementById('tagebuch-filter-until').value;
  const params = new URLSearchParams();
  if (since) params.set('since', new Date(`${since}T00:00:00`).toISOString());
  if (until) params.set('until', new Date(`${until}T23:59:59`).toISOString());
  const qs = params.toString();

  try {
    const entries = await api.get(`/einsatztagebuch${qs ? `?${qs}` : ''}`);
    renderEntries(entries);
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function initTagebuchForm() {
  const form = document.getElementById('tagebuch-form');
  const errorEl = document.getElementById('tagebuch-form-error');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';

    const entryTimeLocal = document.getElementById('tagebuch-entry-time').value;
    const category = document.getElementById('tagebuch-category').value;
    const message = document.getElementById('tagebuch-message').value.trim();
    if (!entryTimeLocal || !message) return;

    const payload = {
      entryTime: new Date(entryTimeLocal).toISOString(),
      category: category || null,
      message,
    };

    try {
      if (tagebuch.editingId) {
        await api.patch(`/einsatztagebuch/${tagebuch.editingId}`, payload);
      } else {
        await api.post('/einsatztagebuch', payload);
      }
      resetForm();
      await loadEntries();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  document.getElementById('tagebuch-cancel-edit-button').addEventListener('click', resetForm);
}

async function bootstrapEinsatztagebuchPage() {
  const user = await initHeader();
  if (!user) return;
  tagebuch.currentUser = user;
  registerServiceWorker();

  resetForm();
  initTagebuchForm();

  document.getElementById('tagebuch-filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loadEntries();
  });
  document.getElementById('tagebuch-filter-reset').addEventListener('click', () => {
    document.getElementById('tagebuch-filter-since').value = '';
    document.getElementById('tagebuch-filter-until').value = '';
    loadEntries();
  });

  await loadEntries();
}

document.addEventListener('DOMContentLoaded', bootstrapEinsatztagebuchPage);
