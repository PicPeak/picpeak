import { describe, expect, it } from 'vitest';
import type { TFunction } from 'i18next';
import { BACKUP_ERROR_CODES, backupErrorCode, backupErrorText } from '../backupErrors';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';

describe('backup error localization', () => {
  it.each(BACKUP_ERROR_CODES)('recognizes %s in API responses and recorded run errors, with EN/DE text', code => {
    expect(backupErrorCode({ response: { data: { code } } })).toBe(code);
    expect(backupErrorCode(`${code}: operator detail`)).toBe(code);
    expect(backupErrorText(code, ((key: string) => key) as TFunction)).toBe(`backup.errors.${code}`);
    expect(en.backup.errors[code]).toBeTruthy();
    expect(de.backup.errors[code]).toBeTruthy();
  });
  it('does not reinterpret unknown error codes', () => {
    expect(backupErrorCode('RSYNC_NOT_REAL: detail')).toBeNull();
    expect(backupErrorText(null, ((key: string) => key) as TFunction)).toBeNull();
  });
});
