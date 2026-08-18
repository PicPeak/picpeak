"""
Detection → alignment → embedding (#1074).

The alignment step in the middle is the part that decides whether this
feature works. FaceNet was trained on similarity-aligned crops; handing it a
raw bbox crop costs far more accuracy than any model swap would recover. So
YuNet's five landmarks are used to warp every face onto the same canonical
template before it ever reaches the embedder.

IMPORTANT — the alignment and normalization below must stay identical to
whatever the Phase 0 spike measured its cosine threshold on. A tuned
threshold does not transfer across alignment changes; if either is touched,
`MODEL_VERSION` bumps and the backend re-derives.
"""

import threading

import cv2
import numpy as np
import onnxruntime as ort

from . import config


# Canonical 5-point template (ArcFace's, the de-facto standard), expressed for
# a 112x112 crop and scaled to whatever the embedder actually wants. Points are
# in IMAGE coordinates, left to right:
#   0 subject's right eye (appears image-left)
#   1 subject's left eye
#   2 nose tip
#   3 subject's right mouth corner
#   4 subject's left mouth corner
# YuNet emits its landmarks in exactly this order, so the mapping is index-wise
# with no reshuffling — `test_pipeline.py` pins that assumption.
_TEMPLATE_112 = np.array(
    [
        [38.2946, 51.6963],
        [73.5318, 51.5014],
        [56.0252, 71.7366],
        [41.5493, 92.3655],
        [70.7299, 92.2041],
    ],
    dtype=np.float32,
)


