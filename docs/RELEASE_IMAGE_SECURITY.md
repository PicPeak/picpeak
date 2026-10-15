# Release image publication protections

These repository settings are mandatory prerequisites, not changes that the
workflow can apply to itself. Until an authorized maintainer applies and verifies
them, do not consider release provenance protected. Publication fails closed when
a required environment is missing or lacks its verifiable controls.
PRs and manual dispatch with `push=false` still build without publishing.

## Publication contract

Rolling images originate from protected `main` or `stable`. Versioned images run
only as a same-commit reusable workflow invoked by the corresponding Release
Please workflow, using the pinned action's generated tag, SHA and release ID.
The policy verifies the caller, channel, exact current tag target, release
identity and ancestry before approving an immutable checkout. All four images
share the decision and explicit tags; a beta version does not relabel itself as
the rolling `main` image, and a stable version does not move `latest`/`stable`.
Those mutable channel aliases come only from the rolling `stable` branch run,
which the same release merge also starts, so a version approved late cannot
rewind them past newer stable commits. If a newer stable push cancels that
rolling run and its own build then fails, the aliases stay on the older image
even though the version published; re-run the latest stable rolling build. Tag pushes and release events no longer start this
pipeline. Manual publication is only available on protected main/stable.

Ordinary branch merges and explicit manual rolling publication do not require a
deployment review. Exact versions require one review in `picpeak-release`; a
listed maintainer may approve their own run. This is a deployment approval, not
a GitHub PR review: GitHub does not let PR authors approve their own PR.
Tag, SHA, caller, release identity, channel and ancestry checks are unchanged.

A workflow from an old or attacker-authored tag can contain different checks.
Removing triggers or adding ancestry checks in new source cannot stop that
workflow by itself. External immutable version-tag rules are essential.

## Maintainer configuration plan

1. Keep both `main` and `stable` protected, with applicable required CI,
   dismissed stale approvals and no force pushes or deletion. The chosen
   single-maintainer contract permits the trusted maintainer to merge their own
   changes without another person's review. Scope any PR-review exception to
   that maintainer; do not grant ordinary writers the same exception or bypass
   CI. Review and audit workflow/security changes. Rolling publication relies
   on this protected-branch and trusted-maintainer boundary, not a second human.
2. Create two active tag rulesets targeting `v*`: an update/deletion restriction
   with **no bypass**, and a separate creation restriction whose only bypass is
   the trusted release actor. The existing credential uses `the-luap`; a
   repository-admin creation bypass is suitable only while every repository
   admin is a trusted release actor. Re-audit it before adding administrators;
   prefer a dedicated Release Please GitHub App long term. Do not allow general
   write/maintain users to create version tags. Confirm legitimate tag creation
   with the existing release actor; never loosen immutability to restore releases.
   Both Release Please workflows require `RELEASE_PLEASE_TOKEN` and have no
   `GITHUB_TOKEN` fallback: the Actions token cannot use the creation bypass, so
   it could not tag a merged release PR. The token is a fine-grained PAT owned by
   the release actor, scoped to this repository with **Contents**, **Pull
   requests**, **Issues** and **Workflows** read/write (release commits, tags
   and releases; the release PR and its auto-merge; release labels; creating a
   release whose target commit has workflow files that differ from the default
   branch, which is normal for `stable`). Fine-grained PATs expire: note the
   expiry date and renew before it. A first step in each workflow fails the run
   with an explicit error when the secret is missing or GitHub rejects it
   (expired or revoked); no release PR update, tag or image publication happens
   until it is renewed. That probe only reads repository metadata, so a valid
   but under-scoped token passes it and fails later in Release Please. A stable or
   beta release PR merged while the token is broken stays untagged; rerun the
   failed Release Please run after renewing the token.
3. Create **two** environments, both allowing **protected branches only**, with
   administrator bypass disabled and no wait timers or custom deployment gates:
   - `picpeak-release`: enable required reviewers and add `the-luap` (your own
     account). Leave **Prevent self-review unchecked**. No registry secrets go
     here. Only the exact-version authorization job uses this environment.
   - `picpeak-publication`: leave required reviewers disabled. Store
     `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` here. Rolling authorization and
     all credential-consuming manifest/description jobs use this environment,
     including version runs after their release approval succeeds.
   GitHub requires only one listed reviewer, so adding another trusted reviewer
   does not require that person in addition to you. Verify administrator-bypass
   switches in the UI: REST does not consistently expose them. Before approving
   a version, check the full source SHA, exact version and channel in the policy
   summary. There is no second approval wave for manifest publishers.
4. Keep the Docker Hub credentials environment-only. Remove equivalent
   repository/organization credentials after the coordinated migration, use a
   least-privilege publishing token and rotate old broadly exposed credentials.
   Both reusable callers explicitly pass only the two Docker Hub secret names;
   their environment-scoped values take precedence. Current GitHub documentation
   requires these names to be passed even for environment-only secrets. The
   reusable workflow declares them required; this checks name forwarding, not
   nonempty values. Verify actual credentials during authorized rollout.
   Never pass `RELEASE_PLEASE_TOKEN` or `secrets: inherit` into the image workflow.
   GHCR uses job-scoped `GITHUB_TOKEN` package permission only after the automatic
   rolling authorization or approved version authorization succeeds.
5. Review existing tags/workflows and credential access before declaring the
   migration complete. Protect other independently published image families
   (for example `updater-v*` / `updater-release`) under their own documented
   policies; this plan does not silently change those workflows.

The shared authorization job always runs before publishing: it completes
automatically in `picpeak-publication` for rolling runs, or waits in
`picpeak-release` for versions. Keeping that prerequisite successful avoids
skipped-job propagation breaking ordinary branch publication. Verify-only runs
skip all environment jobs and registry writes. Missing protections, unexpected
review/wait/custom gates or unreadable API responses fail closed.

## Rollout and verification

Prepare and review both main/stable PRs, then apply settings under a separately
authorized maintenance change **before** merging/enabling the publication path.
Read back the active tag rules, branch protections, environment switches and
secret locations. A code-only merge is not complete remediation. These PRs
prepare source and this plan only; they do not change settings or secrets.

Run `node --test .github/scripts/*.test.cjs` and normal PR build checks first.
Verify a manual `push=false` run has no login, digest push, manifest publication
or deployment request. In an authorized disposable test repository, confirm an
ordinary writer cannot create/update/delete a version tag, an unreviewed ref
cannot publish and missing version reviewers stop publication. Confirm an
ordinary protected-branch merge publishes without any review request, then
approve your own exact Release Please version in each channel. Verify there is
only one review wave and compare image revisions/tags with the approved SHA.
Do not create live test tags or publish images without separate authorization.

Known limit: the `X.Y` and `X` aliases on stable versions are not ordered. If
two stable versions of the same line wait for approval and the older one is
approved last, its manifest jobs move `X.Y`/`X` back to it. The policy job runs
before the approval wait, so it cannot see versions that appear during it; a
reliable guard would need a re-check after approval. Approve pending stable
versions oldest first, or re-run the newest version's publication afterwards.

For rollback, stop publication and revoke/rotate credentials as needed; retain
tag and environment protections. Reverting only workflow code can restore old
tag triggers, so never disable protections as a compatibility workaround.

References: [reusable workflow context and permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
[same-commit reusable calls and environment secrets](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[repository rulesets](https://docs.github.com/en/enterprise-cloud%40latest/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization),
[deployment reviews](https://docs.github.com/en/actions/how-tos/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments).
