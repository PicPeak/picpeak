# picpeak — All-in-one

**picpeak** is an open-source, self-hosted **photo-sharing platform for photographers**, with an optional CRM / accounting suite. This image is the **all-in-one** build: the backend, the built web UI and SQLite in **one container, one process** — no compose file, no separate database, no reverse proxy to wire up.

- 📦 **Source, docs & issues:** https://github.com/PicPeak/picpeak
- 🧩 **Multi-container images:** [`picpeak/backend`](https://hub.docker.com/r/picpeak/backend) + [`picpeak/frontend`](https://hub.docker.com/r/picpeak/frontend)

## Supported tags
- `latest` / `stable` — latest stable release
- `x.y.z` — a pinned release (**recommended for production**)
- `beta` / `main` — latest build from `main` (may be unstable)
- **Architectures:** `linux/amd64`, `linux/arm64` (x86 and ARM NAS)

## Quick start

    docker run -d --name picpeak -p 3000:3000 \
      -v picpeak:/data \
      -e JWT_SECRET="$(openssl rand -base64 48)" \
      picpeak/aio:stable

Then open **http://localhost:3000/admin** and complete the setup wizard. Read the one-time setup token with:

    docker exec picpeak cat /data/db/SETUP_TOKEN

> 🔗 Share links need to know your address. The image defaults `FRONTEND_URL` to `http://localhost:3000`; pass `-e FRONTEND_URL=https://photos.example.com` (or set the site URL in Settings) before you send a gallery to a client.

## Ports & volumes
- Container port **3000** (HTTP; put your own TLS terminator in front for public use).
- **One volume: `/data`** — back it up and you have backed up the install.
  - `/data/db` — `picpeak.db` and `SETUP_TOKEN`
  - `/data/storage` — originals, thumbnails, archives
  - `/data/logs`, `/data/backup`

## External Postgres
SQLite is this image's default, not its only option. Point it at an existing database exactly like the backend image:

    -e DATABASE_CLIENT=pg -e DB_HOST=… -e DB_USER=… -e DB_PASSWORD=…

## How it differs from the compose stack
- **SQLite takes one writer at a time** — right for a home server, a NAS or a single studio; the compose stack with PostgreSQL is what scales.
- **No Redis** — background jobs run in-process.
- **Face recognition is unavailable** here. It needs the separate [`picpeak/ml`](https://hub.docker.com/r/picpeak/ml) sidecar, and a second image-processing pipeline competing with thumbnailing for one container's CPU would just make the install slow. Run the multi-container deployment for that feature.

You can move to the full stack later without reinstalling: take a `.picpeak` backup and restore it there.

## Docs
Volume layout, the external-Postgres variant, TLS, updates and the limits: **https://docs.picpeak.app/deployment/single-container**
