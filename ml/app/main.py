"""
picpeak-ml — optional face-detection sidecar for PicPeak (#1074).

Four endpoints, no database, no volumes, no egress. Models are baked into
the image at build time, so an airgapped install works and nothing is
downloaded at runtime.

The service is deliberately dumb: it reports what it saw in one image and
forgets. Clustering, identity, thresholds and every privacy decision live in
the backend, where the data already is.
"""

import logging
import threading
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Header, HTTPException, Request, UploadFile
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse

from . import config
from .pipeline import FacePipeline
from .schemas import FacesResponse, HealthResponse, InfoResponse, TagsResponse
from .tagging import TaggingUnavailable, TagPipeline

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [picpeak-ml] %(message)s"
)
logger = logging.getLogger(__name__)

_pipeline: FacePipeline | None = None

# Scene tagging (issue 1733). Loaded on the first /tags request, never at
# startup: the backend only calls /tags once tagging is switched on, so an
# install that leaves it off keeps this model out of memory.
_tag_pipeline: TagPipeline | None = None
_tag_pipeline_lock = threading.Lock()


def _get_tag_pipeline() -> TagPipeline:
    global _tag_pipeline
    if _tag_pipeline is None:
        with _tag_pipeline_lock:
            if _tag_pipeline is None:
                _tag_pipeline = TagPipeline()
                logger.info("Tagging model loaded: %s", _tag_pipeline.model_version)
    return _tag_pipeline


@asynccontextmanager
async def lifespan(app: FastAPI):
    global _pipeline

    # Refuse to run open. An accidentally published port must not be a free
    # face-detection API, and a service that silently accepted anonymous
    # requests when the operator forgot the variable would be exactly that.
    if not config.TOKEN:
        raise RuntimeError(
            "FACE_ML_TOKEN is not set. picpeak-ml will not start without a "
            "shared secret — set it on both this container and the backend."
        )

    logger.info("Loading models from %s", config.MODEL_DIR)
    _pipeline = FacePipeline()
    logger.info(
        "Ready: detector=%s embedder=%s version=%s dim=%d",
        config.DETECTOR_NAME,
        config.EMBEDDER_NAME,
        config.MODEL_VERSION,
        _pipeline.dim,
    )
    yield
    global _tag_pipeline
    _pipeline = None
    _tag_pipeline = None


app = FastAPI(
    title="picpeak-ml",
    description="Face detection and embedding sidecar for PicPeak",
    lifespan=lifespan,
    # No interactive docs: this is a machine-to-machine service on a private
    # network, and /docs is just surface.
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


# Room for the multipart framing (boundary lines, part headers) around an
# image that is exactly at the cap.
_MULTIPART_SLACK = 64 * 1024
_READ_CHUNK = 1024 * 1024


@app.middleware("http")
async def reject_oversized_body(request: Request, call_next):
    """Refuse an upload by its declared size before the multipart parser runs.

    Starlette parses the form before the endpoint and its dependencies run,
    so a Content-Length far beyond the image cap would otherwise be parsed in
    full first. Answer 413 straight away; the bounded read in /faces covers
    bodies that arrive without a usable Content-Length.
    """
    if request.method == "POST":
        declared = request.headers.get("content-length", "")
        if declared.isdigit() and int(declared) > config.MAX_IMAGE_BYTES + _MULTIPART_SLACK:
            return JSONResponse(status_code=413, content={"detail": "Image too large"})
    return await call_next(request)


def require_token(x_face_ml_token: str = Header(default="")) -> None:
    """Constant-time-ish shared-secret check.

    Python's `==` on str short-circuits, so this leaks a timing signal in
    principle. It is not worth `hmac.compare_digest` gymnastics for a token
    that only travels over a private Docker network — but it IS worth
    rejecting with a bare 401 and no detail, so a prober learns nothing about
    whether the header name was even right.
    """
    if x_face_ml_token != config.TOKEN:
        raise HTTPException(status_code=401, detail="Unauthorized")


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    """Unauthenticated on purpose — the compose healthcheck calls it.

    Reports only liveness. It deliberately does not confirm the models
    loaded, because lifespan raises on failure and the container never
    reaches a serving state at all.
    """
    return HealthResponse(status="ok")


@app.get("/info", response_model=InfoResponse, dependencies=[Depends(require_token)])
def info() -> InfoResponse:
    assert _pipeline is not None
    return InfoResponse(
        detector=config.DETECTOR_NAME,
        embedder=config.EMBEDDER_NAME,
        model_version=config.MODEL_VERSION,
        dim=_pipeline.dim,
    )


async def _read_image(image: UploadFile) -> bytes:
    """The uploaded image, refused with 413 past the cap and 400 when empty."""
    # Read in bounded chunks and stop at the first byte past the cap, so an
    # oversized upload is never materialised as one bytes object: at most
    # MAX_IMAGE_BYTES + 1 bytes are ever requested from the spooled part.
    limit = config.MAX_IMAGE_BYTES
    chunks: list[bytes] = []
    received = 0
    while received <= limit:
        chunk = await image.read(min(_READ_CHUNK, limit + 1 - received))
        if not chunk:
            break
        received += len(chunk)
        chunks.append(chunk)
    if received > limit:
        raise HTTPException(status_code=413, detail="Image too large")
    data = b"".join(chunks)
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    return data


@app.post("/faces", response_model=FacesResponse, dependencies=[Depends(require_token)])
async def faces(image: UploadFile = File(...)) -> FacesResponse:
    assert _pipeline is not None

    data = await _read_image(image)

    try:
        detected = _pipeline.process(data)
    except ValueError as exc:
        # Undecodable input is the caller's problem, not ours — 400 so the
        # backend marks the photo 'failed' instead of retrying it forever.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return FacesResponse(model_version=config.MODEL_VERSION, faces=detected)


@app.post("/tags", response_model=TagsResponse, dependencies=[Depends(require_token)])
async def tags(image: UploadFile = File(...)) -> TagsResponse:
    """Scene tags for one image: `[{tag, score}]`, best first.

    Same auth, size cap and error shape as /faces. 503 means the tagging
    model is not part of this image (or does not match the vocabulary); the
    backend keeps the photo queued, as for any other 5xx.
    """
    data = await _read_image(image)

    try:
        # Off the event loop: the first call loads the model, and /health has
        # to keep answering while it does.
        pipeline = await run_in_threadpool(_get_tag_pipeline)
        found = await run_in_threadpool(pipeline.process, data)
    except TaggingUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return TagsResponse(model_version=pipeline.model_version, tags=found)


@app.exception_handler(Exception)
async def unhandled(request, exc: Exception) -> JSONResponse:
    """Never leak a traceback to the caller.

    The backend treats 5xx as "sidecar unhealthy" and puts the photo back to
    pending with backoff, which is the right behaviour for a genuine internal
    fault — so the useful detail belongs in our log, not in the response.
    """
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal error"})
