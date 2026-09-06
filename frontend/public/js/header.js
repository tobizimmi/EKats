// Auf jeder Seite ausser login.html eingebunden: prueft die Session, fuellt Nutzerinfo im Header,
// blendet "stab"-only Links aus und verdrahtet den Logout-Button. Wirft den Nutzer zu login.html,
// falls keine gueltige Session besteht.
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
    userLabel.textContent = `${user.email} (${user.role === 'stab' ? 'Stab' : 'Mitglied'})`;
  }

  document.querySelectorAll('[data-role="stab-only"]').forEach((el) => {
    el.hidden = user.role !== 'stab';
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
