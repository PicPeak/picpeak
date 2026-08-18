# picpeak-ml

Optional face-detection sidecar for PicPeak (#1074). Detects faces in one
image and returns a bounding box, five landmarks, quality signals and a
512-d embedding per face.

**Nothing else.** No database, no volumes, no state, no egress, no model
download at runtime. Clustering, person identity, thresholds and every
privacy decision live in the PicPeak backend, where the data already is.
This service forgets each image the moment it answers.

If you don't run this container, the feature does not exist — see
"Turning it on" below.

## API

All endpoints except `/health` require the `X-Face-ML-Token` header. The
service **refuses to start** without `FACE_ML_TOKEN` set, so an accidentally
published port is never a free face-detection API.

| | |
|---|---|
| `GET /health` | `{"status": "ok"}` — unauthenticated, used by the compose healthcheck |
| `GET /info` | `{detector, embedder, model_version, dim}` |
| `POST /faces` | multipart `image` → `{model_version, faces: [...]}` |

Each face:

```jsonc
{
  "bbox": [x, y, w, h],          // ORIGINAL image pixels, not detection-scaled
  "score": 0.94,
  "landmarks": [[x, y], ...],    // 5: right eye, left eye, nose, right mouth, left mouth
  "yaw": -1.42,                  // degrees, approximate (see pipeline.py)
  "pitch": -25.33,
  "blur": 2579.5,                // variance of Laplacian on the aligned crop; higher = sharper
  "embedding": [...]             // 512 floats, L2-normalized
}
```

`404`/`400` mean "this image is a lost cause" — the backend marks the photo
failed. `5xx` and connection failures mean "try later" — the backend returns
the photo to `pending` with backoff, so turning this container off for a week
does not require a manual re-scan.

## Models

YuNet (detection, MIT) + FaceNet-512 (embedding, MIT), both baked into the
image and verified by SHA-256 at build time. See [LICENSES.md](LICENSES.md)
for why these two and not the more obvious InsightFace weights — the short
version is that InsightFace's are non-commercial-only and PicPeak's users are
working photographers.

### Building the image

`facenet512.onnx` is **not** fetched automatically, because deepface
distributes FaceNet-512 as Keras `.h5` only. Convert it once, publish it,
then pass the URL and checksum:

```bash
cd ml
python -m venv .venv && . .venv/bin/activate
pip install -r tools/requirements-convert.txt

curl -fsSL -o facenet512_weights.h5 \
  https://github.com/serengil/deepface_models/releases/download/v1.0/facenet512_weights.h5
echo "3f76b5117a9ca574d536af8199e6720089eb4ad3dc7e93534496d88265de864f  facenet512_weights.h5" | sha256sum -c -

python tools/convert_facenet.py facenet512_weights.h5 facenet512.onnx
sha256sum facenet512.onnx
```

Publish `facenet512.onnx` as a release asset, then:

```bash
docker build -t picpeak-ml \
  --build-arg FACENET_ONNX_URL=https://github.com/PicPeak/picpeak/releases/download/<tag>/facenet512.onnx \
  --build-arg FACENET_ONNX_SHA256=<sha256> \
  ml/
```

The conversion is deliberately outside the Docker build: TensorFlow is ~600MB
of build dependency for a file that never ships in the final image, and the
ONNX is byte-identical regardless of which machine produced it, so converting
once beats converting on every architecture leg of every multi-arch build.

## Turning it on

Two deliberate actions, neither of which is installing this container:

1. Enable the `faces` feature flag in PicPeak's admin settings.
2. Enable "Detect people in this gallery" per event.

`FACE_ML_URL` defaults to `http://picpeak-ml:8000` — the compose service name
— so the standard deployment needs no URL configuration. **Nothing in the
backend touches that URL while the flag is off**, so an install without this
container never attempts a connection.

## Development

```bash
pip install -r requirements.txt pytest httpx
python -m pytest tests/ -q
```

The tests stub the models out: they cover the auth boundary, the request
guards and the alignment geometry — the places where a mistake is a security
problem or a silent accuracy problem. Model *quality* is not a unit-test
question; that is what the Phase 0 spike measured.

### The one thing to be careful about

The alignment in `pipeline.py` and the normalization in `_embed` must stay
identical to whatever the clustering threshold was tuned against. A tuned
cosine threshold does not transfer across an alignment change. If either
changes, bump `MODEL_VERSION` in `config.py` — the backend keys
re-derivation off that string and will re-cluster rather than silently mix
two incompatible embedding spaces.
