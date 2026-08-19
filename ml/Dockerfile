# picpeak-ml — optional face-detection sidecar (#1074).
#
# Debian slim rather than Alpine: onnxruntime publishes manylinux wheels for
# x86_64 and aarch64 but nothing for musl, so Alpine would mean compiling ORT
# from source on both legs of the multi-arch build. The slim base costs ~40MB
# over Alpine and saves an hour of CI per build.

# ---------------------------------------------------------------------------
# Stage 1 — fetch and verify model weights
# ---------------------------------------------------------------------------
# Weights are baked in, never downloaded at runtime: airgapped installs must
# work, and a model that changes under a running deployment would silently
# invalidate every stored embedding.
#
# Both artifacts are pinned by URL *and* SHA-256. The checksum is the point —
# an immutable-looking URL that starts serving different bytes must fail the
# build rather than quietly reshape the embedding space.
FROM python:3.12-slim AS models

ARG YUNET_URL=https://media.githubusercontent.com/media/opencv/opencv_zoo/f12e12798e8314f7c074a6656816c048dcc95b7a/models/face_detection_yunet/face_detection_yunet_2023mar.onnx
ARG YUNET_SHA256=8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4

# FaceNet-512 as ONNX. deepface distributes this model as Keras .h5 only, so
# the ONNX is produced once by `tools/convert_facenet.py` and published as a
# release asset — converting inside this build would drag TensorFlow (~600MB)
# through both architecture legs to produce a file that is identical either
# way.
#
# Defaults to the canonical published artifact so `docker build ml/` and
# `docker compose --profile faces up` both work with no arguments. Override
# both together to use a different embedder. Blanking either one still fails
# the build loudly (below) rather than silently producing an image with no
# embedder — the checksum is what makes the URL safe to trust, so a URL
# without one is never acceptable.
ARG FACENET_ONNX_URL=https://github.com/PicPeak/picpeak/releases/download/ml-models-v1/facenet512.onnx
ARG FACENET_ONNX_SHA256=a1c06dcb79dc17a42af01d5bcbce4822caa148b9c24bf7eb8b8e556b4fd0d5db

RUN apt-get update \
    && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /models

RUN curl -fsSL -o face_detection_yunet_2023mar.onnx "${YUNET_URL}" \
    && echo "${YUNET_SHA256}  face_detection_yunet_2023mar.onnx" | sha256sum -c -

RUN if [ -z "${FACENET_ONNX_URL}" ] || [ -z "${FACENET_ONNX_SHA256}" ]; then \
      echo "ERROR: FACENET_ONNX_URL and FACENET_ONNX_SHA256 build args are required." >&2; \
      echo "       Produce the artifact with ml/tools/convert_facenet.py, publish it," >&2; \
      echo "       then pass both args. See ml/README.md." >&2; \
      exit 1; \
    fi \
    && curl -fsSL -o facenet512.onnx "${FACENET_ONNX_URL}" \
    && echo "${FACENET_ONNX_SHA256}  facenet512.onnx" | sha256sum -c -

# ---------------------------------------------------------------------------
# Stage 2 — runtime
# ---------------------------------------------------------------------------
FROM python:3.12-slim

ARG BUILD_DATE
ARG VCS_REF
ARG VERSION

LABEL org.opencontainers.image.source="https://github.com/PicPeak/picpeak"
LABEL org.opencontainers.image.description="PicPeak ML sidecar — face detection and embedding"
LABEL org.opencontainers.image.licenses="MIT"

# Busts the apt layer each CI run so the image picks up current Debian
# security updates instead of reusing a stale cached upgrade layer — same
# reasoning as backend/Dockerfile.
ARG CACHEBUST=1
RUN echo "cachebust=${CACHEBUST}" \
    && apt-get update \
    && apt-get upgrade -y \
    && rm -rf /var/lib/apt/lists/*

# No runtime apt packages at all — deliberately.
#
# opencv-python-headless 4.14 needs neither libgl1 nor libglib2.0-0. The
# wheel bundles what it needs; `ldd .../cv2/cv2*.so` resolves fully on a
# bare python:3.12-slim. Both were installed here on the assumption that
# the headless build still links libGL, which was true of much older
# wheels and is not true of this one.
#
# What they cost: libgl1 alone pulls 36 transitive packages (mesa, LLVM,
# X11) into a service that never opens a display, and libglib2.0-0t64
# carries a critical plus six highs. Together they accounted for 42 of
# this image's Trivy findings — none of which have an upstream fix, so
# not installing them is the only lever that exists.
#
# Before re-adding either, confirm it is actually needed: build without
# it and run `ml/tests` plus a real FaceDetectorYN.detect() call, since
# the API tests stub the pipeline and will pass either way.

WORKDIR /app

COPY requirements.txt .
# pip itself is ~10MB of an image that never installs anything at runtime.
#
# The `|| true` is scoped to the uninstall ONLY. Written as
# `pip install && pip uninstall || true` the shell parses it as
# `(install && uninstall) || true`, so a failed requirements install still
# produces a green layer — and CI would publish an ML image with no FastAPI,
# no uvicorn and no onnxruntime that fails at container start instead of at
# build time.
RUN pip install --no-cache-dir -r requirements.txt \
    && { pip uninstall -y pip setuptools 2>/dev/null || true; }

# Non-root. Nothing in this container writes anything — no volumes, no
# database, no model download — so the whole filesystem can stay read-only to
# the service account.
#
# Created BEFORE the copies so ownership can be set by COPY --chown. A
# `chown -R` afterwards would rewrite every copied file into a fresh layer,
# duplicating the 90MB model and adding ~94MB to the image for nothing.
RUN useradd --system --uid 1001 --create-home picpeak

COPY --from=models --chown=picpeak:picpeak /models /models
COPY --chown=picpeak:picpeak app ./app

USER picpeak

ENV FACE_MODEL_DIR=/models \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

EXPOSE 8000

# Mirrors the backend's healthcheck shape. /health is unauthenticated so this
# needs no secret; it reports liveness only, because a failed model load
# aborts startup and the container never serves at all.
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/health', timeout=4).status == 200 else 1)"

# Single worker on purpose: the models are loaded per process, so a second
# worker doubles RSS for a service the backend calls at concurrency 1.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
