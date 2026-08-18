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