class FacePipeline:
    """Loads both models once and serves them under a lock.

    cv2.FaceDetectorYN carries mutable input-size state across setInputSize/
    detect, so it is NOT safe to call from two threads. FastAPI runs sync
    endpoints in a threadpool, so every inference path is serialized here.
    That is not a throughput loss worth fixing: the backend's face queue
    defaults to concurrency 1, and a single lock keeps RSS predictable, which
    is the constraint that actually matters on a 2 GB VPS.
    """

    def __init__(self) -> None:
        detector_path = f"{config.MODEL_DIR}/{config.DETECTOR_FILENAME}"
        embedder_path = f"{config.MODEL_DIR}/{config.EMBEDDER_FILENAME}"

        self._lock = threading.Lock()

        self._detector = cv2.FaceDetectorYN.create(
            model=detector_path,
            config="",
            input_size=(320, 320),  # replaced per-image via setInputSize
            score_threshold=config.DET_SCORE_THRESHOLD,
            nms_threshold=config.NMS_THRESHOLD,
            top_k=config.TOP_K,
        )

        so = ort.SessionOptions()
        so.intra_op_num_threads = config.ORT_THREADS
        so.inter_op_num_threads = config.ORT_THREADS
        self._embedder = ort.InferenceSession(
            embedder_path, sess_options=so, providers=["CPUExecutionProvider"]
        )

        # Read the embedder's geometry off the model rather than hardcoding
        # 160x160 NHWC. FACE_MODEL is documented as swappable (an operator who
        # has cleared the InsightFace licence may point this at buffalo_l,
        # which is 112x112 NCHW), and guessing wrong produces a confident
        # garbage embedding rather than an error.
        inp = self._embedder.get_inputs()[0]
        shape = inp.shape
        if len(shape) != 4:
            raise RuntimeError(f"Embedder input must be 4-D, got {shape}")
        self._input_name = inp.name
        # NCHW iff the channel axis is second.
        self._nchw = shape[1] == 3
        self._crop_size = int(shape[2] if self._nchw else shape[1])

        out = self._embedder.get_outputs()[0]
        self._dim = int(out.shape[-1])

        self._template = _TEMPLATE_112 * (self._crop_size / 112.0)

    # -- introspection ----------------------------------------------------

    @property
    def dim(self) -> int:
        return self._dim

    # -- inference --------------------------------------------------------

    def process(self, image_bytes: bytes) -> list[dict]:
        """Decode, detect, align, embed. Returns one dict per face."""
        buf = np.frombuffer(image_bytes, dtype=np.uint8)
        img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
        if img is None:
            raise ValueError("Image could not be decoded")

        # Downscale for detection, then map coordinates back. Everything the
        # caller sees is in ORIGINAL image pixels — the backend stores bboxes
        # to crop avatars from the same rendition later, so a scaled
        # coordinate would silently offset every cover face.
        h, w = img.shape[:2]
        long_edge = max(h, w)
        if long_edge > config.INPUT_LONG_EDGE:
            scale = config.INPUT_LONG_EDGE / long_edge
            det_img = cv2.resize(
                img, (round(w * scale), round(h * scale)), interpolation=cv2.INTER_AREA
            )
        else:
            scale = 1.0
            det_img = img

        with self._lock:
            dh, dw = det_img.shape[:2]
            self._detector.setInputSize((dw, dh))
            _, raw = self._detector.detect(det_img)

            if raw is None:
                return []

            faces = []
            for row in raw[: config.MAX_FACES]:
                faces.append(self._one_face(img, row, scale))
            return faces

    def _one_face(self, img: np.ndarray, row: np.ndarray, scale: float) -> dict:
        """Build the response entry for a single YuNet detection.

        `row` is YuNet's 15-wide output: x, y, w, h, then five (x, y)
        landmark pairs, then the confidence score. All in detection-image
        coordinates, hence the division by `scale`.
        """
        inv = 1.0 / scale
        x, y, bw, bh = (float(v) * inv for v in row[0:4])
        landmarks = (row[4:14].reshape(5, 2).astype(np.float32)) * inv
        score = float(row[14])

        aligned = self._align(img, landmarks)
        embedding = self._embed(aligned)
        yaw, pitch = _pose_from_landmarks(landmarks)

        return {
            "bbox": [x, y, bw, bh],
            "score": score,
            "landmarks": landmarks.tolist(),
            "yaw": yaw,
            "pitch": pitch,
            "blur": _blur_score(aligned),
            "embedding": embedding.tolist(),
        }

    def _align(self, img: np.ndarray, landmarks: np.ndarray) -> np.ndarray:
        """Similarity-warp the face onto the canonical template."""
        matrix = _umeyama(landmarks, self._template)
        if matrix is None:
            # Degenerate landmarks (all coincident/collinear). Fall back to a
            # plain centre crop so the face still gets an embedding rather
            # than vanishing from the gallery.
            matrix = _fallback_transform(landmarks, self._crop_size)
        return cv2.warpAffine(
            img,
            matrix,
            (self._crop_size, self._crop_size),
            flags=cv2.INTER_LINEAR,
            borderValue=0,
        )

    def _embed(self, aligned: np.ndarray) -> np.ndarray:
        # BGR (OpenCV) → RGB (what FaceNet was trained on). Getting this
        # backwards does not error, it just quietly degrades every embedding.
        rgb = cv2.cvtColor(aligned, cv2.COLOR_BGR2RGB).astype(np.float32)

        # deepface's "Facenet" normalization: per-image standardization. This
        # is what the published FaceNet-512 benchmark numbers were produced
        # with, so it is what the threshold in the backend assumes.
        mean, std = rgb.mean(), rgb.std()
        rgb = (rgb - mean) / max(float(std), 1e-6)

        batch = rgb[None, ...]
        if self._nchw:
            batch = batch.transpose(0, 3, 1, 2)

        vec = self._embedder.run(None, {self._input_name: batch})[0][0]

        # L2-normalize so the backend's cosine similarity is a plain dot
        # product and centroid means stay on the unit sphere.
        norm = float(np.linalg.norm(vec))
        return (vec / norm) if norm > 0 else vec


