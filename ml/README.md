# picpeak-ml

> **Looking for how to use the feature?** →
> [docs.picpeak.app/features/face-recognition](https://docs.picpeak.app/features/face-recognition)
> covers enabling it, the per-gallery toggle, consent and what guests see.
> This document is the sidecar's HTTP contract and deployment notes.

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
| `POST /tags` | multipart `image` → `{model_version, tags: [{tag, score}]}` (optional, see "Scene tagging") |

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
python3.11 -m venv .venv && . .venv/bin/activate   # 3.11: TF has no 3.12+ wheels
pip install -r tools/requirements-convert.txt

curl -fsSL -o facenet512_weights.h5 \
  https://github.com/serengil/deepface_models/releases/download/v1.0/facenet512_weights.h5
echo "3f76b5117a9ca574d536af8199e6720089eb4ad3dc7e93534496d88265de864f  facenet512_weights.h5" | sha256sum -c -

python tools/convert_facenet.py facenet512_weights.h5 facenet512.onnx
```

The script verifies the converted graph against the Keras original before
writing (worst observed divergence: 2.1e-06 absolute, cosine 1.0000000000)
and prints the SHA-256 to publish. Output is ~89.6 MB, 23,497,424 parameters.

Publish `facenet512.onnx` as a release asset, set the repository variables
`FACENET_ONNX_URL` and `FACENET_ONNX_SHA256` (Settings → Variables — it's a
public URL, not a secret), and CI picks it up. To build locally:

```bash
docker build -t picpeak-ml \
  --build-arg FACENET_ONNX_URL=https://github.com/PicPeak/picpeak/releases/download/<tag>/facenet512.onnx \
  --build-arg FACENET_ONNX_SHA256=<sha256> \
  ml/
```

The conversion sits outside the Docker build because TensorFlow is ~600MB of
build dependency for a file that never ships in the final image, and the
result is architecture-independent — no reason to run it on both legs of
every multi-arch build.

**The conversion is not byte-reproducible.** Two runs with the same pinned
versions on the same machine produce functionally identical graphs (same 336
nodes, same 271 initializers, weights matching to 0.000e+00) but differ in a
few initializer names, because tf2onnx's traced-op naming is not
deterministic. So a re-conversion **will** have a different SHA-256, and that
is expected rather than a sign of tampering. The checksum pins one published
artifact so its URL cannot start serving different bytes; validating a fresh
conversion is the parity check's job, not the hash's.

## Scene tagging

`POST /tags` scores one image against a fixed vocabulary of event-photography
scenes ([`app/tag_vocabulary.json`](app/tag_vocabulary.json), 42 tags such as
`ceremony`, `cake`, `dancing`, `outdoor`) and returns the ones that pass their
threshold, best first, at most `TAG_TOP_K`:

```jsonc
{ "model_version": "siglip-base-patch16-224@7fd15f0689c7+vocab2c80423a",
  "tags": [ { "tag": "black_and_white", "score": 0.15 }, { "tag": "sunset", "score": 0.024 } ] }
```

Scores are independent per tag (sigmoid, the SigLIP formulation), so an image
can carry several tags or none. The vocabulary describes scenes and objects
only: nothing about who a person is.

**The default image does not contain the tagging model**, and `/tags` answers
`503` until it does: the 373 MB image encoder is not published anywhere yet.
See [LICENSES.md](LICENSES.md) for the model, the pinned revision and the
checksums. To produce the encoder:

```bash
cd ml
python3.11 -m venv .venv && . .venv/bin/activate
pip install -r tools/requirements-export-tagger.txt
python tools/export_tagger.py --model google/siglip-base-patch16-224 \
  --revision 7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed --out-dir /tmp/tagger
sha256sum /tmp/tagger/tag_image_encoder.onnx   # must equal the one in LICENSES.md
```

Publish `tag_image_encoder.onnx` and pass its URL and SHA-256 as
`TAG_ENCODER_ONNX_URL` / `TAG_ENCODER_ONNX_SHA256` (build args, or repository
variables for CI). The script also writes `tag_text_embeddings.npz`; the copy
in `app/` was made by exactly this run. The two belong together: the sidecar
refuses to tag when the embeddings were made for a different encoder file or
a different vocabulary, so after changing a key or a prompt, re-run the
script and commit the new `.npz`.

To run it without an image, point the sidecar at a directory holding the
encoder (`TAG_MODEL_DIR`, default `FACE_MODEL_DIR`).

The model is loaded on the first `/tags` request, not at startup. The backend
only calls `/tags` once the `autoTagging` feature flag and a gallery's own
switch are both on, so an install that leaves tagging off never loads it.

### Measured

One machine (Apple Silicon laptop, one ONNX Runtime thread), so read these
as an order of magnitude; a small VPS core is several times slower.

| | |
|---|---|
| Resident memory, face models loaded and used, before any `/tags` call | 322 MB |
| Same process after the first `/tags` call | 691 MB (about +370 MB), 714 MB after 50 more |
| A process that is never asked for tags (flag on, no gallery switched on, 12 s) | no `/tags` request, model not loaded, 358 MB |
| First `/tags` call, including the model load | 0.5 s |
| Later `/tags` calls, over HTTP | 0.085 s median (0.074 to 0.099) |
| ONNX encoder against the PyTorch model, same input | scores equal to 5 decimals |

### Thresholds, and what they are based on

| Variable | Default | |
|---|---|---|
| `TAG_SCORE_THRESHOLD` | `0.01` | a tag is reported at or above this score; a vocabulary entry may set its own `threshold` |
| `TAG_TOP_K` | `5` | most tags reported per image |

The scores are small by nature. SigLIP's sigmoid answers "is this exact
caption the pair of this image", and a generic caption rarely is: a clearly
applicable scene tag scores 0.01 to 0.1, an inapplicable one below 0.001.

The ten sample photos in `test-images/`, tagged through the real path
(thumbnail from the backend, this sidecar), every score of 0.001 or more:

| Photo | Scores | At 0.01 |
|---|---|---|
| black-and-white field, low sun | black_and_white 0.150, sunset 0.024, landscape 0.007, outdoor 0.003 | black_and_white, sunset: both right |
| park benches in autumn | outdoor 0.006, landscape 0.002 | none (outdoor would be right) |
| cactus in a pot, close-up | details 0.002 | none (details would be right) |
| feet of passengers in a tram | audience 0.001 | none (audience is wrong) |
| conifers above a bay | landscape 0.097, outdoor 0.035, beach 0.002 | landscape, outdoor: both right |
| backlit cactus | landscape 0.008, sunset 0.002, outdoor 0.001 | none (landscape would be wrong) |
| forest in fog | landscape 0.008, outdoor 0.002 | none (both would be right) |
| suspension bridge in fog | landscape 0.002 | none |
| small island in a calm sea | landscape 0.028, beach 0.008, outdoor 0.003 | landscape: right (beach would be wrong) |
| laptop on a table | nothing | none |

At 0.01 that is five tags, all correct, and seven photos without a tag. At
0.005 it is ten tags, two of them wrong; at 0.002, eighteen with three wrong
and two debatable. 0.01 was chosen because a wrong chip in a guest's filter
is worse than a missing one. Top-k never came into play (at most two tags
passed), so 5 is untested as a limit.

**These thresholds are provisional.** Ten landscape-like photos without a
single person, cake or dance floor say almost nothing about event
photography, where most of the vocabulary lives. Before relying on the
feature, tag a few real galleries and look at the result; per-tag
`threshold` values in the vocabulary are the tool for tags that turn out
too eager or too shy.

Preprocessing is the reference one: the frame is squashed to 224x224 with an
antialiased bicubic filter, implemented in `app/tagging.py` and held to
within one grey level of Pillow by the tests. That is not a detail. A plain
area resize, the first implementation, moved scores at this scale by an
order of magnitude (conifers above a bay: landscape 0.002 with area, 0.048
with bicubic, on the same thumbnail).

## Not available on the all-in-one image

The single-container image (`Dockerfile.aio`) sets
`PICPEAK_SINGLE_CONTAINER=true`, and the backend refuses to enable face
recognition when it sees that — the feature flag cannot be switched on, and
per-event detection stays off even if a restored database says otherwise.

This is a performance decision, not a licensing or packaging one. That image
runs the backend, the frontend, SQLite and every background worker inside one
container aimed at "one photographer plus guests browsing". It has no Redis,
SQLite gives it a single writer, and it contains no ML sidecar to talk to.
Adding a second image-processing pipeline that competes with Sharp for the
same CPU and RAM would not fail loudly — it would just make the whole install
slow and appear broken.

Run the standard multi-container deployment if you want this feature.

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
