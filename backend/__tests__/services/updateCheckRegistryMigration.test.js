/**
 * Pre-rename detection for the registry-move notice (#985).
 *
 * The in-app MigrationBanner shipped 2026-06-29, a month AFTER
 * ghcr.io/the-luap/picpeak/* stopped receiving images on 2026-05-27. Anyone
 * still pulling the retired path is therefore running a build that predates the
 * banner and can never render it — the structural gap that keeps producing
 * reports like #982. The update check is the one channel that still reaches
 * them, so it carries the notice instead.
 *
 * The boundary is exact rather than heuristic: v3.44.0 shipped on the freeze
 * date and v3.45.0 followed on 2026-07-09 to the org registry only, with
 * nothing published in between.
 */

const { isPreRenameStable, REGISTRY_RENAME_STABLE_FLOOR } = require('../../src/services/updateCheckService');

describe('isPreRenameStable (#985)', () => {
  it('pins the floor to the first org-registry-only stable release', () => {
    expect(REGISTRY_RENAME_STABLE_FLOOR).toBe('3.45.0');
  });

  it('flags stable installs below the floor', () => {
    // v3.44.0 is the last stable that reached the retired path.
    expect(isPreRenameStable('3.44.0', 'stable')).toBe(true);
    expect(isPreRenameStable('3.43.1', 'stable')).toBe(true);
    expect(isPreRenameStable('2.6.5', 'stable')).toBe(true);
  });

  it('leaves stable installs at or above the floor alone', () => {
    expect(isPreRenameStable('3.45.0', 'stable')).toBe(false);
    expect(isPreRenameStable('3.45.13', 'stable')).toBe(false);
    expect(isPreRenameStable('3.99.0', 'stable')).toBe(false);
  });

  it('never fires on the beta channel', () => {
    // The beta boundary is inferred, not clean — 3.59.0-beta.0 landed two days
    // after the freeze. A false positive would tell a correctly-configured
    // operator their registry is retired, so beta is deliberately excluded even
    // where the number looks old.
    expect(isPreRenameStable('3.44.0-beta.0', 'beta')).toBe(false);
    expect(isPreRenameStable('3.58.0-beta.0', 'beta')).toBe(false);
    expect(isPreRenameStable('3.99.0-beta.0', 'beta')).toBe(false);
  });

  it('does not fire on an unresolvable version', () => {
    // getCurrentVersion() falls back to '0.0.0' when package.json is
    // unreadable. That is a broken install, not a pre-rename one — claiming its
    // registry is retired would send the operator down the wrong path.
    expect(isPreRenameStable('0.0.0', 'stable')).toBe(false);
  });
});
