"""
Response models (#1074).

These are the wire contract the backend's `faceClient.js` codes against.
Changing a field name here is a breaking change for a deployment mid-upgrade,
where an old sidecar and a new backend run side by side for a few seconds.
"""

from pydantic import BaseModel, Field


class Face(BaseModel):
    # [x, y, w, h] in ORIGINAL image pixels — the backend crops cover-face
    # avatars from the same rendition, so these must not be detection-scaled.
    bbox: list[float] = Field(min_length=4, max_length=4)
    score: float
    # Five (x, y) pairs: subject's right eye, left eye, nose tip, right mouth
    # corner, left mouth corner.
    landmarks: list[list[float]]
    yaw: float
    pitch: float
    # Variance of the Laplacian on the aligned crop. Higher = sharper.
    blur: float
    # L2-normalized, `dim` floats (512 for FaceNet-512).
    embedding: list[float]


class FacesResponse(BaseModel):
    model_version: str
    faces: list[Face]


class InfoResponse(BaseModel):
    detector: str
    embedder: str
    model_version: str
    dim: int


class HealthResponse(BaseModel):
    status: str
