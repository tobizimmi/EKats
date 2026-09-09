// Gemeinsame Pegel-Verlauf-Grafik (14 Tage, aus GET /api/datapoints/history, Migration 013) -
// urspruenglich nur im Dashboard-Widget (js/dashboard.js, Konzept Teil 2 Baustein D), jetzt auch im
// Detail-Panel der Pegel-Themenseite (js/detail.js) genutzt, damit der Verlauf direkt beim Klick auf
// einen Pegel sichtbar ist statt nur ueber ein separat hinzuzufuegendes Dashboard-Widget.
async function renderPegelHistoryChart(container, externalId) {
  container.innerHTML = '<p class="muted">Lade…</p>';
  let history;
  try {
    history = await api.get(`/datapoints/history?source=pegelonline&externalId=${encodeURIComponent(externalId)}`);
  } catch (err) {
    container.innerHTML = '<p class="error-message">Verlauf konnte nicht geladen werden.</p>';
    return;
  }

  const points = history.filter((h) => h.value_numeric !== null && h.value_numeric !== undefined);
  if (points.length < 2) {
    container.innerHTML =
      '<p class="muted">Noch nicht genug Verlaufsdaten (sammelt sich mit jedem Abruf, alle 15 Min. - Rückblick 14 Tage).</p>';
    return;
  }

  const values = points.map((p) => p.value_numeric);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const w = 320;
  const h = 90;
  const coords = points.map((p, i) => {
    const x = (i / (points.length - 1)) * w;
    const y = h - ((p.value_numeric - min) / range) * h;
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = points[points.length - 1];
  const lastCoord = coords[coords.length - 1].split(',');

  container.innerHTML = `
    <svg class="widget-chart-svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="Pegelverlauf der letzten 14 Tage, aktueller Wert ${last.value_numeric} ${last.unit || ''}">
      <polyline points="${coords.join(' ')}" fill="none" stroke="var(--focus)" stroke-width="2" />
      <circle cx="${lastCoord[0]}" cy="${lastCoord[1]}" r="3" fill="var(--focus)" />
    </svg>
    <p class="muted widget-chart-caption">Aktuell: ${last.value_numeric} ${last.unit || ''} · Verlauf 14 Tage (min ${min}, max ${max})</p>
  `;
}
