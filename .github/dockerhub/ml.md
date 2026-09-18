# picpeak — ML sidecar (face detection)

**picpeak** is an open-source, self-hosted **photo-sharing platform for photographers**. This image is the **optional face-detection sidecar**: it detects faces in one image and returns a bounding box, five landmarks, quality signals and a 512-d embedding per face.

**Nothing else.** No database, no volumes, no state, no egress, no model download at runtime. Clustering, person identity, thresholds and every privacy decision live in the picpeak backend, where the data already is — this service forgets each image the moment it answers.

If you don't run this container, the feature does not exist.

- 📦 **Source, docs & issues:** https://github.com/PicPeak/picpeak
- 🧩 **Runs with:** [`picpeak/backend`](https://hub.docker.com/r/picpeak/backend) + [`picpeak/frontend`](https://hub.docker.com/r/picpeak/frontend)

## Supported tags
- `latest` / `stable` — latest stable release
- `x.y.z` — a pinned release (**recommended for production** — keep it on the **same** tag as the backend)
- `beta` / `main` — latest build from `main` (may be unstable)
- **Architectures:** `linux/amd64`, `linux/arm64`

> The sidecar's API contract is versioned with the backend that calls it, so `PICPEAK_CHANNEL` resolves the same string across all picpeak images.

## Turning it on
The maintained compose file already contains this service behind a profile — you do not write it by hand:

    docker compose --profile faces up -d

Then two deliberate actions in the app, neither of which is installing this container:

1. Enable the **`faces`** feature flag in admin settings.
2. Enable **"Detect people in this gallery"** per event.

**Nothing in the backend touches this service while the flag is off**, so an install without this container never attempts a connection.

## Configuration
| | |
|---|---|
| `FACE_ML_TOKEN` | **Required.** The container **refuses to start** without it, so an accidentally published port is never a free face-detection API. Must match the backend's `FACE_ML_TOKEN`. |
| `FACE_ORT_THREADS` | ONNX Runtime threads (default `1`). |

Port **8000**, no volumes, no published ports needed — the backend reaches it on the compose network. `FACE_ML_URL` defaults to `http://picpeak-ml:8000` (the compose service name), so the standard deployment needs no URL configuration.

## API
All endpoints except `/health` require the `X-Face-ML-Token` header.

| | |
|---|---|
| `GET /health` | `{"status": "ok"}` — unauthenticated, used by the healthcheck |
| `GET /info` | `{detector, embedder, model_version, dim}` |
| `POST /faces` | multipart `image` → `{model_version, faces: [...]}` |

## Models
YuNet (detection) + FaceNet-512 (embedding), **both MIT**, baked into the image and verified by SHA-256 at build time — never downloaded at runtime, so airgapped installs work and a model cannot change under a running deployment. See [`ml/LICENSES.md`](https://github.com/PicPeak/picpeak/blob/main/ml/LICENSES.md) for why these and not InsightFace's non-commercial weights.

## Not available on the all-in-one image
[`picpeak/aio`](https://hub.docker.com/r/picpeak/aio) sets `PICPEAK_SINGLE_CONTAINER=true` and the backend refuses to enable face recognition there — a second image-processing pipeline competing with thumbnailing for one small container's CPU would not fail loudly, it would just make the install slow. Run the multi-container deployment for this feature.

## Docs
**https://docs.picpeak.app** · sidecar internals, model conversion and the alignment/threshold contract: [`ml/README.md`](https://github.com/PicPeak/picpeak/blob/main/ml/README.md)
