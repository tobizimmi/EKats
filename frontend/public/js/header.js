// Auf jeder Seite ausser login.html eingebunden: rendert die gemeinsame Seitenleisten-Navigation
// (Konzept Teil 2, Baustein A - ersetzt die bisherige horizontale Kopfzeile, die bei wachsender
// Quellenzahl zu voll wurde), prueft die Session, blendet rollenabhaengige Bereiche aus und
// verdrahtet den Logout-Button. Wirft den Nutzer zu login.html, falls keine gueltige Session
// besteht. Jede Seite traegt dafuer nur noch ein leeres <div id="app-sidebar-root"></div> statt
// eines 15-zeiligen Kopfzeilen-Blocks - genau das "gemeinsame Include" aus dem Konzept.
//
// Rollenstufen (siehe backend/sql/schema.sql): 'admin' > 'stab' > 'mitglied'. Ein Element mit
// data-role="stab-only" ist fuer 'stab' UND 'admin' sichtbar (admin ist ein Superset von stab);
// data-role="admin-only" nur fuer 'admin'.
const ROLE_LABELS = { admin: 'Admin', stab: 'Stab', mitglied: 'Mitglied' };

// Gruppierte Navigation: haelt die Themenseiten (aktuell neun, siehe README "Datenquellen") optisch
// zusammengefasst statt als lange flache Kette - deswegen war eine Seitenleiste noetig, keine
// Kopfzeile mehr. "kachelmann.html"/"wetter-vorhersage.html"/"objekte.html" sind neue Seiten
// (Konzept Teil 2, Baustein B).
const NAV_GROUPS = [
  {
    label: 'Übersicht',
    items: [
      { href: './', match: ['', 'index.html'], label: 'Karte', icon: '📍' },
      { href: 'dashboard.html', label: 'Mein Dashboard', icon: '🗂️' },
    ],
  },
  {
    label: 'Datenquellen',
    items: [
      { href: 'dwd-unwetter.html', label: 'Wetter-Warnungen', icon: '⛈️' },
      { href: 'wetter-vorhersage.html', label: 'Wetter-Vorhersage', icon: '🌤️' },
      { href: 'pegelonline.html', label: 'Pegel', icon: '🌊' },
      { href: 'hochwasserzentralen.html', label: 'Hochwasser', icon: '🌊' },
      { href: 'waldbrandindex.html', label: 'Waldbrand', icon: '🔥' },
      { href: 'firms.html', label: 'Feuer-Hotspots', icon: '🔥' },
      { href: 'bbk-warnungen.html', label: 'Bevölkerungswarnungen', icon: '📣' },
      { href: 'kachelmann.html', label: 'Kachelmann', icon: '☁️' },
      { href: 'blitzortung.html', label: 'Blitzortung', icon: '⚡' },
    ],
  },
  {
    label: 'Objekte',
    items: [{ href: 'objekte.html', label: 'Objekt-Übersicht', icon: '🏫' }],
  },
  {
    label: 'Einsatzführung',
    items: [{ href: 'einsatztagebuch.html', label: 'Einsatztagebuch', icon: '📓' }],
  },
  {
    label: 'Verwaltung',
    items: [
      { href: 'settings.html', label: 'Einstellungen', icon: '⚙️' },
      { href: 'admin.html', label: 'Admin', icon: '🛠️', role: 'admin-only' },
    ],
  },
];

function currentPage() {
  return window.location.pathname.split('/').pop() || '';
}

function renderSidebar() {
  const root = document.getElementById('app-sidebar-root');
  if (!root) return;
  // Grenzt die Seitenleisten-CSS (u.a. body-Einzug fuer den fixen linken Balken) auf Seiten ein,
  // die tatsaechlich eine Seitenleiste rendern - login.html/datenschutz.html/impressum.html binden
  // header.js gar nicht erst ein und bleiben dadurch unberuehrt.
  document.body.classList.add('has-sidebar');

  const page = currentPage();
  const groupsHtml = NAV_GROUPS.map((group) => {
    const itemsHtml = group.items
      .map((item) => {
        const isActive = item.match ? item.match.includes(page) : item.href === page;
        const roleAttr = item.role ? ` data-role="${item.role}" hidden` : '';
        return `<a class="sidebar-link${isActive ? ' active' : ''}" href="${item.href}"${roleAttr}>
          <span class="sidebar-link-icon" aria-hidden="true">${item.icon}</span>${item.label}
        </a>`;
      })
      .join('');
    return `<div class="sidebar-group">
      <div class="sidebar-group-label">${group.label}</div>
      ${itemsHtml}
    </div>`;
  }).join('');

  root.innerHTML = `
    <div class="sidebar-overlay" id="sidebar-overlay"></div>
    <aside class="app-sidebar" id="app-sidebar">
      <div class="sidebar-brand">🚒 EKats</div>
      <nav class="sidebar-nav">${groupsHtml}</nav>
      <div class="sidebar-footer">
        <span id="header-user" class="muted"></span>
        <button id="logout-button" type="button" class="secondary">Abmelden</button>
      </div>
    </aside>
    <button type="button" id="sidebar-toggle" class="sidebar-toggle" aria-label="Menü öffnen" aria-expanded="false">☰</button>
  `;

  const sidebar = document.getElementById('app-sidebar');
  const toggle = document.getElementById('sidebar-toggle');
  const overlay = document.getElementById('sidebar-overlay');

  function setOpen(open) {
    sidebar.classList.toggle('open', open);
    overlay.classList.toggle('visible', open);
    toggle.setAttribute('aria-expanded', String(open));
  }
  toggle.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')));
  overlay.addEventListener('click', () => setOpen(false));
}

async function initHeader() {
  renderSidebar();

  let user;
  try {
    user = await api.get('/auth/me');
  } catch (err) {
    window.location.href = 'login.html';
    return null;
  }

  const userLabel = document.getElementById('header-user');
  if (userLabel) {
    userLabel.textContent = `${user.email} (${ROLE_LABELS[user.role] || user.role})`;
  }

  document.querySelectorAll('[data-role="stab-only"]').forEach((el) => {
    el.hidden = user.role === 'mitglied';
  });
  document.querySelectorAll('[data-role="admin-only"]').forEach((el) => {
    el.hidden = user.role !== 'admin';
  });

  const logoutBtn = document.getElementById('logout-button');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      try {
        await api.post('/auth/logout');
      } finally {
        window.location.href = 'login.html';
      }
    });
  }

  return user;
}
