# Release image publication protections

These repository settings are mandatory prerequisites, not changes that the
workflow can apply to itself. Until an authorized maintainer applies and verifies
them, do not consider release provenance protected. Publication fails closed when
the required approval environment is missing or lacks its verifiable controls.
PRs and manual dispatch with `push=false` still build without publishing.

## Publication contract

Rolling images originate from protected `main` or `stable`. Versioned images run
only as a same-commit reusable workflow invoked by the corresponding Release
Please workflow, using the pinned action's generated tag, SHA and release ID.
The policy verifies the caller, channel, exact current tag target, release
identity and ancestry before approving an immutable checkout. All four images
share the decision and explicit tags; a beta version does not relabel itself as
the rolling `main` image. Tag pushes and release events no longer start this
pipeline. Manual publication is only available on protected main/stable.

A workflow from an old or attacker-authored tag can contain different checks.
Removing triggers or adding ancestry checks in new source cannot stop that
workflow by itself. External immutable version-tag rules are essential.

## Maintainer configuration plan

1. Protect both `main` and `stable` with reviewed pull requests, at least one
   approval, dismissed stale approvals, required applicable CI and no direct or
   force pushes. Apply the protection to administrators; audit existing bypass
   actors. Protect workflow/security changes with trusted review. An automation
   review must not replace independent review of substantive workflow changes.
2. Create an active tag ruleset targeting `v*`. Restrict tag creation, updates
   and deletion. Only a dedicated Release Please GitHub App, or a narrowly
   scoped release-automation team holding the release credential, may bypass
   creation restrictions. Do not grant bypass to all write/maintain users or
   general administrators. Prefer immutable tags even for the release actor;
   if the platform requires a broad bypass, narrowly limit and audit that actor.
   Confirm the existing Release Please credential can create legitimate tags
   before enabling the restriction; do not weaken the rule to restore releases.
3. Create the `picpeak-release` environment with trusted required reviewers,
   prevent self-review, disable administrator bypass, and allow **protected
   branches only**. Both main/stable must already be protected. Reject approvals
   from arbitrary refs, and review the publication-policy summary's full source
   SHA, exact version and channel. GitHub's REST environment representation does
   not consistently expose admin bypass; verify that switch in the UI as well.
4. Store `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` only as secrets in that
   environment. Remove equivalent repository/organization-level credentials
   available to unrelated workflows. Use a least-privilege publishing token and
   rotate old broadly exposed credentials. Do not pass `RELEASE_PLEASE_TOKEN`
   or `secrets: inherit` into the image workflow. GHCR uses job-scoped
   `GITHUB_TOKEN` package permission after the approval prerequisite succeeds.
5. Review existing tags/workflows and credential access before declaring the
   migration complete. Protect other independently published image families
   (for example `updater-v*` / `updater-release`) under their own documented
   policies; this plan does not silently change those workflows.

Each manifest publisher also uses the environment for Docker Hub secrets, so its
deployment may require a further approval after the initial publication gate.
Reviewers must approve only jobs in the same validated run and source/version.
Missing protections or unreadable API responses stop publishing rather than
silently falling back to an unapproved or different version.

## Rollout and verification

Prepare and review both main/stable PRs, then apply settings under a separately
authorized maintenance change **before** merging/enabling the publication path.
Read back the active tag rules, branch protections, environment switches and
secret locations. A code-only merge is not complete remediation.

Run `node --test .github/scripts/*.test.cjs` and normal PR build checks first.
Verify a manual `push=false` run has no login, digest push, manifest publication
or deployment request. In an authorized disposable test repository, confirm an
ordinary writer cannot create/update/delete a version tag, an unreviewed ref
cannot publish and missing reviewers stop publication. Finally approve an exact
Release Please version in each channel and verify the image revision and tags
against its approved source SHA. Do not create live test tags or publish images
without separate authorization.

For rollback, stop publication and revoke/rotate credentials as needed; retain
tag and environment protections. Reverting only workflow code can restore old
tag triggers, so never disable protections as a compatibility workaround.

References: [reusable workflow context and permissions](https://docs.github.com/en/actions/reference/workflows-and-actions/reusing-workflow-configurations),
[same-commit reusable calls and environment secrets](https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows),
[repository rulesets](https://docs.github.com/en/enterprise-cloud%40latest/organizations/managing-organization-settings/creating-rulesets-for-repositories-in-your-organization),
[deployment reviews](https://docs.github.com/en/actions/how-tos/managing-workflow-runs-and-deployments/managing-deployments/reviewing-deployments).
