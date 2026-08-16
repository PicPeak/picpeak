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
  -e JWT_SECRET="$(openssl rand -base64 48)" \
  ghcr.io/picpeak/picpeak/aio:stable
```

Open `http://<host>:3000`. The first visit lands on the setup wizard, which
asks for a one-time token:

```bash
docker exec picpeak cat /data/db/SETUP_TOKEN
```

The token is also printed to the container log on first start.

`JWT_SECRET` is the only variable you must set. Generate it once and keep it —
changing it invalidates every existing session and gallery link.

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

## Environment

Only `JWT_SECRET` is required. Everything else has a working default.

| Variable | Default | Notes |
|---|---|---|
| `JWT_SECRET` | — | **Required.** Long random string. |
| `PORT` | `3000` | Listen port inside the container. |
| `FRONTEND_URL` | — | Public URL. Set it once you are behind a domain, so emails and share links point at the right host. |
| `SMTP_*` | — | Outbound email. Without it, PicPeak runs fine but sends nothing. |
| `DATABASE_CLIENT` | `sqlite3` | Set to `pg` to use an external PostgreSQL. Required — the image declares `sqlite3`, and the boot resolver treats a declared client as an explicit instruction, so `DB_*` alone will **not** switch engines. |
| `DB_HOST`, `DB_USER`, `DB_PASSWORD`, `DB_NAME` | — | Connection details, used when `DATABASE_CLIENT=pg`. |

### Using an external PostgreSQL

```bash
docker run -d --name picpeak -p 3000:3000 -v picpeak:/data \
  -e JWT_SECRET="…" \
  -e DATABASE_CLIENT=pg \
  -e DB_HOST=10.0.0.5 -e DB_USER=picpeak -e DB_PASSWORD=… -e DB_NAME=picpeak \
  ghcr.io/picpeak/picpeak/aio:stable
```

The image waits for the database to accept connections before running
migrations, exactly as the compose backend does.

## TLS

None is included. Terminate TLS in front of it — your NAS's reverse proxy,
Caddy, nginx, or a Cloudflare Tunnel. Set `FRONTEND_URL` to the public
`https://…` address so generated links match.

## NAS notes

**Synology (Container Manager)** and **QNAP (Container Station)** can both run
this from the registry UI: pull `ghcr.io/picpeak/picpeak/aio:stable`, map a
host port to container port `3000`, and add one volume mapping to `/data`.
Set `JWT_SECRET` under Environment.

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
