// Gemeinsame Einordnung der fuenf Quellen fuer Karte + Uebersichtsliste. Jede Quelle hat eine
// eigene, nicht direkt vergleichbare Skala (siehe backend/src/notifications/evaluate.js) - hier wird
// daraus grob eine einheitliche 0-4-Dringlichkeit fuer Sortierung/Einfaerbung abgeleitet. Das ist
// bewusst eine Naeherung, keine amtliche Gefahreneinstufung.

const SOURCE_LABELS = {
  dwd_unwetter: 'DWD Unwetterwarnung',
  pegelonline: 'Pegelstand (PEGELONLINE)',
  hochwasserzentralen: 'Hochwasserlage',
  firms: 'Feuer-Hotspot (NASA FIRMS)',
  waldbrandindex: 'Waldbrandgefahrenindex',
};

// Gemeinsame Farbskala fuer Karten-Marker, genutzt vom Dashboard (map.js) und den
// Addon-Einzelseiten (addon.js).
const SEVERITY_COLORS = ['#6b7280', '#2e7d32', '#f9a825', '#ef6c00', '#c62828'];

function meldestufeNumber(severity) {
  const map = {
    kein_hochwasser: 0,
    meldestufe_1: 1,
    meldestufe_2: 2,
    meldestufe_3: 3,
    meldestufe_4_plus: 4,
  };
  return map[severity] ?? null;
}

function severityScore(dp) {
  switch (dp.source) {
    case 'dwd_unwetter':
      return dp.value_numeric ?? 0;
    case 'waldbrandindex':
      return dp.value_numeric ? Math.round((dp.value_numeric / 5) * 4) : 0;
    case 'hochwasserzentralen':
      return meldestufeNumber(dp.severity) ?? 0;
    case 'firms': {
      const map = { hoch: 4, mittel: 2, niedrig: 1 };
      return map[dp.severity] ?? 2;
    }
    case 'pegelonline':
      return dp.severity && dp.severity !== 'unbekannt' ? 1 : 0;
    default:
      return 0;
  }
}

function severityLabel(dp) {
  const score = severityScore(dp);
  return ['unauffaellig', 'gering', 'mittel', 'hoch', 'extrem'][Math.min(score, 4)];
}

function formatTimestamp(iso) {
  if (!iso) return '-';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString('de-DE');
}

function formatValue(dp) {
  if (dp.value_numeric === null || dp.value_numeric === undefined) return dp.severity || '-';
  return `${dp.value_numeric}${dp.unit ? ` ${dp.unit}` : ''}`;
}
