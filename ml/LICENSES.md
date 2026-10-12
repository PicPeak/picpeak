# Model provenance and licences

PicPeak is run commercially by working photographers. That sets a hard rule
for this image:

> **No non-commercial artifact is ever baked into a PicPeak image.**

Every open face-recognition weight set traces back to a scraped,
research-only dataset — CASIA-WebFace, VGGFace2, MS1M, Glint360K and
WebFace260M all carry academic-use-only agreements, so "trained on clean
data" is not an option that exists. What differs, and what actually binds a
redistributor, is the grant the **distributor** places on the artifact we
copy into this image.

## Shipped in this image

| Artifact | Role | Distributor | Licence |
|---|---|---|---|
| `face_detection_yunet_2023mar.onnx` | detection | [OpenCV Zoo](https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet) | MIT |
| `facenet512.onnx` | embedding | [serengil/deepface](https://github.com/serengil/deepface) | MIT |

Both are redistributable. `facenet512.onnx` is converted from deepface's
published `facenet512_weights.h5` by `tools/convert_facenet.py`; the
conversion changes the container format, not the weights, so the MIT grant
carries over.

Pinned sources, verified by SHA-256 at build time:

- YuNet — `opencv/opencv_zoo` at commit `f12e12798e8314f7c074a6656816c048dcc95b7a`
  `8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4`
- FaceNet-512 source weights — `serengil/deepface_models` release `v1.0`
  `3f76b5117a9ca574d536af8199e6720089eb4ad3dc7e93534496d88265de864f`

## Scene tagging (optional, not in the default image)

> **Status: nothing is pinned yet.** No tagging artifact has been published,
> so the image build carries no URL and no checksum for one
> (`TAG_ENCODER_ONNX_URL` / `TAG_ENCODER_ONNX_SHA256` are empty), and the
> default image contains no tagging model. The table below is the intended
> source. Whoever publishes the artifact must confirm the licence from the
> model repository at the exact revision they export, then fill in the
> revision and both checksums here.

| Artifact | Role | Source | Licence |
|---|---|---|---|
| `tag_image_encoder.onnx` | image encoder for zero-shot tags | image tower of `google/siglip-base-patch16-224`, exported by `tools/export_tagger.py` | Apache-2.0 (model card), code Apache-2.0 (`google-research/big_vision`) — **to be re-confirmed at the pinned revision** |
| `app/tag_text_embeddings.npz` | text embeddings of `app/tag_vocabulary.json` | same model's text tower, same run | as above |

To be recorded on publication:

- model repository revision: `<not pinned yet>`
- `tag_image_encoder.onnx` SHA-256: `<not published yet>`
- `tag_text_embeddings.npz` SHA-256: `<not generated yet>`

The same rule as for faces applies: only a model whose **weights** carry a
commercial-use grant may be baked in. Several otherwise suitable image-text
models fail it (weights under a research or non-commercial licence while the
code is MIT), so a swap needs its weight licence checked, not its repository
licence.

No embeddings of guest photos are stored: the encoder's output is scored
against the vocabulary and discarded, and only tag keys and scores reach the
database.

## Deliberately NOT shipped

| Artifact | Why not |
|---|---|
| InsightFace `buffalo_*`, `antelopev2` | **Non-commercial research only.** Commercial use requires a licence from insightface.ai ([model zoo README](https://github.com/deepinsight/insightface/blob/master/model_zoo/README.md), [#2587](https://github.com/deepinsight/insightface/issues/2587)). Available as an opt-in via `FACE_MODEL`, downloaded by the operator who has cleared that licence themselves — never by us. |
| Idiap EdgeFace | CC BY-NC-SA 4.0 — explicitly non-commercial. The best accuracy-per-parameter of the candidates, and unusable for that reason. |
| AdaFace WebFace4M weights | MIT code, non-commercial weights. |

## What that choice cost

Measured on DeepFace's own matched benchmark (LFW, aligned, cosine — the only
comparison worth anything, since every model quotes its own "LFW 99.x%" on
its own pipeline):

| Embedder | with RetinaFace | with YuNet |
|---|---|---|
| **FaceNet-512** | **98.4%** | **97.9%** |
| ArcFace | 96.6% | 96.7% |
| SFace | 92.4% | 91.0% |

Choosing YuNet over RetinaFace costs ~0.5 points. Holding the
commercial-redistribution line costs nothing beyond that — FaceNet-512 is
both the most accurate option in the table *and* MIT. Taking the headline
numbers at face value would have pointed at SFace (advertised 0.9940, actual
91–92% matched) and cost seven points, which for clustering is fatal: every
false split invents a duplicate person and every false merge puts a stranger
into someone's "download my photos".
