"""
Embedding-space fingerprint (#1084): did anything shift under our feet?

`requirements.txt` is pinned exactly so that rebuilds produce byte-identical
embeddings — a decode, warp, standardization or kernel that changes behaviour
would move every stored cluster silently. That guarantee is only as strong as
our ability to check it, and "the tests pass" does not check it: the API tests
stub `FacePipeline`, so nothing compares numbers across two builds.

This prints a hash per stage. Run it against the OLD image and the NEW one, on
the SAME machine, and diff the output.

Reading the diff:

  * Keys with NO prefix are the compatibility verdict. If every one matches,
    stored clusters stay valid. If any differs, existing installs need a
    re-scan, and the change has to be a deliberate, announced decision rather
    than a side effect of a base-image or dependency bump.
  * `diag_*` keys are DIAGNOSTIC ONLY and carry no verdict — they exercise a
    path production does not run, and exist to localise the cause when a real
    key moves. A `diag_*` change on its own is not a reason to re-scan.
  * `_`-prefixed keys are metadata: versions, thresholds and the compatibility
    key. They are printed rather than hashed because the fixture cannot reach
    them, so a reviewer has to read them. A change to `_thresholds` or
    `_effective_det_score` matters even when every hash matches.

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

# A fixed 64x48 PROGRESSIVE JPEG, embedded as bytes rather than encoded at
# runtime. Production input is always the preview rendition, which the backend
# writes with `progressive: true` (imageProcessor.js:236/480/617) — progressive
# and baseline take different paths through libjpeg, so a baseline fixture
# would miss a change that moves every real photo. Non-square on purpose: a
# square fixture cannot tell a width/height swap from correct behaviour.
# Embedded rather than encoded here because calling cv2.imencode would make
# the *input* depend on the very encoder version we are trying to hold still.
FIXED_JPEG = base64.b64decode(
    "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsK"
    "CwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQU"
    "FBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wgARCAAwAEADASIA"
    "AhEBAxEB/8QAGQABAQEBAQEAAAAAAAAAAAAABQYEAwcI/8QAGQEBAAMBAQAAAAAAAAAAAAAABgMF"
    "BwIE/9oADAMBAAIQAxAAAAH5t3tb+ZRkGUFduKgygqt5LnW88qWhb2UCOLjb2t6q3GQZQV3ElyrP"
    "OM091OgygHzUbe1vVXA25mMawSU1W8ymW//EABkQAAMBAQEAAAAAAAAAAAAAAAACBAEDBf/aAAgB"
    "AQABBQJJxJxJxJxJxJyqcScScScScScScScqnEnEnEnEnEnEnEnKpzOGLiTiTiTiTiTiTlfDFz0K"
    "9r1JxJxJxJxJzOGLnvV7XqTiTiTiTiTmcMXPQr2vaZxJz//EACERAAEDAgcBAAAAAAAAAAAAAAIA"
    "AQMEBRETISMxUeHw/9oACAEDAQE/AYiURKIlSFtsoiURKIlWXqG0UrSHqT8N34oiURK5XqG0Q5h6"
    "k/Dd+J6+avPPnfF3+wZf/8QAIREAAQQBAwUAAAAAAAAAAAAABAABAgMFBjGyESIlYoL/2gAIAQIB"
    "AT8BGKQxSGKWoCvL3fPFkMUhikMUsxKV+auZtu3iyGKQxSx0pXy6Nss3bGrK2xj68WX/xAAfEAAB"
    "AwQDAQAAAAAAAAAAAAABAgMhABEgQRMwohD/2gAIAQEABj8CyR0I6EVcwBvNJMAXmuNuGR6yuYA3"
    "SW24ZHrK5gDdcbcMj1SPn//EAB0QAAMAAwEBAQEAAAAAAAAAAAABYREhUcHwcYH/2gAIAQEAAT8h"
    "iRJkSJE4u+ESJEiRIkTi74RIkSJEiROLvg440sttJIiRJkSJExHpM20ktG8jH4265PlEiRIkRxxp"
    "ZbaSRlMYcba25PlEiRIkxxxpZbaSRvIx/W65Plzd8In/2gAMAwEAAgADAAAAEFoe/HV6rKViYv/E"
    "ACARAQABAgYDAAAAAAAAAAAAAAERIUEAECCBobExUcH/2gAIAQMBAT8QzV53vQqtNVXqp4F23glQ"
    "clmr7XVfBd2JUMde6CWAsFjdlVx//8QAHBEAAwEAAwEBAAAAAAAAAAAAAAEhMRFR4UHB/9oACAEC"
    "AQE/EMKYUwp9IeFMKYUZlwlPr9zCmFEJ/Ca+vSf6XrZ//8QAHBABAQEAAgMBAAAAAAAAAAAAATEA"
    "EcEQIUGB/9oACAEBAAE/EJ9dPI9NPJ9NPwan008n008ns8n4PTyeT2eT6aeT6+GmUUOgByqsA0+u"
    "nkemnk+uniIKGgAlVgGZXY8IT6D4Gfp98GTyeTyeTxlFDoAcqrAN7F2XhCeAfBT9PvgyezyfXTyP"
    "TMoodADlVYBmV2PCCfQfAz9Pvg8Op5//2Q=="
)


def _hash(array):
    return hashlib.sha256(np.ascontiguousarray(array, dtype=np.float32).tobytes()).hexdigest()[:16]


# Every field of a face the backend actually stores (faceProcessor.js:157-167).
# Hashing only the embedding would approve a change that leaves the vector
# alone but moves something the backend clusters on: det_score and bbox size
# gate meetsQualityFloor (faceClustering.js:96-100), so a face can silently
# drop in or out of clustering with an identical embedding.
_PERSISTED_FIELDS = ("bbox", "score", "yaw", "pitch", "blur", "embedding")


def _hash_all(faces):
    """Hash every returned face, in order, one hash per persisted field.

    Every face, not just the first: the forced-low threshold yields dozens of
    candidates, and hashing only candidate 0 would report a match while a
    numerical change moved candidates 1..n, or while their ORDER changed —
    both of which alter what production stores. Stacking preserves order, so
    a reshuffle shows up too.

    One hash per field rather than one combined hash, so a diff says which
    thing moved instead of only that something did.
    """
    if not faces:
        # Not fatal, but it means the stage pinned nothing — say so loudly
        # rather than printing a reassuring hash of an empty result.
        return {f: "NO-DETECTIONS-STAGE-VACUOUS" for f in _PERSISTED_FIELDS}
    return {
        field: _hash(np.stack([np.atleast_1d(np.asarray(f[field], dtype=np.float32)) for f in faces]))
        for field in _PERSISTED_FIELDS
    }


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

    # 2b. The same model as a raw ONNX forward pass — DIAGNOSTIC ONLY, hence
    #     the diag_ prefix. Production never runs YuNet through onnxruntime, so
    #     an ORT change touching a YuNet operator moves these while real
    #     behaviour is untouched. Treating that as "rescan needed" would cost a
    #     full-gallery rescan for nothing. They earn their place by splitting
    #     the cause when 2a does move: both together means the model changed,
    #     2a alone means OpenCV's DNN path did.
    det_sess = ort.InferenceSession(det_path, providers=["CPUExecutionProvider"])
    det_in = det_sess.get_inputs()[0]
    _, _, h, w = det_in.shape
    det_tensor = (
        _deterministic_bgr(max(h, w))[:h, :w].astype(np.float32).transpose(2, 0, 1)[None, ...]
    )
    det_outs = det_sess.run(None, {det_in.name: det_tensor})
    for meta, arr in zip(det_sess.get_outputs(), det_outs):
        out[f"diag_ort_{meta.name}"] = _hash(arr)

    # 3. Alignment and embedding, through the production pipeline. This is what
    #    actually decides where a face lands in the embedding space: umeyama +
    #    warpAffine, then BGR->RGB, per-image standardization, layout and the
    #    L2 normalization the backend's cosine similarity depends on.
    pipeline = FacePipeline()
    # Read what the detector was ACTUALLY constructed with, before the override
    # below replaces it. _thresholds.det_score only echoes config; if
    # FacePipeline ever stopped applying it — falling back to OpenCV's 0.9
    # default, say — production would detect a different face set while every
    # hash here still matched, because the override erases the evidence.
    out["_effective_det_score"] = round(float(pipeline._detector.getScoreThreshold()), 6)
    # Emitted, not just used: the fixture is too small to trip the resize in
    # either image, and the forced pass below overrides the value in both, so
    # a production change from 1920 to 960 would move no hash at all. Printing
    # it puts the change in the diff where a reviewer will see it.
    out["_thresholds"] = {
        "det_score": config.DET_SCORE_THRESHOLD,
        "nms": config.NMS_THRESHOLD,
        "input_long_edge": config.INPUT_LONG_EDGE,
        "top_k": config.TOP_K,
        # Not a hash — a compatibility key. /faces stamps it on every result
        # and faceClustering.js:190 refuses to compare a face against a person
        # carrying a different one, so a change here forces a full rescan even
        # when every number below is identical.
        "model_version": config.MODEL_VERSION,
        # Emitted because the fixture never reaches it: pipeline.py:138 slices
        # to MAX_FACES, so raising 64 -> 128 changes nothing here while real
        # group photos would persist a different face set.
        "max_faces": config.MAX_FACES,
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

    # 4. End to end, through process(). The isolated stages above cannot see the
    #    orchestration between them: INPUT_LONG_EDGE resizing, and the row ->
    #    landmark scaling in _one_face that turns detector output into the
    #    coordinates _align consumes. A change there moves newly generated
    #    embeddings relative to stored clusters while every stage hash above
    #    holds still, because _align is handed fixed landmarks rather than the
    #    detector's.
    #
    #    Same threshold trick as 2a, applied to the pipeline's own detector so
    #    a faceless synthetic frame still produces rows to carry through the
    #    real code path.
    pipeline._detector.setScoreThreshold(1e-6)
    detected = pipeline.process(FIXED_JPEG)
    out["process_face_count"] = len(detected)
    for field, digest in _hash_all(detected).items():
        out[f"process_{field}"] = digest

    # 5. The same path again with the downscale branch forced. process() only
    #    resizes when the long edge exceeds INPUT_LONG_EDGE (1920), and no
    #    fixture small enough to embed here ever will — so without this the
    #    resize and its inverse landmark scaling are never executed, and a
    #    change to either would leave every hash above untouched. Lowering the
    #    threshold under the fixture is cheaper than carrying a 1920px image in
    #    the source, and exercises the identical code.
    _real_long_edge = config.INPUT_LONG_EDGE
    try:
        # 48 < the fixture's 64px long edge, so the resize fires; small
        # enough to matter, large enough that YuNet still returns rows.
        # At 32 the downscaled frame (32x24) yields nothing and the stage
        # silently pins nothing, which is what the VACUOUS marker caught.
        config.INPUT_LONG_EDGE = 48
        downscaled = pipeline.process(FIXED_JPEG)
    finally:
        config.INPUT_LONG_EDGE = _real_long_edge
    out["process_downscaled_count"] = len(downscaled)
    # Bboxes as well as embeddings. In the pass above the scale is 1, so
    # `row[0:4]` never goes through inverse scaling and a regression there
    # stays hidden; the embeddings would not catch it either, because those
    # are derived from separately scaled landmarks. A wrong bbox is what
    # breaks avatar crops and area calculations.
    for field, digest in _hash_all(downscaled).items():
        out[f"process_downscaled_{field}"] = digest

    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
