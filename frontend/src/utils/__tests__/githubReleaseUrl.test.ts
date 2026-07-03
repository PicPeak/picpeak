/**
 * Regression coverage for the version → release-page URL template (#566).
 *
 * release-please tags every release as `vX.Y.Z[-beta.N]`. If anyone
 * later refactors the helper (e.g. switches the prefix, the repo path,
 * or strips the channel suffix), these assertions will fail loud
 * instead of silently producing dead links in the admin sidebar.
 */
import { describe, expect, it } from 'vitest';
import { githubReleaseUrl } from '../githubReleaseUrl';

describe('githubReleaseUrl', () => {
  it('maps a stable version to its tag page', () => {
    expect(githubReleaseUrl('3.55.0')).toBe(
      'https://github.com/PicPeak/picpeak/releases/tag/v3.55.0',
    );
  });

  it('maps a beta version (with channel suffix) to its tag page', () => {
    expect(githubReleaseUrl('3.55.0-beta.0')).toBe(
      'https://github.com/PicPeak/picpeak/releases/tag/v3.55.0-beta.0',
    );
  });

  it('does not double-prefix the v when given a bare version', () => {
    // Defensive — the helper is the single source of truth for the
    // leading "v". Callers must pass the bare version string.
    expect(githubReleaseUrl('3.55.0')).not.toContain('vv');
  });
});