def _umeyama(src: np.ndarray, dst: np.ndarray) -> np.ndarray | None:
    """Least-squares similarity transform (Umeyama 1991) over ALL five points.

    Deliberately NOT cv2.estimateAffinePartial2D. That function's estimators
    are RANSAC (its default) and LMEDS, both of which exist to *reject
    outliers* among many noisy correspondences. Given exactly five points and
    no outliers they fit a three-point subset perfectly and let the rest
    drift: measured on a real off-frontal portrait, both pinned the eyes and
    nose to 0.11px and left the mouth corners 11.8px out on a 160px crop.
    Umeyama distributes the residual instead (max 6.5px, rms 5.1 vs 7.4) and
    is what insightface's norm_crop and skimage's SimilarityTransform use.

    Also fully deterministic — no random consensus sampling — which matters
    beyond accuracy: the same photo must embed identically on every re-scan,
    or clusters churn between runs for no reason.

    Returns a 2x3 affine matrix, or None if the points are degenerate.
    """
    src = np.asarray(src, dtype=np.float64)
    dst = np.asarray(dst, dtype=np.float64)

    src_mean, dst_mean = src.mean(axis=0), dst.mean(axis=0)
    src_c, dst_c = src - src_mean, dst - dst_mean

    variance = float((src_c**2).sum() / len(src))
    if variance < 1e-9:
        return None  # all points coincident

    cov = dst_c.T @ src_c / len(src)
    u, s, vt = np.linalg.svd(cov)

    # Guard against the SVD handing back a reflection instead of a rotation —
    # a mirrored face would embed as a different person.
    d = np.array([1.0, 1.0])
    if np.linalg.det(u @ vt) < 0:
        d[-1] = -1.0

    rotation = u @ np.diag(d) @ vt
    scale = float((s * d).sum() / variance)
    translation = dst_mean - scale * (rotation @ src_mean)

    return np.hstack([scale * rotation, translation.reshape(2, 1)]).astype(np.float32)


def _fallback_transform(landmarks: np.ndarray, size: int) -> np.ndarray:
    """Centre the landmark centroid in the crop at the template's scale.

    Only reached when the landmarks are degenerate enough that no similarity
    transform exists. The resulting embedding will be poor, but the face
    still appears in "this photo contains" rather than vanishing — and the
    backend's quality floor will keep it from spawning its own person.
    """
    centre = landmarks.mean(axis=0)
    s = size / 112.0
    return np.array(
        [[s, 0.0, size / 2.0 - s * centre[0]], [0.0, s, size / 2.0 - s * centre[1]]],
        dtype=np.float32,
    )


def _blur_score(aligned: np.ndarray) -> float:
    """Variance of the Laplacian — low means soft/out-of-focus.

    Computed on the ALIGNED crop, not the original frame, so the number is
    comparable between a face that fills the frame and one in the background:
    both arrive here at the same pixel size. The backend's quality floor
    compares against it directly.
    """
    grey = cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(grey, cv2.CV_64F).var())


def _pose_from_landmarks(landmarks: np.ndarray) -> tuple[float, float]:
    """Rough head pose in degrees from the five landmarks.

    An approximation, deliberately: a real 3-D pose estimate needs a face
    model and solvePnP, and the only consumers are a quality floor and the
    "candid" auto-category rule, neither of which needs better than
    "clearly turned away vs. not". Returned as degrees so the admin-facing
    threshold reads in a familiar unit.

    yaw   negative = turned toward the subject's right, positive = left
    pitch negative = looking down, positive = looking up
    """
    right_eye, left_eye, nose, right_mouth, left_mouth = landmarks

    eye_centre = (right_eye + left_eye) / 2.0
    mouth_centre = (right_mouth + left_mouth) / 2.0
    eye_span = float(np.linalg.norm(left_eye - right_eye))
    if eye_span < 1e-6:
        return 0.0, 0.0

    # Yaw: on a frontal face the nose sits midway between the eyes. As the
    # head turns, it slides toward the nearer eye. Offset is normalized by
    # eye span so it is scale-free, then mapped through arcsin.
    yaw_ratio = float((nose[0] - eye_centre[0]) / (eye_span / 2.0))
    yaw = float(np.degrees(np.arcsin(np.clip(yaw_ratio, -1.0, 1.0))))

    # Pitch: the nose sits ~40% of the way down the eye→mouth axis on a
    # frontal face. Higher means the head is tilted back, lower means down.
    vertical = float(mouth_centre[1] - eye_centre[1])
    if abs(vertical) < 1e-6:
        return yaw, 0.0
    nose_ratio = float((nose[1] - eye_centre[1]) / vertical)
    pitch = float(np.degrees(np.arcsin(np.clip((0.40 - nose_ratio) * 2.0, -1.0, 1.0))))

    return round(yaw, 2), round(pitch, 2)
