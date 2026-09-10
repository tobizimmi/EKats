// Checklisten/SOPs (Migration 020, routes/checklists.js): hinterlegbare Standard-Einsatz-Regeln je
// Objekttyp/Szenario, gemeinsam abhakbar. Anders als Einsatztagebuch/Übergabeprotokoll keine reine
// Liste von Einträgen, sondern Vorlagen mit geschachtelten Punkten - deshalb eigene Render-Logik
// statt Wiederverwendung der generischen DataTable.

const checklisten = { currentUser: null };

async function toggleItem(item) {
  try {
    await api.patch(`/checklists/items/${item.id}`, { checked: !item.checked });
    await loadChecklists();
  } catch (err) {
    document.getElementById('checklist-list-error').textContent = err.message;
  }
}

async function resetTemplate(template) {
  if (!confirm(`Alle Haken in "${template.name}" zurücksetzen?`)) return;
  try {
    await api.post(`/checklists/${template.id}/reset`, {});
    await loadChecklists();
  } catch (err) {
    document.getElementById('checklist-list-error').textContent = err.message;
  }
}

async function deleteTemplate(template) {
  if (!confirm(`Checkliste "${template.name}" wirklich löschen?`)) return;
  try {
    await api.delete(`/checklists/${template.id}`);
    await loadChecklists();
  } catch (err) {
    document.getElementById('checklist-list-error').textContent = err.message;
  }
}

function renderTemplate(template, canManage) {
  const card = document.createElement('div');
  card.className = 'card checklist-card';

  const header = document.createElement('div');
  header.className = 'section-head-row';
  const title = document.createElement('h3');
  title.className = 'section-title';
  title.textContent = template.category ? `${template.name} (${template.category})` : template.name;
  header.appendChild(title);

  const doneCount = template.items.filter((i) => i.checked).length;
  const progress = document.createElement('span');
  progress.className = 'muted';
  progress.textContent = `${doneCount}/${template.items.length} erledigt`;
  header.appendChild(progress);
  card.appendChild(header);

  const list = document.createElement('ul');
  list.className = 'plain-list checklist-items';
  template.items.forEach((item) => {
    const li = document.createElement('li');
    const label = document.createElement('label');
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = item.checked;
    checkbox.addEventListener('change', () => toggleItem(item));
    label.appendChild(checkbox);
    const text = document.createElement('span');
    text.textContent = item.text;
    if (item.checked) text.style.textDecoration = 'line-through';
    label.appendChild(text);
    li.appendChild(label);
    if (item.checked && item.checked_by_email) {
      const meta = document.createElement('span');
      meta.className = 'muted';
      meta.textContent = ` – ${item.checked_by_email}, ${formatTimestamp(item.checked_at)}`;
      li.appendChild(meta);
    }
    list.appendChild(li);
  });
  card.appendChild(list);

  if (canManage) {
    const actions = document.createElement('div');
    actions.className = 'tagebuch-entry-actions';
    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'secondary';
    resetBtn.textContent = 'Zurücksetzen';
    resetBtn.addEventListener('click', () => resetTemplate(template));
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'secondary';
    deleteBtn.textContent = 'Löschen';
    deleteBtn.addEventListener('click', () => deleteTemplate(template));
    actions.append(resetBtn, deleteBtn);
    card.appendChild(actions);
  }

  return card;
}

async function loadChecklists() {
  const errorEl = document.getElementById('checklist-list-error');
  errorEl.textContent = '';
  const container = document.getElementById('checklist-list');
  try {
    const templates = await api.get('/checklists');
    container.innerHTML = '';
    if (templates.length === 0) {
      container.innerHTML = '<p class="muted">Noch keine Checkliste angelegt.</p>';
      return;
    }
    const canManage = checklisten.currentUser && checklisten.currentUser.role !== 'mitglied';
    templates.forEach((t) => container.appendChild(renderTemplate(t, canManage)));
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function initChecklistForm() {
  const form = document.getElementById('checklist-form');
  const errorEl = document.getElementById('checklist-form-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const name = document.getElementById('checklist-name').value.trim();
    const category = document.getElementById('checklist-category').value.trim();
    const items = document
      .getElementById('checklist-items')
      .value.split('\n')
      .map((l) => l.trim())
      .filter((l) => l !== '');
    if (!name || items.length === 0) return;

    try {
      await api.post('/checklists', { name, category: category || null, items });
      form.reset();
      await loadChecklists();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function bootstrapChecklistenPage() {
  const user = await initHeader();
  if (!user) return;
  checklisten.currentUser = user;
  registerServiceWorker();

  initChecklistForm();
  await loadChecklists();
}

document.addEventListener('DOMContentLoaded', bootstrapChecklistenPage);
