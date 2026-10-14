import { describe, expect, it, vi } from 'vitest';
import type { TFunction } from 'i18next';
import en from '../../i18n/locales/en.json';
import de from '../../i18n/locales/de.json';
import { archiveInProgressError } from '../archiveErrors';

describe('archiveInProgressError', () => {
  it('translates the 409 a second archive, restore or delete gets while a job runs (issue 2012)', () => {
    const t = vi.fn((key: string) => `translated:${key}`) as unknown as TFunction;
    const error = { response: { status: 409, data: { code: 'ARCHIVE_IN_PROGRESS', error: 'server text' } } };
    expect(archiveInProgressError(error, t)).toBe('translated:events.archiveInProgress');
  });

  it.each([null, undefined, new Error('offline'), {}, { response: { data: { code: 'EVENT_NOT_FOUND' } } }])(
    'leaves every other error to the caller',
    (error) => {
      const t = vi.fn() as unknown as TFunction;
      expect(archiveInProgressError(error, t)).toBeUndefined();
      expect(t).not.toHaveBeenCalled();
    },
  );

  it.each([en, de])('has the message in each locale', (locale) => {
    expect(locale.events.archiveInProgress).toBeTruthy();
  });
});
