# Release Process

This document describes how PicPeak releases are cut. It's the maintainer's reference, not user documentation — for the user-facing channel choice (stable vs pre-release) see the [Release Channels section in README.md](README.md#-release-channels).

## TL;DR

- **`main` branch** receives all merged work (active development). Every push triggers a `release-please` PR that proposes the next `vX.Y.Z-beta.N` pre-release. Merging that PR tags the pre-release and publishes Docker images under the `:main` rolling tag + the version-specific tag.
- **`stable` branch** holds the curated stable channel. Stable releases are cut from a known-good `main` point via a `release/X.Y.Z-merge-from-main` branch and a manual PR to `stable`. Merging that PR triggers `release-please` to propose the stable release.
- Target cadence: **a stable release every 4–6 weeks**, or sooner if `main` has been quiet and ready for promotion.

> **Branch model background** — `main` (active dev) was previously called `beta`, and `stable` (curated channel) was previously called `main`. The rename happened with #669 to match the convention every other open-source project uses. The mechanics below all reference the post-rename names.

## Cadence target

4–6 weeks between stable releases is the working target. Reasoning:

- Long enough that each stable carries meaningful changes worth the upgrade burden.
- Short enough that pre-release users aren't carrying the "real" project alone for months — the stable channel should actually be usable as the recommended channel for new installs.
- Aligns with how release-please surfaces pre-releases (multiple pre-release points usually accumulate inside a 4–6 week window, which gives natural promotion candidates).

This is a target, not a hard rule. Cut sooner if `main` has been quiet and stable longer than usual. Cut later if `main` is in flux for security or migration reasons.

## Promotion criteria

A `main` tip is eligible for promotion to `stable` when **all** of the following hold:

1. **CI green on the candidate `main` tip.** Specifically: `schema-drift` (`upgrade-from-bootstrap`), `fresh-install`, `Tests` (backend Jest + frontend Vitest), the four `Build and Push Docker Images` arch matrices, and `GitGuardian Security Checks`.
2. **No open `bug`-labelled issues against the candidate for at least 7 days.** Issues fixed-but-not-yet-closed count as fixed; verify their PR is in the candidate `main` tip before closing them out.
3. **An upgrade walk has been done on real production-shaped data** — apply the candidate's migration chain to a snapshot of the previous stable's DB and verify no manual intervention is required. CI proves fresh-install works; the upgrade walk is what proves the upgrade path works.
4. **Operator-time smoke** on the candidate: log in, create event, upload photos, share gallery, open as a customer, log out. Catches binary-incompatibility regressions and UI-level breaks that unit tests don't see.

If any of the four fail, the promotion waits. File any blockers as `bug`-labelled issues and let them bake on `main` before re-evaluating.

## How a stable release is cut

The actual mechanics, in order:

1. **Pick the `main` tip.** Confirm it satisfies the four promotion criteria above. Note the exact SHA — that's what you're promoting.

2. **Create the release branch from the `main` tip.**
   ```bash
   git push origin <main-tip-sha>:refs/heads/release/X.Y.Z-merge-from-main
   ```
   Naming convention: `release/X.Y.Z-merge-from-main`, where `X.Y.Z` is the stable version you intend to land. release-please will write the actual `X.Y.Z` on merge — the branch name is just a human label.

3. **Open a PR to `stable`.** Title: `chore(release): promote main → stable as vX.Y.Z`. Body should summarise the major themes since the previous stable, the migration count, and any operator notes (e.g. "this release adds 22 migrations; existing installs should snapshot before upgrading"). See PR #568 as a worked example (predates the rename; the mechanics are unchanged).

4. **Resolve conflicts.** `stable` almost always has commits `main` doesn't (security backports, release-please's stable-channel release commits, README rewrites). For each conflicting file, decide deliberately:
   - **`backend/package.json` / `package-lock.json` + `frontend/package.json` / `package-lock.json`** — usually take `main`'s version (superset), but verify any security-pinned deps (`axios`, `nodemailer`, `i18next-http-backend`, `multer`, `tar`) on `main` are `>=` the pinned versions on `stable`. If `stable` has a newer pinned version (e.g. an emergency CVE backport `main` hasn't picked up), take `stable`'s pin.
   - **`README.md`** — keep `stable`'s version if it has had a recent rewrite that `main` didn't pick up; otherwise take `main`'s.
   - **`CHANGELOG.md`** — keep `stable`'s; release-please regenerates entries on its next stable cut from the commits going forward.
   - **`.release-please-manifest.json`** — keep `stable`'s; release-please owns this file.
   - Any other auto-merged file — spot-check that the auto-merge produced something sensible, especially for security-sensitive files (`backend/src/middleware/`, `backend/src/utils/tokenUtils.js`).

