// Web-Push-Anmeldung (VAPID). Kanal fuer Schwellenwert-Benachrichtigungen neben E-Mail (siehe
// CLAUDE.md 2.2). Wird von settings.js in die Seite eingebunden.

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function initPushUi(statusEl, buttonEl) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    statusEl.textContent = 'Push-Benachrichtigungen werden von diesem Browser nicht unterstützt.';
    buttonEl.disabled = true;
    return;
  }

  const registration = await registerServiceWorker();
  if (!registration) {
    statusEl.textContent = 'Service Worker konnte nicht registriert werden.';
    buttonEl.disabled = true;
    return;
  }

  async function refreshStatus() {
    const existing = await registration.pushManager.getSubscription();
    if (existing) {
      statusEl.textContent = 'Push-Benachrichtigungen sind aktiv.';
      buttonEl.textContent = 'Push-Benachrichtigungen deaktivieren';
    } else {
      statusEl.textContent = 'Push-Benachrichtigungen sind nicht aktiv.';
      buttonEl.textContent = 'Push-Benachrichtigungen aktivieren';
    }
  }

  buttonEl.addEventListener('click', async () => {
    buttonEl.disabled = true;
    try {
      const existing = await registration.pushManager.getSubscription();
      if (existing) {
        await api.delete('/push/subscribe', { endpoint: existing.endpoint });
        await existing.unsubscribe();
      } else {
        const { publicKey } = await api.get('/push/vapid-public-key');
        if (!publicKey) {
          statusEl.textContent = 'Server hat noch keinen VAPID-Schlüssel konfiguriert (.env).';
          return;
        }
        const subscription = await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
        await api.post('/push/subscribe', subscription.toJSON());
      }
    } catch (err) {
      statusEl.textContent = `Fehler: ${err.message}`;
    } finally {
      buttonEl.disabled = false;
      await refreshStatus();
    }
  });

  await refreshStatus();
}
