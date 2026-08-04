# Migration: PicPeak moved to its own GitHub organization

PicPeak's repository moved from the maintainer's personal handle to a dedicated
GitHub organization. This is a one-time, operator-facing change. The software
itself is unchanged; only the URLs you pull images from have moved.

## TL;DR — what changed and what you need to do

| | Before | After |
|---|---|---|
| **Repository URL** | `github.com/the-luap/picpeak` | `github.com/PicPeak/picpeak` |
| **Docker images** | `ghcr.io/the-luap/picpeak/{backend,frontend}` | `ghcr.io/picpeak/picpeak/{backend,frontend}` |
| **Branches (active dev)** | `beta` | `main` |
| **Branches (stable channel)** | `main` | `stable` |

**Action required**: update your `docker-compose.yml` to pull from
`ghcr.io/picpeak/picpeak/{backend,frontend}`.

## The old path does not fail — it freezes

This is the part that catches people out. `ghcr.io/the-luap/picpeak/*` **still
serves**; it simply stopped receiving new images on 2026-05-27. So:

- `docker compose pull` succeeds.
- `docker rmi <image>` followed by a fresh pull succeeds.
- You get byte-identical layers every time, because the tag never moves again.

Nothing anywhere reports an error. The only visible symptom is that PicPeak keeps
telling you an update is available and the update never arrives — which reads
like a broken download rather than a retired registry path.

### Am I affected?

```bash
docker image inspect ghcr.io/the-luap/picpeak/backend:latest \
  --format '{{.Created}} {{index .Config.Labels "org.opencontainers.image.version"}}'
```

A `Created` date of `2026-05-27` (or a `version` of `main` rather than a `v3.x.y`
tag) means you are on the retired path. Compare against the current image:

```bash
docker image inspect ghcr.io/picpeak/picpeak/backend:latest --format '{{.Created}}'
```

If your compose file still references `the-luap`, the fix below is all you need —
there is nothing wrong with your install.

## Why this changed

The repo lived under a personal GitHub handle since the project began. Moving to
an organization is a one-time housekeeping step that:

- Separates the project's identity from any individual maintainer's account.
- Lets the project add additional maintainers later without re-transferring.
- Matches the convention every other open-source project uses for branch names
  (`main` = active development, `stable` = curated production channel).

## docker-compose.yml — exact edit

Find these two lines:

```yaml
    image: ghcr.io/the-luap/picpeak/backend:${PICPEAK_CHANNEL:-stable}
    # ...
    image: ghcr.io/the-luap/picpeak/frontend:${PICPEAK_CHANNEL:-stable}
```

Replace with:

```yaml
    image: ghcr.io/picpeak/picpeak/backend:${PICPEAK_CHANNEL:-stable}
    # ...
    image: ghcr.io/picpeak/picpeak/frontend:${PICPEAK_CHANNEL:-stable}
```

Then:

```bash
docker compose pull
docker compose up -d
```

That's it. No data migration, no config changes, no database changes.

## What auto-redirects (you don't have to change)

GitHub redirects the old repo URL indefinitely, so these all keep working:

- Browser links to `github.com/the-luap/picpeak/...` (issues, PRs, files)
- `git clone https://github.com/the-luap/picpeak.git`
- GitHub API calls to `api.github.com/repos/the-luap/picpeak/...`

Worth updating to the canonical `PicPeak/picpeak` form when convenient, but
nothing breaks if you don't.

## What does NOT auto-redirect

- **GHCR image paths.** `ghcr.io/the-luap/picpeak/*` returns **404** — you must
  update your compose file.

## Branch rename

The active-development branch was renamed from `beta` → `main`, and the previous
`main` (stable channel) was renamed to `stable`. This matches the convention
every other open-source project uses.

If you're a contributor:

- **Feature PRs**: target `main`.
- **Bugfix PRs**: target `main`. If the fix also needs to ship to current stable
  users, open a separate small PR against `stable`.

If you're an operator: ignore. Branch names don't affect pulls.

## Got stuck?

Open an issue at https://github.com/PicPeak/picpeak/issues with the error
message and we'll help.
