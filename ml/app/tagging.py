"""
Zero-shot scene tagging (issue 1733).

One image goes through an image encoder; the result is scored against the
text embeddings of a fixed vocabulary (`tag_vocabulary.json`). The scores are
independent per tag (a sigmoid over a scaled cosine, the SigLIP formulation),
so a photo can carry several tags or none.

The text side never runs here. `tools/export_tagger.py` computes the
vocabulary's text embeddings once, with the reference tokenizer and text
encoder, and writes them next to the vocabulary. That keeps a second ~400 MB
model and a tokenizer dependency out of this image, and it means the prompts
are tokenized exactly as the model was trained, which a reimplementation here
could get subtly wrong without ever raising an error.

The price is that the embeddings file belongs to ONE vocabulary and ONE
encoder. Both are checked at load, and a mismatch refuses to tag rather than
score images against the wrong vectors.

Nothing in this module is loaded until the first /tags request, so an install
that never enables tagging pays no memory for it.
"""

import hashlib
import json
import os
import threading

import cv2
import numpy as np
import onnxruntime as ort

from . import config


class TaggingUnavailable(RuntimeError):
    """The tagging model is not installed, or does not match the vocabulary."""


def load_vocabulary(path: str | None = None) -> list[dict]:
    with open(path or config.TAG_VOCABULARY_PATH, encoding="utf-8") as fh:
        return json.load(fh)["tags"]


def vocabulary_fingerprint(tags: list[dict]) -> str:
    """SHA-256 over the (key, prompt) pairs, in order.

    Thresholds are deliberately left out: tuning one does not change what the
    text embeddings mean, so it must not invalidate them.
    """
    canonical = json.dumps(
        [[t["key"], t["prompt"]] for t in tags], ensure_ascii=False, separators=(",", ":")
    )
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def file_sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def select_tags(
    scores: np.ndarray, keys: list[str], thresholds: np.ndarray, top_k: int
) -> list[dict]:
    """Tags at or above their threshold, best first, at most `top_k`."""
    order = np.argsort(-scores, kind="stable")
    picked = []
    for idx in order:
        if len(picked) >= top_k:
            break
        if scores[idx] >= thresholds[idx]:
            picked.append({"tag": keys[idx], "score": round(float(scores[idx]), 4)})
    return picked


def preprocess(image_bytes: bytes, size: int, mean: np.ndarray, std: np.ndarray) -> np.ndarray:
    """Decode and shape one image as the encoder's NCHW float input.

    The whole frame is squashed to `size` x `size` without cropping, which is
    how SigLIP's own processor does it. Area interpolation when shrinking
    stands in for the antialiased bicubic of the reference pipeline.
    """
    buf = np.frombuffer(image_bytes, dtype=np.uint8)
    img = cv2.imdecode(buf, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Image could not be decoded")
    h, w = img.shape[:2]
    interpolation = cv2.INTER_AREA if max(h, w) > size else cv2.INTER_CUBIC
    img = cv2.resize(img, (size, size), interpolation=interpolation)
    rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB).astype(np.float32) / 255.0
    rgb = (rgb - mean) / std
    return rgb.transpose(2, 0, 1)[None, ...].astype(np.float32)


class TagPipeline:
    """The image encoder plus the vocabulary's text embeddings."""

    def __init__(self) -> None:
        if not os.path.exists(config.TAG_ENCODER_PATH):
            raise TaggingUnavailable("Tagging model not installed")
        if not os.path.exists(config.TAG_EMBEDDINGS_PATH):
            raise TaggingUnavailable("Tag text embeddings not installed")

        vocabulary = load_vocabulary()
        with np.load(config.TAG_EMBEDDINGS_PATH, allow_pickle=False) as data:
            meta = json.loads(str(data["meta"]))
            keys = [str(k) for k in data["keys"]]
            text = np.asarray(data["embeddings"], dtype=np.float32)

        if (
            meta.get("vocabulary_sha256") != vocabulary_fingerprint(vocabulary)
            or keys != [t["key"] for t in vocabulary]
        ):
            raise TaggingUnavailable(
                "Tag text embeddings do not match tag_vocabulary.json; "
                "regenerate them with tools/export_tagger.py"
            )
        if meta.get("encoder_sha256") != file_sha256(config.TAG_ENCODER_PATH):
            raise TaggingUnavailable(
                "Tag text embeddings were not produced with the installed image encoder"
            )

        so = ort.SessionOptions()
        so.intra_op_num_threads = config.ORT_THREADS
        so.inter_op_num_threads = config.ORT_THREADS
        self._session = ort.InferenceSession(
            config.TAG_ENCODER_PATH, sess_options=so, providers=["CPUExecutionProvider"]
        )
        inp = self._session.get_inputs()[0]
        self._input_name = inp.name
        self._size = int(inp.shape[2])

        self._lock = threading.Lock()
        self._keys = keys
        self._text = text
        self._scale = float(meta["logit_scale"])
        self._bias = float(meta["logit_bias"])
        self._mean = np.asarray(meta["mean"], dtype=np.float32)
        self._std = np.asarray(meta["std"], dtype=np.float32)
        self._thresholds = np.asarray(
            [t.get("threshold", config.TAG_SCORE_THRESHOLD) for t in vocabulary],
            dtype=np.float32,
        )
        self.model_version = f"{meta['model']}+vocab{meta['vocabulary_sha256'][:8]}"

    def process(self, image_bytes: bytes) -> list[dict]:
        batch = preprocess(image_bytes, self._size, self._mean, self._std)
        # One inference at a time: predictable RSS matters more here than
        # throughput, as for the face models.
        with self._lock:
            vec = self._session.run(None, {self._input_name: batch})[0][0]
        norm = float(np.linalg.norm(vec))
        if norm > 0:
            vec = vec / norm
        logits = self._text @ vec * self._scale + self._bias
        scores = 1.0 / (1.0 + np.exp(-logits))
        return select_tags(scores, self._keys, self._thresholds, config.TAG_TOP_K)
