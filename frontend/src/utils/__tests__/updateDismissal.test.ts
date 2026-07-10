/**
 * Coverage for the per-version "Update available" chip dismissal (#567).
 *
 * The chip should reappear only when a newer version than the
 * dismissed one is published. These tests pin the comparison rules
 * (mirroring the backend's compareVersions in updateCheckService.js
 * — stable > beta, higher beta > lower beta, semantic numeric compare
 * on major.minor.patch) so a future refactor can't silently break the
 * "I dismissed v3.55.0 but should still see v3.55.1" flow.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  isNewerVersion,
  setDismissedVersion,
  shouldShowUpdateChip,
} from '../updateDismissal';

describe('isNewerVersion', () => {
  it('compares major.minor.patch semantically (not lexically)', () => {
    expect(isNewerVersion('3.10.0', '3.9.0')).toBe(true);
    expect(isNewerVersion('3.9.0', '3.10.0')).toBe(false);
    expect(isNewerVersion('10.0.0', '9.99.99')).toBe(true);
  });

  it('treats stable as newer than the same-numbered beta', () => {
    expect(isNewerVersion('3.55.0', '3.55.0-beta.0')).toBe(true);
    expect(isNewerVersion('3.55.0-beta.0', '3.55.0')).toBe(false);
  });

  it('compares beta numbers when both are betas of the same base version', () => {
    expect(isNewerVersion('3.55.0-beta.2', '3.55.0-beta.1')).toBe(true);
    expect(isNewerVersion('3.55.0-beta.1', '3.55.0-beta.2')).toBe(false);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('3.55.0', '3.55.0')).toBe(false);
    expect(isNewerVersion('3.55.0-beta.0', '3.55.0-beta.0')).toBe(false);
  });

  it('returns false for unparseable input rather than throwing', () => {
    expect(isNewerVersion('nonsense', '3.55.0')).toBe(false);
    expect(isNewerVersion('3.55.0', '')).toBe(false);
  });
});

describe('shouldShowUpdateChip', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it('shows the chip when nothing has been dismissed', () => {
    expect(shouldShowUpdateChip('3.55.0')).toBe(true);
  });

  it('hides the chip when the same version has been dismissed', () => {
    setDismissedVersion('3.55.0');
    expect(shouldShowUpdateChip('3.55.0')).toBe(false);
  });

  it('shows the chip again when a newer version appears after dismissal', () => {
    setDismissedVersion('3.55.0');
    expect(shouldShowUpdateChip('3.55.1')).toBe(true);
    expect(shouldShowUpdateChip('3.56.0')).toBe(true);
  });

  it('keeps the chip hidden when an OLDER version somehow becomes the latest', () => {
    // Defensive — shouldn't happen in practice (release-please never
    // republishes older tags) but a regression here would re-pester
    // an admin who's deliberately on a newer version.
    setDismissedVersion('3.55.0');
    expect(shouldShowUpdateChip('3.54.0')).toBe(false);
  });
});
