# PicPeak all-in-one (single container)

One `docker run`, one volume, working PicPeak. Built for NAS boxes (Synology,
UGREEN, QNAP) and small VPSes where standing up a four-service compose stack is
the thing that makes people give up and go back to a SaaS.

If you already run PostgreSQL, or you expect several photographers hitting the
admin UI at once, use the [compose stack](../README.md) instead. This image is
the small end of the range, not a replacement for it.

## Run it

```bash
docker run -d \
  --name picpeak \
  -p 3000:3000 \
  -v picpeak:/data \
  ghcr.io/picpeak/picpeak/aio:main
```

`:main` is the rolling tag that tracks the default branch. The curated
`:stable` and `:latest` tags exist for the backend and frontend images but have
not been cut for this one yet, so `:main` is the tag to pull today — pinning a
published version tag also works if you would rather not follow the branch —
the Releases page, or the package's tag list on the registry, shows what is
current.

Open `http://<host>:3000`. The first visit lands on the setup wizard, which
asks for a one-time token:

```bash
docker exec picpeak cat /data/db/SETUP_TOKEN
```

No shell? The file is on the volume you mounted, so any file manager can open
it — with `-v picpeak:/data` it is `db/SETUP_TOKEN` inside the volume, and with
a host folder it is `<that folder>/db/SETUP_TOKEN`.

The token is deliberately **not** written to the container log. It is a live
credential for creating the first admin, and logging it would leave it sitting
in `combined.log` and `security.log` on the mounted volume long after setup.
The log line names the file instead. (If the file could not be written at all,
the log carries the token as a last-resort recovery path — that is the only
case where it appears there.)

## Secrets

Nothing to set. On first start the container generates a `JWT_SECRET` and
stores it at `db/jwt.secret` (mode 0600) on the volume, then reuses it on every
subsequent boot — so a deployment with no shell, like a NAS Container Manager
form, needs no preparation.

Back it up along with the rest of the volume: losing that file signs every
admin session and gallery link out, exactly as changing the secret would.

Note the **built-in backup does not include it** — that covers the database and
the storage tree, not the rest of `/data` — so a restore from `/data/backup`
alone will not bring the secret back. Copy the volume.

Passing `-e JWT_SECRET=…` still overrides it, which is what you want for
config-as-code deployments or when several instances must share sessions.

## What is inside

One Node process. No supervisor, no nginx, no PostgreSQL, no Redis.

The backend serves the built frontend directly and applies the same security
headers the nginx container applies in the compose stack — same CSP, same
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and
`Permissions-Policy`, plus the same cache tiers (hashed assets immutable,
`index.html` never cached).

**SQLite is the default**, deliberately. It is a library inside the process
writing one file on your volume: no second daemon, no credentials, no startup
ordering, and no `pg_upgrade` dance when you pull a newer image. The engine is
resolved and logged at boot, so `docker logs` always tells you which database
you are actually on:

```
Database engine: sqlite (/data/db/picpeak.db)
```

Redis is absent — nothing in the backend needs it at runtime.

## The volume

Everything that must survive a container replacement lives under `/data`:

| Path | Contents |
|---|---|
| `/data/db` | `picpeak.db` (+ `-wal`/`-shm`) and `SETUP_TOKEN` |
| `/data/storage` | originals, thumbnails, archives |
| `/data/logs` | application logs |
| `/data/backup` | built-in backup output (`/backup` is symlinked here) |

One mount point is the whole point. Back up `/data` and you have backed up the
install.

Upgrades are `docker pull` + recreate the container; migrations run at start.
The volume is what carries your data across, so never bind-mount a directory
you are about to delete.

### Large libraries and slow start-ups

The container starts as root just long enough to take ownership of `/data`
(UID 1001), then drops privileges. That step walks the tree, so on a big
library over a slow filesystem it can add noticeable time to **every** restart,
not only the first.

If that becomes annoying, take ownership once yourself and run as that user —
the adoption step is then skipped entirely:

```bash
chown -R 1001:1001 /volume1/docker/picpeak     # once, on the host
docker run -d --name picpeak -p 3000:3000 \
  --user 1001:1001 \
  -v /volume1/docker/picpeak:/data \
  ghcr.io/picpeak/picpeak/aio:main
```

The container then verifies the directories are writable and fails with a clear
message if they are not, rather than trying to fix ownership itself. Note this
also means files you drop into the storage tree from outside must already be
readable by UID 1001 — relevant if you use a watched folder to ingest photos.

## Environment

