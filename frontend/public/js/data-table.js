// Generische, wiederverwendbare Tabellen-Komponente fuer die Themenseiten (Konzept Teil 2,
// Baustein B): Suche, Spalten-Ein-/Ausblenden (serverseitig ueber /api/user-preferences
// persistiert, geraeteuebergreifend nutzbar, mit Zuruecksetzen-Button) und CSV-Export. Ersetzt auf
// den Addon-Einzelseiten die bisherige reine Liste. Basisspalten sind quellen-unabhaengig (jeder
// Datenpunkt hat sie); Zusatzspalten stammen aus tatsaechlich verifizierten payload-Feldern der
// jeweiligen Fetcher (siehe backend/src/fetchers/*.js) - keine erfundenen Feldnamen. wetter_vorhersage
// fehlt hier bewusst: die eigene Ansicht (js/wetter-vorhersage.js, wetter-vorhersage.html) nutzt diese
// Tabellen-Komponente nicht mehr, siehe README "Themenseiten je Datenquelle".

const BASE_COLUMNS = [
  { key: 'title', label: 'Titel', default: true, get: (dp) => dp.title || '–' },
  { key: 'severity', label: 'Dringlichkeit', default: true, get: (dp) => severityLabel(dp) },
  { key: 'value', label: 'Wert', default: true, get: (dp) => formatValue(dp) },
  { key: 'landkreis', label: 'Landkreis', default: true, get: (dp) => dp.landkreis_name || '–' },
  { key: 'timestamp', label: 'Zeitpunkt', default: true, get: (dp) => formatTimestamp(dp.item_timestamp || dp.fetched_at) },
  { key: 'validUntil', label: 'Gültig bis', default: false, get: (dp) => (dp.valid_until ? formatTimestamp(dp.valid_until) : '–') },
];

const SOURCE_EXTRA_COLUMNS = {
  dwd_unwetter: [
    { key: 'event', label: 'Ereignis', default: false, get: (dp) => dp.payload?.event || '–' },
    { key: 'state', label: 'Bundesland', default: false, get: (dp) => dp.payload?.state || '–' },
  ],
  pegelonline: [
    { key: 'river', label: 'Gewässer', default: true, get: (dp) => dp.payload?.riverName || '–' },
    { key: 'agency', label: 'Behörde', default: false, get: (dp) => dp.payload?.agency || '–' },
  ],
  hochwasserzentralen: [
    { key: 'gewaesser', label: 'Gewässer', default: true, get: (dp) => dp.payload?.gewaesser || '–' },
    { key: 'statusText', label: 'Status', default: false, get: (dp) => dp.payload?.statusText || '–' },
  ],
  waldbrandindex: [{ key: 'stationName', label: 'Station', default: true, get: (dp) => dp.payload?.stationName || '–' }],
  firms: [
    { key: 'confidence', label: 'Konfidenz', default: true, get: (dp) => dp.payload?.confidence ?? '–' },
    { key: 'daynight', label: 'Tag/Nacht', default: false, get: (dp) => dp.payload?.daynight || '–' },
  ],
  bbk_warnung: [
    { key: 'provider', label: 'Warnsystem', default: true, get: (dp) => dp.payload?.provider || '–' },
    { key: 'event', label: 'Ereignis', default: false, get: (dp) => dp.payload?.event || '–' },
  ],
  kachelmann: [],
  // "Wert" (Basisspalte) zeigt bereits die Ortungsgenauigkeit in Metern (value_numeric/unit) - hier
  // nur das payload-Feld, das die Basisspalten nicht abdecken.
  blitzortung: [{ key: 'polarity', label: 'Polarität', default: false, get: (dp) => dp.payload?.polarity ?? '–' }],
};

function columnsForSource(source) {
  return [...BASE_COLUMNS, ...(SOURCE_EXTRA_COLUMNS[source] || [])];
}

