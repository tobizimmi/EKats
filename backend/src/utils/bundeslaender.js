// Zuordnung Bundesland-Name <-> DWD-Kfz-Kennzeichen-Code (stateShort in warnings.json).
// Extrahiert aus fetchers/dwdStationsImport.js, damit dieselbe verifizierte Tabelle auch fuer die
// Bundesland-Flaechen-Aggregation (siehe importLandkreise.js) genutzt wird - eine zweite,
// unabhaengige Kopie waere ein Drift-Risiko (siehe z.B. den Datensatz, der Brandenburg
// faelschlich als "BR" statt "BB" fuehrt).
const BUNDESLAND_NAME_TO_CODE = [
  ['Schleswig-Holstein', 'SH'],
  ['Hamburg', 'HH'],
  ['Niedersachsen', 'NI'],
  ['Bremen', 'HB'],
  ['Nordrhein-Westfalen', 'NW'],
  ['Hessen', 'HE'],
  ['Rheinland-Pfalz', 'RP'],
  ['Baden-Württemberg', 'BW'],
  ['Bayern', 'BY'],
  ['Saarland', 'SL'],
  ['Berlin', 'BE'],
  ['Brandenburg', 'BB'],
  ['Mecklenburg-Vorpommern', 'MV'],
  // Sachsen-Anhalt muss vor Sachsen geprueft werden, sonst Fehltreffer.
  ['Sachsen-Anhalt', 'ST'],
  ['Sachsen', 'SN'],
  ['Thüringen', 'TH'],
];

const NAME_TO_CODE_MAP = new Map(BUNDESLAND_NAME_TO_CODE);

function codeForName(name) {
  return NAME_TO_CODE_MAP.get(name) || null;
}

module.exports = { BUNDESLAND_NAME_TO_CODE, codeForName };
