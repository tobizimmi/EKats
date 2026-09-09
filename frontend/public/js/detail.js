// Detail-Panel fuer einen einzelnen Datenpunkt - gemeinsam genutzt vom Dashboard (js/app.js) und
// den Addon-Einzelseiten (js/addon.js), damit die Darstellung ueberall identisch bleibt.

// Quellenspezifische Zusatzinformationen aus dem payload-Feld (siehe backend/src/fetchers/*.js) -
// v.a. bei DWD-Unwetterwarnungen wichtig: Beschreibung/Verhaltenshinweise werden von der DWD-API
// mitgeliefert, standen bisher aber nirgends in der App, obwohl es die "wichtigen
// Wetterinformationen" sind, die Einsatzkraefte tatsaechlich brauchen.
function payloadEntries(dp) {
  const p = dp.payload || {};
  switch (dp.source) {
    case 'dwd_unwetter':
      return [
        ['Ereignis', p.event],
        ['Bundesland', p.state],
        ['Beschreibung', p.description],
        ['Verhaltenshinweise', p.instruction],
      ];
    case 'waldbrandindex':
      return [['Bundesland', p.bundeslandCode]];
    case 'pegelonline':
      return [
        ['Gewässer', p.riverName],
        ['Zuständige Behörde', p.agency],
      ];
    case 'hochwasserzentralen':
      return [
        ['Gewässer', p.gewaesser],
        ['Bundesland', p.land],
        ['Status', p.statusText],
        ['Weitere Infos', p.stationLink],
      ];
    case 'firms':
      return [
        ['Satellit', p.satellite],
        ['Tag/Nacht', p.daynight === 'D' ? 'Tag' : p.daynight === 'N' ? 'Nacht' : p.daynight],
      ];
    case 'bbk_warnung':
      return [
        ['Warnsystem', p.provider],
        ['Ereignis', p.event],
        ['Beschreibung', p.description],
        ['Verhaltenshinweise', p.instruction],
      ];
    // degToCardinal() kommt aus js/wetter-vorhersage.js - dieser Fall greift nur auf
    // wetter-vorhersage.html, wo dieses Skript immer mitgeladen ist (siehe dortige Script-Reihenfolge).
    case 'wetter_vorhersage':
      return [
        ['Bedingung', p.condition],
        ['Niederschlag', p.precipitation !== null && p.precipitation !== undefined ? `${p.precipitation} mm` : null],
        ['Windgeschwindigkeit', p.windSpeedKmh !== null && p.windSpeedKmh !== undefined ? `${p.windSpeedKmh} km/h` : null],
        ['Windböen', p.windGustKmh !== null && p.windGustKmh !== undefined ? `${p.windGustKmh} km/h` : null],
        [
          'Windrichtung',
          p.windDirectionDeg !== null && p.windDirectionDeg !== undefined
            ? `${p.windDirectionDeg}° (${degToCardinal(p.windDirectionDeg) || '-'})`
            : null,
        ],
        ['Bewölkung', p.cloudCoverPercent !== null && p.cloudCoverPercent !== undefined ? `${p.cloudCoverPercent}%` : null],
      ];
    default:
      return [];
  }
}

function renderDetailPanel(dp) {
  const panel = document.getElementById('detail-panel');
  const content = document.getElementById('detail-content');
  content.innerHTML = '';

  const entries = [
    ['Quelle', SOURCE_LABELS[dp.source] || dp.source],
    ['Titel', dp.title || '-'],
    ['Wert', formatValue(dp)],
    ['Stufe/Status', dp.severity || '-'],
    ['Zeitstempel', formatTimestamp(dp.item_timestamp)],
    ['Zuletzt abgerufen', formatTimestamp(dp.fetched_at)],
    ...payloadEntries(dp).filter(([, value]) => value !== undefined && value !== null && value !== ''),
  ];
  entries.forEach(([label, value]) => {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value;
    content.appendChild(dt);
    content.appendChild(dd);
  });

  // Pegel-Verlauf direkt im Detail-Panel (js/pegel-chart.js) - wird dynamisch angehaengt statt in
  // jeder der zehn Seiten, die dieses Panel einbinden, einzeln im HTML ergaenzt zu werden.
  let chartContainer = document.getElementById('detail-chart');
  if (dp.source === 'pegelonline') {
    if (!chartContainer) {
      chartContainer = document.createElement('div');
      chartContainer.id = 'detail-chart';
      chartContainer.className = 'detail-chart';
      panel.appendChild(chartContainer);
    }
    chartContainer.hidden = false;
    renderPegelHistoryChart(chartContainer, dp.external_id);
  } else if (chartContainer) {
    chartContainer.hidden = true;
  }

  panel.hidden = false;
}
