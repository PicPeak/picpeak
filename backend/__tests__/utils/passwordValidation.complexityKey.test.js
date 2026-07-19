/**
 * Regression tests for the password-complexity setting read path.
 *
 * Bug 1 (key mismatch): the settings UI saves the admin's choice as
 * `security_password_complexity` (useSettingsState.ts prefixes every
 * security field with `security_`), but getPasswordComplexitySettings()
 * queried `security_password_complexity_level` — a key nothing writes —
 * so the configured level was silently ignored.
 *
 * Bug 2 (driver shape, codex review of #843): on SQLite the TEXT column
 * returns the JSON-stringified value ('"very_strong"'), but on Postgres
 * (production default) `setting_value` is a json column and comes back
 * already decoded ('very_strong'). A bare JSON.parse throws on the
 * decoded shape and the outer catch fell back to 'moderate' — the
 * setting stayed unenforced on Postgres even with the right key.
 */

const mockQueriedKeys = [];
let mockStoredValue;

jest.mock('../../src/database/db', () => ({
  db: () => ({
    where(_col, key) {
      mockQueriedKeys.push(key);
      return this;
    },
    first() {
      return Promise.resolve(
        mockQueriedKeys[mockQueriedKeys.length - 1] === 'security_password_complexity'
          ? { setting_key: 'security_password_complexity', setting_value: mockStoredValue }
          : undefined
      );
    },
  }),
  withRetry: (fn) => fn(),
}));

const { getPasswordComplexitySettings } = require('../../src/utils/passwordValidation');

describe('getPasswordComplexitySettings', () => {
  beforeEach(() => { mockQueriedKeys.length = 0; });

  it('reads the key the settings UI actually writes (SQLite shape: JSON-stringified)', async () => {
    mockStoredValue = JSON.stringify('very_strong'); // '"very_strong"'
    const level = await getPasswordComplexitySettings();
    expect(mockQueriedKeys).toContain('security_password_complexity');
    expect(level).toBe('very_strong');
  });

  it('accepts the Postgres json-column shape (already decoded, no quotes)', async () => {
    mockStoredValue = 'very_strong'; // pg driver auto-parses the json column
    const level = await getPasswordComplexitySettings();
    expect(level).toBe('very_strong');
  });

  it('falls back to moderate on an empty value', async () => {
    mockStoredValue = '';
    const level = await getPasswordComplexitySettings();
    expect(level).toBe('moderate');
  });
});
