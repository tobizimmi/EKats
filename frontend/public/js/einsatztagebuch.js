// Einsatztagebuch + Einsatz-Verwaltung (Migration 022, routes/einsatz.js). Ursprünglich (Migration
// 017) bewusst OHNE eigenes Einsatz-Konzept gebaut ("ein durchlaufendes Logbuch je Wehr") - auf
// konkretes Nutzer-Feedback samt mitgebrachtem Referenztool ("Lagemeldung2") korrigiert: eine
// Lagemeldung gehört im echten Betrieb zu einem konkreten Einsatz (Stichwort/Adresse/Nummer,
// Von/An als Funkverkehr-Partner), nicht nur lose in ein gemeinsames Logbuch. Freie Logbucheinträge
// ohne Einsatzbezug (das bisherige Verhalten) bleiben als eigener Abschnitt weiter nutzbar.

const CATEGORY_LABELS = {
  meldung: 'Meldung',
  massnahme: 'Maßnahme',
  lage: 'Lageänderung',
  sonstiges: 'Sonstiges',
};

const tagebuch = {
  editingId: null,
  currentUser: null,
  aktuellerEinsatz: null,
};

function toDatetimeLocalValue(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// ---------------------------------------------------------------------------
// Einsatz starten/beenden/wiedereröffnen
// ---------------------------------------------------------------------------

// Von/An sind bewusst ein <input list> (Datalist) statt eines starren <select>: Vorschläge aus den
// bereits gepflegten Fahrzeugen/Wachen plus "Leitstelle" als haeufigstem Funkpartner, aber jeder
// Freitext bleibt moeglich (anders als im Referenztool des Nutzers, das nur exakt vorkonfigurierte
// Werte erlaubte - Wachen ohne hinterlegtes Fahrzeug waeren dort nicht auswaehlbar gewesen).
async function loadPartnerOptions() {
  const datalist = document.getElementById('einsatz-partner-options');
  try {
    const [vehicles, stations] = await Promise.all([api.get('/vehicles'), api.get('/stations')]);
    const names = new Set(['Leitstelle', 'Einsatzleiter']);
    vehicles.forEach((v) => names.add(v.name));
    stations.forEach((s) => names.add(s.name));
    datalist.innerHTML = '';
    [...names].sort().forEach((name) => {
      const option = document.createElement('option');
      option.value = name;
      datalist.appendChild(option);
    });
  } catch (err) {
    // Vorschlagsliste ist reiner Komfort - ohne sie bleibt Von/An weiterhin als Freitextfeld nutzbar.
  }
}

function renderEinsatzAktuellUi() {
  const startCard = document.getElementById('einsatz-start-card');
  const aktuellCard = document.getElementById('einsatz-aktuell-card');
  const formCard = document.getElementById('lagemeldung-form-card');
  const canWrite = tagebuch.currentUser && tagebuch.currentUser.role !== 'mitglied';
  const einsatz = tagebuch.aktuellerEinsatz;

  startCard.hidden = !canWrite || !!einsatz;
  aktuellCard.hidden = !einsatz;
  formCard.hidden = !canWrite;

  if (!einsatz) return;

  document.getElementById('einsatz-aktuell-titel').textContent = einsatz.stichwort;
  const parts = [];
  if (einsatz.adresse) parts.push(einsatz.adresse);
  if (einsatz.nummer) parts.push(`Nr. ${einsatz.nummer}`);
  parts.push(`Beginn: ${formatTimestamp(einsatz.started_at)}`);
  document.getElementById('einsatz-aktuell-meta').textContent = parts.join(' · ');
}

async function loadAktuellerEinsatz() {
  const errorEl = document.getElementById('einsatz-aktuell-error');
  errorEl.textContent = '';
  try {
    const einsaetze = await api.get('/einsaetze?status=laufend');
    tagebuch.aktuellerEinsatz = einsaetze[0] || null;
    renderEinsatzAktuellUi();
    if (tagebuch.aktuellerEinsatz) {
      await loadLagemeldungen(tagebuch.aktuellerEinsatz.id);
    } else {
      document.getElementById('lagemeldung-liste').innerHTML = '';
    }
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

function initEinsatzStartForm() {
  const form = document.getElementById('einsatz-start-form');
  const errorEl = document.getElementById('einsatz-start-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    const stichwort = document.getElementById('einsatz-stichwort').value.trim();
    if (!stichwort) return;
    try {
      await api.post('/einsaetze', {
        stichwort,
        adresse: document.getElementById('einsatz-adresse').value.trim() || null,
        nummer: document.getElementById('einsatz-nummer').value.trim() || null,
      });
      form.reset();
      await loadAktuellerEinsatz();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

async function beendeEinsatz() {
  const einsatz = tagebuch.aktuellerEinsatz;
  if (!einsatz) return;
  if (!confirm(`Einsatz "${einsatz.stichwort}" beenden? Der PDF-Bericht wird anschließend heruntergeladen.`)) return;
  try {
    await api.patch(`/einsaetze/${einsatz.id}`, { status: 'beendet' });
    window.location.href = `api/einsaetze/${einsatz.id}/pdf`;
    await loadAktuellerEinsatz();
    await loadEinsatzArchiv();
  } catch (err) {
    document.getElementById('einsatz-aktuell-error').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Lagemeldungen des laufenden Einsatzes
// ---------------------------------------------------------------------------

function renderLagemeldungEntry(entry) {
  const el = document.createElement('div');
  el.className = 'tagebuch-entry';

  const header = document.createElement('div');
  header.className = 'tagebuch-entry-header';
  const time = document.createElement('span');
  time.className = 'tagebuch-entry-time';
  time.textContent = formatTimestamp(entry.entry_time);
  header.appendChild(time);
  if (entry.von || entry.an) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = `${entry.von || '?'} → ${entry.an || '?'}`;
    header.appendChild(badge);
  }
  el.appendChild(header);

  const message = document.createElement('div');
  message.className = 'tagebuch-entry-message';
  message.textContent = entry.message;
  el.appendChild(message);

  return el;
}

async function loadLagemeldungen(einsatzId) {
  const container = document.getElementById('lagemeldung-liste');
  try {
    const entries = await api.get(`/einsatztagebuch?einsatzId=${einsatzId}`);
    container.innerHTML = '';
    if (entries.length === 0) {
      container.innerHTML = '<p class="muted">Noch keine Lagemeldungen zu diesem Einsatz.</p>';
      return;
    }
    // Neueste zuerst (API liefert bereits entry_time DESC) - fuer Funkverkehr die gewohnte Reihenfolge.
    entries.forEach((entry) => container.appendChild(renderLagemeldungEntry(entry)));
  } catch (err) {
    container.innerHTML = '';
    document.getElementById('einsatz-aktuell-error').textContent = err.message;
  }
}

function initLagemeldungForm() {
  const form = document.getElementById('lagemeldung-form');
  const errorEl = document.getElementById('lagemeldung-form-error');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    errorEl.textContent = '';
    if (!tagebuch.aktuellerEinsatz) return;
    const message = document.getElementById('lagemeldung-message').value.trim();
    if (!message) return;

    try {
      await api.post('/einsatztagebuch', {
        einsatzId: tagebuch.aktuellerEinsatz.id,
        von: document.getElementById('lagemeldung-von').value.trim() || null,
        an: document.getElementById('lagemeldung-an').value.trim() || null,
        message,
      });
      document.getElementById('lagemeldung-message').value = '';
      await loadLagemeldungen(tagebuch.aktuellerEinsatz.id);
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });
}

// ---------------------------------------------------------------------------
// Einsatz-Archiv (abgeschlossene Einsätze)
// ---------------------------------------------------------------------------

function renderArchivEintrag(einsatz) {
  const el = document.createElement('div');
  el.className = 'tagebuch-entry';

  const header = document.createElement('div');
  header.className = 'tagebuch-entry-header';
  const title = document.createElement('span');
  title.className = 'tagebuch-entry-time';
  title.textContent = einsatz.stichwort;
  header.appendChild(title);
  if (einsatz.nummer) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = einsatz.nummer;
    header.appendChild(badge);
  }
  el.appendChild(header);

  const meta = document.createElement('div');
  meta.className = 'muted';
  const parts = [];
  if (einsatz.adresse) parts.push(einsatz.adresse);
  parts.push(`Beendet: ${einsatz.ended_at ? formatTimestamp(einsatz.ended_at) : '-'}`);
  meta.textContent = parts.join(' · ');
  el.appendChild(meta);

  const footer = document.createElement('div');
  footer.className = 'tagebuch-entry-footer';
  footer.appendChild(document.createElement('span'));

  const actions = document.createElement('div');
  actions.className = 'tagebuch-entry-actions';
  const pdfLink = document.createElement('a');
  pdfLink.className = 'button-link';
  pdfLink.href = `api/einsaetze/${einsatz.id}/pdf`;
  pdfLink.textContent = 'PDF-Bericht';
  actions.appendChild(pdfLink);

  if (tagebuch.currentUser && tagebuch.currentUser.role !== 'mitglied') {
    const reopenBtn = document.createElement('button');
    reopenBtn.type = 'button';
    reopenBtn.className = 'secondary';
    reopenBtn.textContent = 'Wiedereröffnen';
    reopenBtn.addEventListener('click', () => wiederoeffneEinsatz(einsatz.id));
    actions.appendChild(reopenBtn);
  }
  footer.appendChild(actions);
  el.appendChild(footer);

  return el;
}

async function loadEinsatzArchiv() {
  const errorEl = document.getElementById('einsatz-archiv-error');
  errorEl.textContent = '';
  const container = document.getElementById('einsatz-archiv-liste');
  const search = document.getElementById('einsatz-archiv-suche').value.trim();
  const qs = new URLSearchParams({ status: 'beendet' });
  if (search) qs.set('search', search);

  try {
    const einsaetze = await api.get(`/einsaetze?${qs.toString()}`);
    container.innerHTML = '';
    if (einsaetze.length === 0) {
      container.innerHTML = '<p class="muted">Keine abgeschlossenen Einsätze gefunden.</p>';
      return;
    }
    einsaetze.forEach((e) => container.appendChild(renderArchivEintrag(e)));
  } catch (err) {
    errorEl.textContent = err.message;
  }
}

async function wiederoeffneEinsatz(id) {
  if (!confirm('Diesen Einsatz wiedereröffnen? Er wird danach wieder als laufender Einsatz angezeigt.')) return;
  try {
    await api.patch(`/einsaetze/${id}`, { status: 'laufend' });
    await loadAktuellerEinsatz();
    await loadEinsatzArchiv();
  } catch (err) {
    document.getElementById('einsatz-archiv-error').textContent = err.message;
  }
}

// ---------------------------------------------------------------------------
// Freie Logbucheinträge (ohne Einsatzbezug - bisheriges Verhalten unverändert)
// ---------------------------------------------------------------------------

function resetForm() {
  tagebuch.editingId = null;
  document.getElementById('tagebuch-form-title').textContent = 'Freier Logbucheintrag (ohne Einsatzbezug)';
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
    // Einsatzgebundene Lagemeldungen erscheinen bereits oben unter dem jeweiligen Einsatz - hier nur
    // die freien Eintraege ohne einsatz_id, sonst wuerden Lagemeldungen doppelt auftauchen.
    renderEntries(entries.filter((e) => !e.einsatz_id));
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
  initEinsatzStartForm();
  initLagemeldungForm();

  document.getElementById('einsatz-beenden-button').addEventListener('click', beendeEinsatz);
  document.getElementById('einsatz-pdf-button').addEventListener('click', () => {
    if (tagebuch.aktuellerEinsatz) window.location.href = `api/einsaetze/${tagebuch.aktuellerEinsatz.id}/pdf`;
  });

  let archivSearchDebounce;
  document.getElementById('einsatz-archiv-suche').addEventListener('input', () => {
    clearTimeout(archivSearchDebounce);
    archivSearchDebounce = setTimeout(loadEinsatzArchiv, 300);
  });

  document.getElementById('tagebuch-filter-form').addEventListener('submit', (event) => {
    event.preventDefault();
    loadEntries();
  });
  document.getElementById('tagebuch-filter-reset').addEventListener('click', () => {
    document.getElementById('tagebuch-filter-since').value = '';
    document.getElementById('tagebuch-filter-until').value = '';
    loadEntries();
  });

  await loadPartnerOptions();
  await loadAktuellerEinsatz();
  await loadEinsatzArchiv();
  await loadEntries();
}

document.addEventListener('DOMContentLoaded', bootstrapEinsatztagebuchPage);
