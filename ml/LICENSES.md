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

> **Status: the model is chosen and verified, the encoder is not published.**
> `app/tag_text_embeddings.npz` is in this repository. The image encoder it
> belongs to (373 MB) is not hosted anywhere yet, so the image build still
> carries no URL and no checksum for it (`TAG_ENCODER_ONNX_URL` /
> `TAG_ENCODER_ONNX_SHA256` are empty) and the default image contains no
> tagging model.

| Artifact | Role | Source | Licence |
|---|---|---|---|
| `tag_image_encoder.onnx` | image encoder for zero-shot tags | image tower of [`google/siglip-base-patch16-224`](https://huggingface.co/google/siglip-base-patch16-224), exported by `tools/export_tagger.py` | Apache-2.0 |
| `app/tag_text_embeddings.npz` | text embeddings of `app/tag_vocabulary.json` | same model's text tower, same run | Apache-2.0 |

What was verified, and how (2026-10-12):

- Repository `google/siglip-base-patch16-224` on Hugging Face, revision
  `7fd15f0689c79d79e38b1c2e2e2370a7bf2761ed` (the head of `main` on that day, last modified 2024-09-26),
  resolved through the Hub API and pinned for the download.
- Licence: the model card (`README.md` at that revision) declares
  `license: apache-2.0` in its metadata, and the Hub API reports the same
  (`license:apache-2.0`). **That field is the only licence statement in the
  repository: it contains no LICENSE file.** The card also says it was
  written by the Hugging Face team, not by the model's authors. The upstream
  code release it points to, `google-research/big_vision`, was not
  re-checked for this entry.
- Weights as downloaded: `model.safetensors`, SHA-256
  `2c63cb7d1f2e95ba501893cbb8faeb4ea9a3af295498d35097126228659c2af8`.

Produced from that revision:

- `tag_image_encoder.onnx` — SHA-256
  `9505764eb4b013652ab236c15eeed6cbf099001db2bcf89624c2f6e75251b62a`
  (373,168,141 bytes). Not committed and not published. This is the checksum
  `app/tag_text_embeddings.npz` is bound to: an encoder with any other hash
  is refused at load.
- `app/tag_text_embeddings.npz` — SHA-256
  `3f004fae31061b7fc715b7fe3910bd362a4e3b5481d37aefd068bffeb095864e`
  (42 tags, 768 dimensions, 134 KB).

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