Nothing is required. Everything below has a working default.

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | generated | Generated into `db/jwt.secret` on first start and reused after. Set it explicitly to pin it. |
| `PORT` | `3000` | Listen port inside the container. |
| `FRONTEND_URL` | — | Optional override for the public URL. Normally you set this in the setup wizard instead (it proposes the address you opened), and it is editable later under Settings → General. Setting it here pins the value and makes that field read-only. |
| `SMTP_*` | — | Optional override for outbound email, which is normally configured in the setup wizard / Settings → Email. Without either, PicPeak runs fine but sends nothing. |
| `DATABASE_CLIENT` | `sqlite3` | Set to `pg` to use an external PostgreSQL. Required — the image declares `sqlite3`, and the boot resolver treats a declared client as an explicit instruction, so `DB_*` alone will **not** switch engines. |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | Connection details, used when `DATABASE_CLIENT=pg`. |
| `EXTERNAL_MEDIA_ROOT` | `/external-media` | Read-only photo library to offer in the picker. Mount a folder there and it works without setting this. |

### Using an external PostgreSQL

```bash
docker run -d --name picpeak -p 3000:3000 -v picpeak:/data \
  -e DATABASE_CLIENT=pg \
  -e DB_HOST=10.0.0.5 -e DB_USER=picpeak -e DB_PASSWORD=… -e DB_NAME=picpeak \
  ghcr.io/picpeak/picpeak/aio:main
```

The image waits for the database to accept connections before running
migrations, exactly as the compose backend does.

## Using photos that are already on the disk

Galleries do not have to be built from uploads. Mount an existing photo library
read-only at `/external-media` and it appears in the admin photo picker:

```bash
docker run -d --name picpeak -p 3000:3000 \
  -v picpeak:/data \
  -v /volume1/photo/2026-weddings:/external-media:ro \
  ghcr.io/picpeak/picpeak/aio:main
```

No environment variable is needed — the path is the default. `EXTERNAL_MEDIA_ROOT`
overrides it if you would rather mount somewhere else.

The location is resolved once, on first use, and cached for the life of the
process — so add the mount when you create the container, or restart it
afterwards. It will not appear in a running one.

`:ro` is not a precaution, it is accurate: PicPeak only reads from this tree.
Thumbnails are written into the managed storage on the data volume, so the
originals are never touched, renamed, or moved.

Two things to get right:

- **Mount it outside `/data`.** The data volume is adopted at boot (`chown` to
  UID 1001) so the app can write to it. A read-only mount nested inside it makes
  that fail and the container will not start. `/external-media` is its own path
  for exactly this reason.
- **A network share is fine here, and only here.** Because this tree is only
  read and never adopted, an SMB/CIFS or NFS mount works — which is what makes
  "the photos already live on the NAS" practical. The same share mounted under
  `/data` would hang or fail the ownership step instead.

## TLS

None is included. Terminate TLS in front of it — your NAS's reverse proxy,
Caddy, nginx, or a Cloudflare Tunnel. Put the public `https://…` address in
Settings → General (or re-run the setup wizard) so generated links match —
`FRONTEND_URL` does the same thing but pins it outside the admin UI.

## NAS notes

**Synology (Container Manager)** and **QNAP (Container Station)** can both run
this from the registry UI: pull `ghcr.io/picpeak/picpeak/aio:main`, map a
host port to container port `3000`, and add one volume mapping to `/data`.
No environment variables are needed — the secret is generated on first start.

Point the volume at a folder on your data pool, not the system partition, and
prefer a folder you own — the container starts as root only long enough to
adopt the directory, then drops to UID 1001.

## Outgrowing it

A single-container install is never a dead end. When you need the full stack:

1. **Settings → Backup → Export `.picpeak`** (include photos).
2. Stand up the compose stack with PostgreSQL and run its setup wizard.
3. **Settings → Backup → Restore** the `.picpeak` file.

SQLite → PostgreSQL restore is supported (#1041); the reverse is not. Your
galleries, settings, customers and photos come across.

## Health

`/health` returns 200 when the database is reachable and 503 when it is not,
and the image's `HEALTHCHECK` uses it — so `docker ps` showing `healthy`
means the app can actually serve, not merely that a socket is open.

```bash
docker inspect --format='{{.State.Health.Status}}' picpeak
```

## Limits

- **SQLite means one writer.** Fine for one photographer plus guests
  browsing; if several admins upload simultaneously all day, move to
  PostgreSQL.
- **No built-in TLS or reverse proxy.**
- **No Redis**, so nothing here scales horizontally — run one container.
- **No face recognition.** "People in this gallery" needs a separate ML
  container this image does not include, and running detection alongside
  thumbnail and preview generation in one container would slow everything
  down rather than fail cleanly. The toggle in Settings → Features is
  disabled here and says so. Use the multi-container deployment if you want
  it.
