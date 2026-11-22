/**
 * The marker the restore wizard leaves in sessionStorage so a restore that
 * signs the admin out (it replaced admin_users) reopens on its result after
 * the next sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AxiosError, type AxiosAdapter, type InternalAxiosRequestConfig } from 'axios';
import { api } from '../../config/api';
import {
  clearRestoreRun, isRunOf, noteRestoreSignOut, readRestoreRun, rearmRestoreRedirect, rememberRestoreRun,
  RESTORE_RUN_TTL_MS, takeRestoreRedirect,
} from '../restoreRelogin';

const runStartedAt = '2026-11-20T10:00:00.000Z';
const fresh = () => ({ runStartedAt, since: Date.now() });

describe('restore run marker', () => {
  beforeEach(() => sessionStorage.clear());

  it('round-trips and clears', () => {
    expect(readRestoreRun()).toBeNull();
    const marker = fresh();
    rememberRestoreRun(marker);
    expect(readRestoreRun()).toEqual(marker);
    clearRestoreRun();
    expect(readRestoreRun()).toBeNull();
  });

  it('ignores a malformed entry', () => {
    sessionStorage.setItem('picpeak_restore_run', '{not json');
    expect(readRestoreRun()).toBeNull();
    sessionStorage.setItem('picpeak_restore_run', '{"runStartedAt":5}');
    expect(readRestoreRun()).toBeNull();
    // Without the browser-clock start it cannot expire, so it is dropped.
    sessionStorage.setItem('picpeak_restore_run', JSON.stringify({ runStartedAt }));
    expect(readRestoreRun()).toBeNull();
    expect(sessionStorage.getItem('picpeak_restore_run')).toBeNull();
  });

  it('notes a sign-out only while a restore is tracked', () => {
    noteRestoreSignOut();
    expect(readRestoreRun()).toBeNull();
    const marker = fresh();
    rememberRestoreRun(marker);
    noteRestoreSignOut();
    expect(readRestoreRun()).toEqual({ ...marker, signedOut: true });
  });

  it('expires two hours after the start', () => {
    const now = Date.now();
    rememberRestoreRun({ runStartedAt, since: now - RESTORE_RUN_TTL_MS + 1000 });
    expect(readRestoreRun()).not.toBeNull();
    const spy = vi.spyOn(Date, 'now').mockReturnValue(now + 2000);
    try {
      expect(readRestoreRun()).toBeNull();
      expect(sessionStorage.getItem('picpeak_restore_run')).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('hands the post-login redirect out once, until the wizard re-arms it', () => {
    expect(takeRestoreRedirect()).toBe(false);
    rememberRestoreRun(fresh());
    expect(takeRestoreRedirect()).toBe(true);
    expect(takeRestoreRedirect()).toBe(false);
    // A later sign-out alone does not re-arm it.
    noteRestoreSignOut();
    expect(takeRestoreRedirect()).toBe(false);
    rearmRestoreRedirect();
    expect(takeRestoreRedirect()).toBe(true);
  });

  it('hands the dashboard (SSO landing) the redirect only after the restore signed the admin out', () => {
    rememberRestoreRun(fresh());
    // Opened the dashboard while the restore runs, still signed in: stay.
    expect(takeRestoreRedirect({ afterSignOut: true })).toBe(false);
    noteRestoreSignOut();
    expect(takeRestoreRedirect({ afterSignOut: true })).toBe(true);
    expect(takeRestoreRedirect({ afterSignOut: true })).toBe(false);
    // Back on the run, the wizard re-arms: the sign-out is used up, so a plain
    // dashboard visit stays there until the next 401.
    rearmRestoreRedirect();
    expect(readRestoreRun()?.signedOut).toBe(false);
    expect(takeRestoreRedirect({ afterSignOut: true })).toBe(false);
    noteRestoreSignOut();
    expect(takeRestoreRedirect({ afterSignOut: true })).toBe(true);
  });

  it('matches only the row with exactly the marker\'s started_at, in every timestamp shape', () => {
    const marker = fresh();
    expect(isRunOf({ started_at: '2026-11-20T10:00:00.000Z' }, marker)).toBe(true);
    // SQLite rows restored from a dump can carry epoch milliseconds.
    expect(isRunOf({ started_at: Date.parse('2026-11-20T10:00:00.000Z') }, marker)).toBe(true);
    // A later run (another admin's restore or dry run) is not this one.
    expect(isRunOf({ started_at: '2026-11-20T10:00:00.250Z' }, marker)).toBe(false);
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
    const marker = fresh();
    rememberRestoreRun(marker);
    answer401('SESSION_INVALIDATED');
    await expect(api.get('/admin/restore/status')).rejects.toMatchObject({ response: { status: 401 } });
    expect(readRestoreRun()).toEqual({ ...marker, signedOut: true });
  });

  it('leaves no marker behind when no restore is tracked', async () => {
    answer401('TOKEN_EXPIRED');
    await expect(api.get('/admin/events')).rejects.toBeTruthy();
    expect(readRestoreRun()).toBeNull();
  });
});
