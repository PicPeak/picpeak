/**
 * No test may JSON.parse an app_settings.setting_value it read from the
 * table. The parse is right on SQLite and throws on PostgreSQL for every
 * string value, and CI runs these suites on SQLite only, so a new bare parse
 * passes here and fails the first time someone runs the suite on PostgreSQL
 * (issue 1615). decodeSettingValue in ./settingValue.js decodes by engine.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const BARE_PARSE = /JSON\.parse\(\s*[\w$.?[\]'"]*setting_value\b/;

function testFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) return testFiles(file);
    return entry.name.endsWith('.js') ? [file] : [];
  });
}

test('no test JSON.parses a setting_value read from app_settings', () => {
  // This file spells the pattern out in its own examples below.
  const offenders = testFiles(root).filter((file) => file !== __filename).flatMap((file) => fs.readFileSync(file, 'utf8')
    .split('\n')
    .map((line, i) => (BARE_PARSE.test(line) ? `${path.relative(root, file)}:${i + 1}` : null))
    .filter(Boolean));
  expect(offenders).toEqual([]);
});

test('the pattern catches the shapes a bare parse takes', () => {
  expect(BARE_PARSE.test('JSON.parse(row.setting_value)')).toBe(true);
  expect(BARE_PARSE.test('JSON.parse(row?.setting_value)')).toBe(true);
  expect(BARE_PARSE.test("JSON.parse(rows[0]['setting_value'])")).toBe(true);
  expect(BARE_PARSE.test('decodeSettingValue(db, row.setting_value)')).toBe(false);
});
