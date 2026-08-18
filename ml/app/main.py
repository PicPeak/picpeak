"""
picpeak-ml — optional face-detection sidecar for PicPeak (#1074).

Three endpoints, no database, no volumes, no egress. Models are baked into
the image at build time, so an airgapped install works and nothing is
downloaded at runtime.

The service is deliberately dumb: it reports what it saw in one image and
forgets. Clustering, identity, thresholds and every privacy decision live in
the backend, where the data already is.
"""

import logging
from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, File, Header, HTTPException, UploadFile
from fastapi.responses import JSONResponse

from . import config
from .pipeline import FacePipeline
from .schemas import FacesResponse, HealthResponse, InfoResponse

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s [picpeak-ml] %(message)s"
)
logger = logging.getLogger(__name__)

_pipeline: FacePipeline | None = None


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
    _pipeline = None


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


@app.post("/faces", response_model=FacesResponse, dependencies=[Depends(require_token)])
async def faces(image: UploadFile = File(...)) -> FacesResponse:
    assert _pipeline is not None

    data = await image.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty upload")
    if len(data) > config.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large")

    try:
        detected = _pipeline.process(data)
    except ValueError as exc:
        # Undecodable input is the caller's problem, not ours — 400 so the
        # backend marks the photo 'failed' instead of retrying it forever.
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return FacesResponse(model_version=config.MODEL_VERSION, faces=detected)


@app.exception_handler(Exception)
async def unhandled(request, exc: Exception) -> JSONResponse:
    """Never leak a traceback to the caller.

    The backend treats 5xx as "sidecar unhealthy" and puts the photo back to
    pending with backoff, which is the right behaviour for a genuine internal
    fault — so the useful detail belongs in our log, not in the response.
    """
    logger.exception("Unhandled error: %s", exc)
    return JSONResponse(status_code=500, content={"detail": "Internal error"})
