"""
Embedding-space fingerprint (#1084): did anything shift under our feet?

`requirements.txt` is pinned exactly so that rebuilds produce byte-identical
embeddings — a decode, warp, standardization or kernel that changes behaviour
would move every stored cluster silently. That guarantee is only as strong as
our ability to check it, and "the tests pass" does not check it: the API tests
stub `FacePipeline`, so nothing compares numbers across two builds.

This prints a hash per stage. Run it against the OLD image and the NEW one, on
the SAME machine, and diff the output. Identical hashes mean stored clusters
stay valid; any difference means existing installs need a re-scan, and the
change has to be a deliberate, announced decision rather than a side effect of
a base-image or dependency bump.

`tools/` is in .dockerignore and never ships inside the image, so mount just
this file — NOT the whole `ml/` tree. Mounting `ml/` would put the checkout's
`app/` package ahead of the image's own `/app/app`, so both containers would
run the same pipeline source and a code difference between two images would
vanish from the comparison:

    docker run --rm -v "$PWD/ml/tools:/tools:ro" --entrypoint python \
      <image> /tools/fingerprint_pipeline.py

Compare on one host only. The hashes are NOT portable across architectures —
OpenCV and onnxruntime both dispatch to different SIMD kernels on x86 and
aarch64, so an amd64 result will not match an arm64 one even when nothing has
changed. This answers "did this change move the numbers", not "is every
platform identical".

Every stage runs the PRODUCTION code path. Reimplementing the maths here would
drift from `app/pipeline.py` and quietly start fingerprinting the wrong thing,
so `_align` and `_embed` are called directly even though they are private —
pinning internal numerics is the entire point.
"""
import base64
import hashlib
import json
import os
import sys

import cv2
import numpy as np
import onnxruntime as ort

# Import the app package the IMAGE ships, not the checkout's. The whole point
# is to compare two built images; sourcing pipeline.py from a bind mount would
# make both runs execute identical code and hide exactly the differences this
# is meant to surface. /app is the runtime WORKDIR; the parent-of-tools
# fallback only exists so the tool still runs from a plain source checkout.
_IMAGE_APP_ROOT = "/app"
if os.path.isdir(os.path.join(_IMAGE_APP_ROOT, "app")):
    sys.path.insert(0, _IMAGE_APP_ROOT)
else:
    sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

from app import config  # noqa: E402
from app.pipeline import FacePipeline  # noqa: E402

# A fixed 48x48 JPEG, embedded as bytes rather than encoded at runtime.
# Production input is always the preview rendition, which the backend writes as
# JPEG (imageProcessor.js), so the decoder under test has to be libjpeg — and
# calling cv2.imencode here would make the *input* depend on the very encoder
# version we are trying to hold still.
FIXED_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK"
    "CwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQU"
    "FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAwADADASIA"
    "AhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQA"
    "AAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3"
    "ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWm"
    "p6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEA"
    "AwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSEx"
    "BhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElK"
    "U1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3"
    "uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD827Lw"
    "50+T9K37Lw50+WuzsvDnT5a37Lw50+X9KjLc021OrC1TjbHw50+X9K37Lw50+WuysvDnT5a6Cy8O"
    "dPkr9Vy3NNtT6/C1TjLLw50+X9K6Cy8OdPlrsrLw50+Wt+y8OdPlr9Vy3NNtT67C1TzWy8OdPlrf"
    "svDnT5K7Ky8OdPk/SugsvDnT5a/z4y3NNtT8JwtU4yy8OdPlrfsvDnT5f0rs7Hw50+X9K37Lw50+"
    "Wv1XLc021PrsLVONsvDnT5a37Lw50+T9K7Oy8OdPk/St+y8OdPlr9Wy3NNtT6/C1TzSy8OdPlrfs"
    "vDnT5a7Oy8OdPlrfsvDnT5P0r/PjLc021PwjC1TjbLw50+Wt+y8OdPlrs7Lw50+Wt+x8OdPl/Sv1"
    "XLc021Pr8LVOMsvDnT5a3INDjtoXmmKxQxqXeRyFVVAySSegArs4NDjtoXmmKxQxqXeRyFVVAySS"
    "egArxj4h+LpPFsx07Tt0WjRtycENcsDwzDsoPRfxPOAv7Tw7UqY+ooQdord9v+CcXEvGmC4RwX1i"
    "u+arL4IX1k/0iur+Su2kf//Z"
)


