/**
 * Build the GitHub release page URL for a given version string.
 *
 * Version strings already carry their channel suffix (e.g. `3.55.0`
 * for stable, `3.55.0-beta.0` for beta). release-please tags every
 * release as `vX.Y.Z[-beta.N]`, so a pure string template covers
 * both channels without branching on the suffix.
 *
 * Used by the admin sidebar version display to deep-link to release
 * notes for the running version (#566) and by the update-available
 * indicator to link to the upgrade target's notes.
 */
export const githubReleaseUrl = (version: string): string =>
  `https://github.com/PicPeak/picpeak/releases/tag/v${version}`;
