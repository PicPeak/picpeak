/**
 * Regression test for the password-complexity setting key mismatch.
 *
 * The settings UI saves the admin's choice as `security_password_complexity`
 * (useSettingsState.ts prefixes every security field with `security_`), but
 * getPasswordComplexitySettings() queried `security_password_complexity_level`
 * — a key nothing writes — so the configured level was silently ignored and
 * validation always ran on the 'moderate' default.
 */

const queriedKeys = [];

jest.mock('../../src/database/db', () => ({
  db: () => ({
    where(_col, key) {
      queriedKeys.push(key);
      return this;
    },
    first() {
      // The row as the settings UI writes it (JSON-stringified value).
      return Promise.resolve(
        queriedKeys[queriedKeys.length - 1] === 'security_password_complexity'
          ? { setting_key: 'security_password_complexity', setting_value: JSON.stringify('very_strong') }
          : undefined
      );
    },
  }),
  withRetry: (fn) => fn(),
}));

const { getPasswordComplexitySettings } = require('../../src/utils/passwordValidation');

describe('getPasswordComplexitySettings', () => {
  it('reads the key the settings UI actually writes', async () => {
    const level = await getPasswordComplexitySettings();
    expect(queriedKeys).toContain('security_password_complexity');
    expect(level).toBe('very_strong');
  });
});
