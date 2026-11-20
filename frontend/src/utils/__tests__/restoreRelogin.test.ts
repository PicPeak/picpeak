/**
 * The marker the restore wizard leaves in sessionStorage so a restore that
 * signs the admin out (it replaced admin_users) reopens on its result after
 * the next sign-in.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../../config/api';
import { clearRestoreRun, isRunOf, noteRestoreSignOut, readRestoreRun, rememberRestoreRun } from '../restoreRelogin';

const startedAfter = '2026-11-20T10:00:00.000Z';

describe('restore run marker', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips and clears', () => {
    expect(readRestoreRun()).toBeNull();
    rememberRestoreRun({ startedAfter });
    expect(readRestoreRun()).toEqual({ startedAfter });
    clearRestoreRun();
    expect(readRestoreRun()).toBeNull();
  });

  it('ignores a malformed entry', () => {
    sessionStorage.setItem('picpeak_restore_run', '{not json');
    expect(readRestoreRun()).toBeNull();
    sessionStorage.setItem('picpeak_restore_run', '{"startedAfter":5}');
    expect(readRestoreRun()).toBeNull();
  });

  it('notes a sign-out only while a restore is tracked', () => {
    noteRestoreSignOut();
    expect(readRestoreRun()).toBeNull();
    rememberRestoreRun({ startedAfter });
    noteRestoreSignOut();
    expect(readRestoreRun()).toEqual({ startedAfter, signedOut: true });
  });

  it('matches only rows started at or after the marker, in every timestamp shape', () => {
    const marker = { startedAfter };
    expect(isRunOf({ started_at: '2026-11-20T10:00:00.000Z' }, marker)).toBe(true);
    expect(isRunOf({ started_at: '2026-11-20T10:00:00.250Z' }, marker)).toBe(true);
    // SQLite rows restored from a dump can carry epoch milliseconds.
    expect(isRunOf({ started_at: Date.parse('2026-11-20T10:00:01.000Z') }, marker)).toBe(true);
    expect(isRunOf({ started_at: '2026-11-19T22:00:00.000Z' }, marker)).toBe(false);
    expect(isRunOf({ started_at: null }, marker)).toBe(false);
    expect(isRunOf({}, marker)).toBe(false);
    expect(isRunOf(undefined, marker)).toBe(false);
  });
});

describe('api 401 during a tracked restore', () => {
  const originalAdapter = api.defaults.adapter;
  beforeEach(() => sessionStorage.clear());
  afterEach(() => { api.defaults.adapter = originalAdapter; });

  const answer401 = (code: string) => {
    const adapter: AxiosAdapter = async (config) => {
      throw new AxiosError('Request failed with status code 401', AxiosError.ERR_BAD_REQUEST, config, {}, {
        status: 401, statusText: '', headers: {}, config: config as InternalAxiosRequestConfig,
        data: { error: 'Session invalidated', code },
      });
    };
    api.defaults.adapter = adapter;
  };

  it('marks the tracked restore as having signed the admin out', async () => {
    rememberRestoreRun({ startedAfter });
    answer401('SESSION_INVALIDATED');
    await expect(api.get('/admin/restore/status')).rejects.toMatchObject({ response: { status: 401 } });
    expect(readRestoreRun()).toEqual({ startedAfter, signedOut: true });
  });

  it('leaves no marker behind when no restore is tracked', async () => {
    answer401('TOKEN_EXPIRED');
    await expect(api.get('/admin/events')).rejects.toBeTruthy();
    expect(readRestoreRun()).toBeNull();
  });
});