5. **Pin the stable version to match `main` (number alignment — see Versioning).** Determine `X.Y.Z` = the `main` tip's **base** version (its `vX.Y.Z-beta.N`, dropping the `-beta.N` suffix), and add an empty commit on the release branch:
   ```bash
   git commit --allow-empty -m "chore: release X.Y.Z" -m "Release-As: X.Y.Z"
   ```
   The `Release-As:` footer forces release-please to cut exactly `X.Y.Z`. Without it, release-please computes the next MINOR from the *previous stable* tag (e.g. `3.45.0` → `3.46.0`) while `main` is already at `3.84.x`, so the stable number drifts ever further behind for the same code.

6. **Wait for CI on the PR.** All ten checks (the original eight plus `merge-backend` and `merge-frontend`) must be green. If anything fails, fix on the release branch (NOT on `main` — `main` has already moved on).

7. **Merge.** Standard merge commit, not squash — the PR's history (the individual feature commits) carries forward into `stable`'s log.

8. **release-please picks it up.** Within minutes, release-please will open a new `chore(stable): release X.Y.Z` PR proposing the stable release. Review the auto-generated CHANGELOG.md entries for accuracy, edit if needed, and merge. That merge creates the `vX.Y.Z` git tag, publishes Docker images on the `:stable` and `:latest` tags, and creates the GitHub Release page.

9. **Close the loop.** Bulk-close any `bug` issues that were fixed-but-not-closed and now appear in the released changelog. Reference the merge commit so reporters know which version contains the fix.

## Hotfix path (backport to current stable)

If a critical bug or security issue affects the current stable and `main` has moved too far for a full promotion to be appropriate, backport just the fix:

1. Create a `security/cve-backport-X.Y.Z` or `fix/critical-X.Y.Z` branch off `stable`.
2. Cherry-pick or hand-write the minimal fix.
3. Open a PR to `stable` with the smallest possible diff.
4. After merge, release-please will propose a patch-level stable release (e.g. `v3.55.1`).
5. **Forward-port the fix to `main`** if it isn't already there. Otherwise the next full promotion will reintroduce the bug.

PR #412 ("backport 18 dependency CVE patches from beta") is a worked example of this path (predates the rename; the mechanics are unchanged).

## Versioning

PicPeak follows [Semantic Versioning](https://semver.org/) with one project-specific convention:

- **MAJOR** bumps are reserved for breaking schema changes that require operator action on upgrade (e.g. a migration that's not safe to auto-apply, an env-var rename that can't be auto-detected).
- **MINOR** bumps for new features, additive schema changes, and any change to the public HTTP API surface.
- **PATCH** bumps for bug fixes and operator-invisible internal changes.
- **Pre-release suffix** (`-beta.N`) for every `main`-channel cut; the `N` counter resets on each new MINOR or MAJOR target. The suffix kept the historical `-beta` literal even after the branch rename — operators were already pinning to `v3.x.y-beta.N` and changing the literal would have broken those pins.

release-please derives all of this from conventional commit prefixes (`feat:`, `fix:`, `BREAKING CHANGE:`, etc.) automatically.

### Stable ↔ pre-release number alignment

The two channels run **independent** release-please counters: `main` bumps on every merge (racing ahead), while `stable` only bumps on a promotion. Left to itself, `stable` computes each promotion as the next MINOR from the *previous stable tag*, so the two drift far apart — e.g. `main` at `v3.83.x-beta.0` while `stable` sat at `v3.45.0` for the **same code**, which reads as "stable is 38 versions behind" when it isn't.

To keep the numbers legible, **a promotion sets the stable version to the current `main` base version** (the `X.Y.Z` of the `main` tip's `vX.Y.Z-beta.N`, minus the suffix). Promoting a `main` at `v3.84.2-beta.0` therefore cuts stable `v3.84.2`, and the stable number tracks `main` instead of lagging. This is forced with the `Release-As:` commit in step 5 of the cut procedure — the one-time catch-up jump (e.g. `3.45.0 → 3.84.x`) is expected and happens only on the first aligned promotion.

> **Release-engineering note (2026-07):** `release-please.yml` (the stable workflow) *must* keep `target-branch: stable`. Without it, release-please defaults to the repo's default branch (`main`), reads `main`'s stale `.release-please-manifest.json`, and cuts a wrong/regressed version — this is what produced a bogus `v2.7.0` once. If a promotion ever yields an unexpected version, check that first.

## Things that don't go through this process

- **Documentation-only changes** can land on either `stable` or `main` directly (no release cut needed); release-please will pick them up on the next regular release.
- **Test-only changes** — same.
- **CI / workflow changes** — same, but be aware they take effect on the branch they land on, so a CI fix targeting `main` won't fix a broken stable-channel workflow until the next promotion.

## When this doc is wrong

If you find yourself working around something here, update the doc before doing the workaround. The point of a written process is that future-you doesn't have to remember the workaround.
