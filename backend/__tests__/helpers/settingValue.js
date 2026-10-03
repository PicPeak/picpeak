/**
 * Decode an app_settings.setting_value read straight from the table.
 *
 * The column holds JSON on both engines, but the drivers hand it back in
 * different shapes: on SQLite it is TEXT and comes back as the JSON text
 * ('"local"'), on PostgreSQL it is json and `pg` returns the decoded value
 * ('local'). A bare JSON.parse is right on SQLite and throws on PostgreSQL
 * for every string value ("local" is not valid JSON), failing the test for a
 * reason that has nothing to do with what it guards (issue 1615). CI runs
 * these suites on SQLite only, so nothing there catches a new bare
 * JSON.parse of a row.
 *
 * Keyed on the engine, not on the value's shape: a stored string such as
 * "true" or "90" would otherwise decode to a boolean or a number on
 * PostgreSQL and stay a string on SQLite.
 *
 * Only for a table the core migrations built (bootCrmDb). A suite that
 * creates app_settings by hand with a text column on PostgreSQL (usageV3,
 * productUsagePg, externalRelpathFoldPg) gets the JSON text back there too,
 * and this helper would hand it over undecoded.
 */
const decodeSettingValue = (db, value) =>
  (db.client.config.client === 'pg' ? value : JSON.parse(value));

module.exports = { decodeSettingValue };