// Generisch fuer beliebige Zeilenobjekte (Datenpunkte auf den Themenseiten, Objekte auf
// objekte.html, ...) - eine Spalte hat entweder `get(row)` (liefert reinen Text) oder `render(td,
// row)` (baut die Zelle selbst, z.B. fuer die Karten-Mini-Vorschau). `rowKey`/`selectable` schalten
// eine Checkbox-Spalte fuer Massenbearbeitung frei.
class DataTable {
  constructor({ containerEl, prefKey, source, columns, searchText, onRowClick, selectable, onSelectionChange, rowKey }) {
    this.containerEl = containerEl;
    this.prefKey = prefKey;
    this.columns = columns || columnsForSource(source);
    this.searchText = searchText || ((row) => row.title || '');
    this.onRowClick = onRowClick;
    this.selectable = !!selectable;
    this.onSelectionChange = onSelectionChange;
    this.rowKey = rowKey || ((row) => row.id);
    this.rows = [];
    this.selectedKeys = new Set();
    this.visibleKeys = new Set(this.columns.filter((c) => c.default).map((c) => c.key));
    this.searchTerm = '';
  }

  async loadColumnPrefs() {
    try {
      const pref = await api.get(`/user-preferences/${this.prefKey}`);
      if (pref && Array.isArray(pref.value)) {
        const known = new Set(this.columns.map((c) => c.key));
        this.visibleKeys = new Set(pref.value.filter((k) => known.has(k)));
      }
    } catch (err) {
      // Ohne (oder mit fehlerhafter) gespeicherter Praeferenz bleiben die Standard-Spalten aktiv.
    }
  }

  saveColumnPrefs() {
    api.put(`/user-preferences/${this.prefKey}`, { value: [...this.visibleKeys] }).catch((err) => {
      console.error('[data-table] Spalten-Einstellung konnte nicht gespeichert werden:', err);
    });
  }

  async resetColumnPrefs() {
    try {
      await api.delete(`/user-preferences/${this.prefKey}`);
    } catch (err) {
      console.error('[data-table] Zuruecksetzen fehlgeschlagen:', err);
    }
    this.visibleKeys = new Set(this.columns.filter((c) => c.default).map((c) => c.key));
    this.renderTable();
  }

  setData(rows) {
    this.rows = rows;
    // Auswahl auf Zeilen einschraenken, die nach dem Neuladen noch existieren - vermeidet
    // "Geister"-Markierungen fuer inzwischen geloeschte/herausgefilterte Objekte.
    const stillPresent = new Set(rows.map((r) => this.rowKey(r)));
    this.selectedKeys.forEach((k) => {
      if (!stillPresent.has(k)) this.selectedKeys.delete(k);
    });
    this.renderTable();
  }

  filteredRows() {
    const term = this.searchTerm.trim().toLowerCase();
    if (!term) return this.rows;
    return this.rows.filter((row) => this.searchText(row).toLowerCase().includes(term));
  }

  getSelectedRows() {
    return this.rows.filter((row) => this.selectedKeys.has(this.rowKey(row)));
  }

