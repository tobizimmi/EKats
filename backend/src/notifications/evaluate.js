// Schwellenwert-Engine: nach jedem Fetcher-Lauf werden die neu geschriebenen live_datapoint-Zeilen
// gegen die aktiven alert_rule-Zeilen der jeweiligen Quelle geprueft. alert_log verhindert, dass
// dieselbe Regel/Datapoint/Kanal-Kombination mehrfach ausloest (siehe UNIQUE-Constraint im Schema).
//
// threshold_key je Quelle (siehe README "Benachrichtigungen" fuer die Nutzer-Doku):
//   dwd_unwetter        -> 'warnstufe'      (threshold_value 1-4, target_ref optional = Bundesland-Code)
//   pegelonline         -> 'wasserstand_cm' (threshold_value cm, target_ref = Pegelname-Teilstring, PFLICHT)
//   hochwasserzentralen -> 'meldestufe'     (threshold_value 0-4, target_ref optional = Namens-Teilstring)
//   waldbrandindex      -> 'gefahrenstufe'  (threshold_value 1-5, target_ref optional = Bundesland-Code)
//   firms               -> 'radius_km'      (threshold_value km um den Wehr-Kartenmittelpunkt)
//   erdbeben            -> 'magnitude'      (threshold_value Mindest-Magnitude, kein target_ref)

const { query } = require('../db');
const { haversineKm } = require('../utils/geo');
const { sendPushToUser } = require('./push');
const { sendMail } = require('./mailer');

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

function checkThreshold(source, dp, rule, wehrCenter) {
  const thresholdValue = Number(rule.threshold_value);

  switch (source) {
    case 'dwd_unwetter': {
      if (rule.target_ref && dp.payload?.bundeslandCode !== rule.target_ref) return false;
      return dp.value_numeric !== null && dp.value_numeric >= thresholdValue;
    }
    case 'pegelonline': {
      if (!rule.target_ref) return false;
      if (!dp.title || !dp.title.toLowerCase().includes(rule.target_ref.toLowerCase())) return false;
      return dp.value_numeric !== null && dp.value_numeric >= thresholdValue;
    }
    case 'hochwasserzentralen': {
      if (rule.target_ref && !(dp.title || '').toLowerCase().includes(rule.target_ref.toLowerCase())) {
        return false;
      }
      const stufe = meldestufeNumber(dp.severity);
      return stufe !== null && stufe >= thresholdValue;
    }
    case 'waldbrandindex': {
      if (rule.target_ref && dp.payload?.bundeslandCode !== rule.target_ref) return false;
      return dp.value_numeric !== null && dp.value_numeric >= thresholdValue;
    }
    case 'firms': {
      if (!wehrCenter || dp.lat === null || dp.lon === null) return false;
      const distance = haversineKm(wehrCenter.center_lat, wehrCenter.center_lon, dp.lat, dp.lon);
      return distance <= thresholdValue;
    }
    case 'erdbeben':
      return dp.value_numeric !== null && dp.value_numeric >= thresholdValue;
    default:
      return false;
  }
}

async function evaluateAlertsForSource(source, datapointRows) {
  if (!datapointRows || datapointRows.length === 0) return { triggered: 0 };

  const { rows: rules } = await query(
    `SELECT ar.id, ar.user_id, ar.target_ref, ar.threshold_key, ar.threshold_value,
            ar.channel_push, ar.channel_email, u.email, w.id AS wehr_id, w.center_lat, w.center_lon
     FROM alert_rule ar
     JOIN app_user u ON u.id = ar.user_id
     JOIN wehr w ON w.id = u.wehr_id
     WHERE ar.source = $1 AND ar.active = true`,
    [source]
  );
  if (rules.length === 0) return { triggered: 0 };

  let triggered = 0;

  for (const dp of datapointRows) {
    for (const rule of rules) {
      const wehrCenter =
        rule.center_lat !== null && rule.center_lon !== null
          ? { center_lat: rule.center_lat, center_lon: rule.center_lon }
          : null;

      if (!checkThreshold(source, dp, rule, wehrCenter)) continue;

      const channels = [];
      if (rule.channel_push) channels.push('push');
      if (rule.channel_email) channels.push('email');

      for (const channel of channels) {
        const { rowCount } = await query(
          `INSERT INTO alert_log (alert_rule_id, live_datapoint_id, channel)
           VALUES ($1, $2, $3)
           ON CONFLICT (alert_rule_id, live_datapoint_id, channel) DO NOTHING`,
          [rule.id, dp.id, channel]
        );
        if (rowCount === 0) continue; // bereits ausgeloest fuer diese Kombination

        triggered += 1;
        const subject = `EKats-Alarm: ${dp.title || source}`;
        const text = `${dp.title || source}\nWert: ${dp.value_numeric ?? '-'} ${dp.unit ?? ''}\nStufe: ${
          dp.severity ?? '-'
        }\nZeitpunkt: ${dp.item_timestamp ?? '-'}`;

        try {
          if (channel === 'push') {
            await sendPushToUser(rule.user_id, { title: subject, body: text, source, datapointId: dp.id });
          } else if (channel === 'email') {
            await sendMail({ to: rule.email, subject, text, wehrId: rule.wehr_id });
          }
        } catch (err) {
          console.error(`[alerts] Versand (${channel}) fuer Regel ${rule.id} fehlgeschlagen:`, err.message);
        }
      }
    }
  }

  return { triggered };
}

module.exports = { evaluateAlertsForSource };