def _hash(array):
    return hashlib.sha256(np.ascontiguousarray(array, dtype=np.float32).tobytes()).hexdigest()[:16]


def _deterministic_bgr(size):
    """A fixed BGR image. Arithmetic, so it cannot drift with any codec."""
    y, x = np.mgrid[0:size, 0:size]
    return np.stack([(x * 5) % 256, (y * 5) % 256, ((x + y) * 3) % 256], axis=-1).astype(np.uint8)


def main():
    import app.pipeline

    out = {
        "_versions": {
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "cv2": cv2.__version__,
            "onnxruntime": ort.__version__,
        },
        # Which pipeline.py actually ran. If this says /tools/.. or a checkout
        # path instead of /app, the mount is shadowing the image's own code and
        # the comparison is not measuring what it claims to.
        "_app_source": app.pipeline.__file__,
    }

    # 1. Decode. JPEG specifically: the worker only ever sees preview renditions.
    decoded = cv2.imdecode(np.frombuffer(FIXED_JPEG, np.uint8), cv2.IMREAD_COLOR)
    out["decode_jpeg"] = _hash(decoded)

    det_path = os.path.join(config.MODEL_DIR, config.DETECTOR_FILENAME)
    det_scene = _deterministic_bgr(320)

    # 2a. Detector through OpenCV, which is what production actually uses.
    #     cv2.FaceDetectorYN runs its own preprocessing, its own DNN engine and
    #     its own NMS/landmark decode — none of which onnxruntime exercises, so
    #     an OpenCV upgrade could move real landmarks (and therefore alignment
    #     and embeddings) while an ORT-only check stayed identical.
    #
    #     The threshold is dropped to the floor ON PURPOSE. Synthetic input has
    #     no face, so at the production 0.6 this returns nothing and pins
    #     nothing; near-zero forces candidates through the same code path and
    #     makes the stage produce numbers. The service's real thresholds are
    #     recorded below so a change to them is still visible in the diff.
    yn = cv2.FaceDetectorYN.create(
        model=det_path,
        config="",
        input_size=(320, 320),
        score_threshold=1e-6,
        nms_threshold=config.NMS_THRESHOLD,
        top_k=config.TOP_K,
    )
    yn.setInputSize((320, 320))
    retval, faces = yn.detect(det_scene)
    out["detect_cv2_retval"] = int(retval)
    out["detect_cv2_faces"] = "none" if faces is None else _hash(faces)
    out["detect_cv2_count"] = 0 if faces is None else int(faces.shape[0])

    # 2b. The same model as a raw ONNX forward pass. Kept alongside 2a because
    #     it isolates the model file plus onnxruntime from OpenCV's wrapper: if
    #     both move together it is a model change, if only 2a moves it is
    #     OpenCV's DNN path.
    det_sess = ort.InferenceSession(det_path, providers=["CPUExecutionProvider"])
    det_in = det_sess.get_inputs()[0]
    _, _, h, w = det_in.shape
    det_tensor = (
        _deterministic_bgr(max(h, w))[:h, :w].astype(np.float32).transpose(2, 0, 1)[None, ...]
    )
    det_outs = det_sess.run(None, {det_in.name: det_tensor})
    for meta, arr in zip(det_sess.get_outputs(), det_outs):
        out[f"detect_ort_{meta.name}"] = _hash(arr)

    # 3. Alignment and embedding, through the production pipeline. This is what
    #    actually decides where a face lands in the embedding space: umeyama +
    #    warpAffine, then BGR->RGB, per-image standardization, layout and the
    #    L2 normalization the backend's cosine similarity depends on.
    pipeline = FacePipeline()
    out["_thresholds"] = {
        "det_score": config.DET_SCORE_THRESHOLD,
        "nms": config.NMS_THRESHOLD,
    }

    scene = _deterministic_bgr(256)
    # Fixed landmark set (eyes, nose, mouth corners) in the canonical order the
    # pipeline expects, chosen to give the warp a non-trivial rotation+scale.
    landmarks = np.array(
        [[96.0, 104.0], [160.0, 100.0], [128.0, 140.0], [104.0, 176.0], [154.0, 174.0]],
        dtype=np.float32,
    )
    aligned = pipeline._align(scene, landmarks)
    out["align_warp"] = _hash(aligned)

    embedding = pipeline._embed(aligned)
    out["embed"] = _hash(embedding)
    out["embed_l2"] = round(float(np.linalg.norm(embedding)), 6)

    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
