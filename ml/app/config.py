"""
Configuration for the picpeak-ml sidecar (#1074).

Everything is read once at import. There is no reload path and no settings
API — this service is stateless by design, and an operator changing a knob
restarts the container.
"""

import os

# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------

MODEL_DIR = os.environ.get("FACE_MODEL_DIR", "/models")

DETECTOR_FILENAME = "face_detection_yunet_2023mar.onnx"
EMBEDDER_FILENAME = os.environ.get("FACE_EMBEDDER_FILENAME", "facenet512.onnx")

DETECTOR_NAME = "yunet_2023mar"
EMBEDDER_NAME = os.environ.get("FACE_MODEL", "facenet512")

# Stamped onto every face row the backend stores. Changing the detector, the
# embedder, the alignment or the normalization MUST bump this: embeddings from
# two different pipelines are not comparable, and a silent mix produces
# clusters that look plausible and are wrong. The backend keys re-derivation
# off this string.
MODEL_VERSION = f"{DETECTOR_NAME}+{EMBEDDER_NAME}+v1"

# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

# Shared secret, required. `main.py` refuses to start without it rather than
# defaulting to open: an accidentally published port must not be a free
# face-detection API.
TOKEN = os.environ.get("FACE_ML_TOKEN", "").strip()
TOKEN_HEADER = "X-Face-ML-Token"

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

# YuNet's own confidence floor. Deliberately permissive: the backend applies
# the *product* quality floor (score, blur, bbox size) because those
# thresholds are admin-tunable there and baked-in here. This service's job is
# to report what it saw, not to decide what counts.
DET_SCORE_THRESHOLD = float(os.environ.get("FACE_DET_SCORE_THRESHOLD", "0.6"))
NMS_THRESHOLD = float(os.environ.get("FACE_NMS_THRESHOLD", "0.3"))
TOP_K = int(os.environ.get("FACE_DET_TOP_K", "5000"))

# Guard rails on untrusted input. The backend only ever sends its own preview
# renditions (≤1920px), but this service must not fall over if something else
# reaches it.
MAX_IMAGE_BYTES = int(os.environ.get("FACE_MAX_IMAGE_BYTES", str(32 * 1024 * 1024)))
MAX_FACES = int(os.environ.get("FACE_MAX_FACES", "64"))

# Long edge the image is downscaled to before detection. Matches the backend's
# preview tier (imageProcessor.js generates ≤1920px), so the common case is a
# no-op; anything larger is scaled down here so detection cost stays bounded.
# Bboxes and landmarks are always reported in ORIGINAL image coordinates.
INPUT_LONG_EDGE = int(os.environ.get("FACE_INPUT_LONG_EDGE", "1920"))

# ---------------------------------------------------------------------------
# Runtime
# ---------------------------------------------------------------------------

# One ORT thread by default. The backend's face queue runs at concurrency 1
# (it shares a host with Sharp, which is the real memory pressure — see
# backgroundProcessor.js), so letting ORT fan out across every core buys
# nothing and costs RSS.
ORT_THREADS = int(os.environ.get("FACE_ORT_THREADS", "1"))