  exportCsv() {
    const cols = this.columns.filter((c) => this.visibleKeys.has(c.key) && c.get);
    const rows = this.filteredRows();
    const escapeCsv = (v) => `"${String(v).replace(/"/g, '""')}"`;
    const lines = [cols.map((c) => escapeCsv(c.label)).join(';')];
    rows.forEach((dp) => lines.push(cols.map((c) => escapeCsv(c.get(dp))).join(';')));

    // BOM voran, damit Excel die UTF-8-Kodierung (Umlaute) korrekt erkennt.
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${this.prefKey.replace(/[^a-z0-9_-]/gi, '_')}-export.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async init() {
    await this.loadColumnPrefs();
    this.renderToolbar();
    this.renderTable();
  }

  renderToolbar() {
    const toolbar = document.createElement('div');
    toolbar.className = 'data-table-toolbar';

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Suche…';
    search.className = 'data-table-search';
    search.addEventListener('input', () => {
      // Entprellt (250ms) - verhindert bei jedem Tastendruck ein volles Neu-Rendern, das bei
      // sichtbarer Karten-Mini-Vorschau-Spalte mehrere Leaflet-Instanzen neu aufbauen wuerde.
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => {
        this.searchTerm = search.value;
        this.renderTable();
      }, 250);
    });
    toolbar.appendChild(search);

    const colPicker = document.createElement('div');
    colPicker.className = 'data-table-colpicker';
    this.columns.forEach((col) => {
      const chip = document.createElement('label');
      chip.className = 'data-table-chip';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = this.visibleKeys.has(col.key);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.visibleKeys.add(col.key);
        else this.visibleKeys.delete(col.key);
        this.saveColumnPrefs();
        this.renderTable();
      });
      chip.appendChild(checkbox);
      chip.appendChild(document.createTextNode(col.label));
      colPicker.appendChild(chip);
    });
    toolbar.appendChild(colPicker);

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'secondary';
    resetBtn.textContent = '↺ Spalten zurücksetzen';
    resetBtn.addEventListener('click', () => {
      this.resetColumnPrefs().then(() => {
        colPicker.querySelectorAll('input').forEach((checkbox, i) => {
          checkbox.checked = this.visibleKeys.has(this.columns[i].key);
        });
      });
    });
    toolbar.appendChild(resetBtn);

    const csvBtn = document.createElement('button');
    csvBtn.type = 'button';
    csvBtn.className = 'secondary';
    csvBtn.textContent = 'CSV-Export';
    csvBtn.addEventListener('click', () => this.exportCsv());
    toolbar.appendChild(csvBtn);

    this.containerEl.appendChild(toolbar);

    this.tableWrap = document.createElement('div');
    this.tableWrap.className = 'table-wrap';
    this.containerEl.appendChild(this.tableWrap);
  }

  renderTable() {
    const cols = this.columns.filter((c) => this.visibleKeys.has(c.key));
    const rows = this.filteredRows();
    const extraCols = (this.selectable ? 1 : 0) + cols.length;

    const table = document.createElement('table');
    table.className = 'data-table';
    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    if (this.selectable) {
      const th = document.createElement('th');
      const selectAll = document.createElement('input');
      selectAll.type = 'checkbox';
      selectAll.checked = rows.length > 0 && rows.every((row) => this.selectedKeys.has(this.rowKey(row)));
      selectAll.addEventListener('change', () => {
        rows.forEach((row) => {
          if (selectAll.checked) this.selectedKeys.add(this.rowKey(row));
          else this.selectedKeys.delete(this.rowKey(row));
        });
        this.renderTable();
        if (this.onSelectionChange) this.onSelectionChange(this.getSelectedRows());
      });
      th.appendChild(selectAll);
      headRow.appendChild(th);
    }
    cols.forEach((c) => {
      const th = document.createElement('th');
      th.textContent = c.label;
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    // Spalten mit `mount` (z.B. Karten-Mini-Vorschau) bauen im ersten Durchlauf nur einen Platzhalter
    // - echte Initialisierung (z.B. Leaflet, das eine im Dokument haengende, bemasste Zelle braucht)
    // erfolgt erst NACHDEM die Tabelle tatsaechlich angehaengt wurde, siehe Ende dieser Methode.
    const pendingMounts = [];

    const tbody = document.createElement('tbody');
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = extraCols || 1;
      td.className = 'muted';
      td.textContent = 'Keine Treffer.';
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
    rows.forEach((row) => {
      const tr = document.createElement('tr');
      if (this.selectable) {
        const td = document.createElement('td');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = this.selectedKeys.has(this.rowKey(row));
        checkbox.addEventListener('click', (event) => event.stopPropagation());
        checkbox.addEventListener('change', () => {
          if (checkbox.checked) this.selectedKeys.add(this.rowKey(row));
          else this.selectedKeys.delete(this.rowKey(row));
          if (this.onSelectionChange) this.onSelectionChange(this.getSelectedRows());
        });
        td.appendChild(checkbox);
        tr.appendChild(td);
      }
      cols.forEach((c) => {
        const td = document.createElement('td');
        if (c.render) c.render(td, row);
        else td.textContent = c.get(row);
        if (c.mount) pendingMounts.push(() => c.mount(td, row));
        tr.appendChild(td);
      });
      if (this.onRowClick) {
        tr.classList.add('data-table-row-clickable');
        tr.addEventListener('click', () => this.onRowClick(row));
      }
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);

    this.tableWrap.innerHTML = '';
    this.tableWrap.appendChild(table);
    pendingMounts.forEach((mount) => mount());
  }
}
