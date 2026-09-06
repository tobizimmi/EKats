// Auf jeder Seite ausser login.html eingebunden: prueft die Session, fuellt Nutzerinfo im Header,
// blendet rollenabhaengige Bereiche aus und verdrahtet den Logout-Button. Wirft den Nutzer zu
// login.html, falls keine gueltige Session besteht.
//
// Rollenstufen (siehe backend/sql/schema.sql): 'admin' > 'stab' > 'mitglied'. Ein Element mit
// data-role="stab-only" ist fuer 'stab' UND 'admin' sichtbar (admin ist ein Superset von stab);
// data-role="admin-only" nur fuer 'admin'.
const ROLE_LABELS = { admin: 'Admin', stab: 'Stab', mitglied: 'Mitglied' };

async function initHeader() {
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
