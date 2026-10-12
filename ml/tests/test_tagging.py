"""
Scene tagging (issue 1733): the /tags contract and the scoring around the
model.

The encoder itself is stubbed, as the face models are in test_api.py. What is
pinned here is everything a wrong model file or a wrong vocabulary would
otherwise get past silently: the lazy load, the artifact checks, the
threshold and top-k selection, and the shape of the encoder input.
"""

import json
import re

import cv2
import numpy as np
import pytest
from fastapi.testclient import TestClient

from app import config, tagging

TOKEN = "test-token-not-a-secret"
HEADERS = {"X-Face-ML-Token": TOKEN}


class StubFacePipeline:
    dim = 512

    def process(self, image_bytes: bytes):
        return []


class StubTagPipeline:
    model_version = "stub+vocab00000000"
    loads = 0

    def __init__(self):
        type(self).loads += 1

    def process(self, image_bytes: bytes):
        if image_bytes == b"undecodable":
            raise ValueError("Image could not be decoded")
        return [{"tag": "cake", "score": 0.91}, {"tag": "food", "score": 0.4}]


@pytest.fixture
def client(monkeypatch):
    from app import main

    monkeypatch.setattr(main.config, "TOKEN", TOKEN)
    monkeypatch.setattr(main, "FacePipeline", StubFacePipeline)
    monkeypatch.setattr(main, "_tag_pipeline", None)
    with TestClient(main.app) as c:
        yield c


@pytest.fixture
def tagging_client(client, monkeypatch):
    from app import main

    StubTagPipeline.loads = 0
    monkeypatch.setattr(main, "TagPipeline", StubTagPipeline)
    return client


def _image_file(data: bytes = b"fake-jpeg-bytes"):
    return {"image": ("photo.jpg", data, "image/jpeg")}


class TestTagsEndpoint:
    def test_without_token_is_401(self, tagging_client):
        r = tagging_client.post("/tags", files=_image_file())
        assert r.status_code == 401
        assert r.json() == {"detail": "Unauthorized"}

    def test_returns_tag_and_score_pairs(self, tagging_client):
        r = tagging_client.post("/tags", files=_image_file(), headers=HEADERS)
        assert r.status_code == 200
        assert r.json() == {
            "model_version": "stub+vocab00000000",
            "tags": [{"tag": "cake", "score": 0.91}, {"tag": "food", "score": 0.4}],
        }

    def test_model_is_loaded_on_first_use_and_only_once(self, tagging_client):
        # An install that never tags must never pay for the model.
        tagging_client.get("/health")
        tagging_client.post("/faces", files=_image_file(), headers=HEADERS)
        assert StubTagPipeline.loads == 0

        tagging_client.post("/tags", files=_image_file(), headers=HEADERS)
        tagging_client.post("/tags", files=_image_file(), headers=HEADERS)
        assert StubTagPipeline.loads == 1

    def test_missing_model_is_503_so_the_backend_retries(self, client, monkeypatch, tmp_path):
        # The real TagPipeline, with no encoder on disk: the default image.
        monkeypatch.setattr(config, "TAG_ENCODER_PATH", str(tmp_path / "absent.onnx"))
        r = client.post("/tags", files=_image_file(), headers=HEADERS)
        assert r.status_code == 503
        assert r.json() == {"detail": "Tagging model not installed"}

    def test_empty_upload_is_400(self, tagging_client):
        r = tagging_client.post("/tags", files=_image_file(b""), headers=HEADERS)
        assert r.status_code == 400

    def test_undecodable_image_is_400_not_500(self, tagging_client):
        r = tagging_client.post("/tags", files=_image_file(b"undecodable"), headers=HEADERS)
        assert r.status_code == 400

    def test_oversize_upload_is_413(self, tagging_client, monkeypatch):
        from app import main

        monkeypatch.setattr(main.config, "MAX_IMAGE_BYTES", 10)
        r = tagging_client.post("/tags", files=_image_file(b"x" * 100), headers=HEADERS)
        assert r.status_code == 413


class TestVocabulary:
    tags = tagging.load_vocabulary()

    def test_is_a_curated_list_of_unique_keys(self):
        keys = [t["key"] for t in self.tags]
        assert 30 <= len(keys) <= 50
        assert len(set(keys)) == len(keys)
        # The backend and the locale files use the key as an identifier.
        assert all(re.fullmatch(r"[a-z][a-z_]{1,31}", k) for k in keys)
        assert all(t["prompt"].strip() for t in self.tags)

    def test_names_no_personal_or_sensitive_attribute(self):
        # Scene tags only. Anything describing who a person is belongs to a
        # different legal category and does not go in this list.
        banned = re.compile(
            r"\b(man|men|woman|women|male|female|boy|girl|bride|groom|old|elderly|young|"
            r"child\w*|kids?|baby|teen\w*|race|ethnic\w*|skin|religio\w*|church|mosque|synagogue|temple|"
            r"disab\w*|wheelchair|pregnan\w*|sick|ill)\b"
        )
        for t in self.tags:
            assert not banned.search(t["prompt"].lower()), t["key"]
            assert not banned.search(t["key"].replace("_", " ")), t["key"]

    def test_committed_text_embeddings_belong_to_this_vocabulary(self):
        # Changing a key or a prompt without re-running tools/export_tagger.py
        # would ship a sidecar that refuses to tag. Fail here instead.
        with np.load(config.TAG_EMBEDDINGS_PATH, allow_pickle=False) as data:
            meta = json.loads(str(data["meta"]))
            keys = [str(k) for k in data["keys"]]
            embeddings = data["embeddings"]
        assert keys == [t["key"] for t in self.tags]
        assert meta["vocabulary_sha256"] == tagging.vocabulary_fingerprint(self.tags)
        assert embeddings.shape[0] == len(self.tags)
        assert np.allclose(np.linalg.norm(embeddings, axis=1), 1.0, atol=1e-4)
        assert re.fullmatch(r"[0-9a-f]{64}", meta["encoder_sha256"])

    def test_fingerprint_follows_prompts_but_not_thresholds(self):
        base = tagging.vocabulary_fingerprint(self.tags)
        tuned = [dict(t, threshold=0.5) for t in self.tags]
        assert tagging.vocabulary_fingerprint(tuned) == base
        reworded = [dict(self.tags[0], prompt="something else")] + self.tags[1:]
        assert tagging.vocabulary_fingerprint(reworded) != base


class TestSelectTags:
    keys = ["a", "b", "c", "d"]

    def test_keeps_tags_at_or_above_their_own_threshold_best_first(self):
        scores = np.array([0.2, 0.9, 0.5, 0.05], dtype=np.float32)
        thresholds = np.array([0.15, 0.15, 0.6, 0.15], dtype=np.float32)
        picked = tagging.select_tags(scores, self.keys, thresholds, top_k=5)
        # c scores higher than a but misses its own, stricter threshold.
        assert [p["tag"] for p in picked] == ["b", "a"]
        assert picked[0]["score"] == pytest.approx(0.9)

    def test_caps_at_top_k(self):
        scores = np.array([0.9, 0.8, 0.7, 0.6], dtype=np.float32)
        thresholds = np.full(4, 0.1, dtype=np.float32)
        picked = tagging.select_tags(scores, self.keys, thresholds, top_k=2)
        assert [p["tag"] for p in picked] == ["a", "b"]

    def test_nothing_above_threshold_is_an_empty_list(self):
        scores = np.full(4, 0.01, dtype=np.float32)
        thresholds = np.full(4, 0.1, dtype=np.float32)
        assert tagging.select_tags(scores, self.keys, thresholds, top_k=5) == []


def _png(width=64, height=48, colour=(0, 0, 255)) -> bytes:
    img = np.zeros((height, width, 3), dtype=np.uint8)
    img[:] = colour  # BGR
    ok, buf = cv2.imencode(".png", img)
    assert ok
    return buf.tobytes()


class TestPreprocess:
    mean = np.array([0.5, 0.5, 0.5], dtype=np.float32)
    std = np.array([0.5, 0.5, 0.5], dtype=np.float32)

    def test_squashes_to_a_normalized_rgb_nchw_batch(self):
        batch = tagging.preprocess(_png(), 32, self.mean, self.std)
        assert batch.shape == (1, 3, 32, 32)
        assert batch.dtype == np.float32
        # A pure red image (BGR 0,0,255): R channel first, at +1 after
        # (x/255 - 0.5) / 0.5, the others at -1. Swapped channels would not
        # raise, they would just tag every photo a little worse.
        assert batch[0, 0].mean() == pytest.approx(1.0)
        assert batch[0, 1].mean() == pytest.approx(-1.0)
        assert batch[0, 2].mean() == pytest.approx(-1.0)

    def test_undecodable_bytes_raise_value_error(self):
        with pytest.raises(ValueError):
            tagging.preprocess(b"not an image", 32, self.mean, self.std)


class TestResizeBicubic:
    """The resize has to be Pillow's antialiased bicubic, not merely a resize.

    The expected values were produced with Pillow 12.3 (`Image.resize(...,
    Image.BICUBIC)`), which is what SigLIP's own image processor calls.
    Pillow is not a dependency of this service, hence the pinned numbers.
    """

    @staticmethod
    def _pattern() -> np.ndarray:
        src = (np.arange(12)[:, None] * 37 + np.arange(10)[None, :] * 53) % 256
        return np.stack([src, 255 - src, src * 3 % 256], axis=-1).astype(np.uint8)

    def test_shrinking_matches_pillow(self):
        out = tagging.resize_bicubic(self._pattern(), 4).astype(int)
        red = [[92, 156, 107, 145], [167, 110, 151, 95], [87, 158, 108, 148], [138, 109, 141, 110]]
        blue = [[104, 141, 127, 134], [148, 121, 127, 123], [108, 133, 128, 109], [137, 122, 107, 138]]
        assert np.abs(out[..., 0] - np.array(red)).max() <= 1
        assert np.abs(out[..., 2] - np.array(blue)).max() <= 1

    def test_enlarging_matches_pillow(self):
        out = tagging.resize_bicubic(self._pattern()[:3, :3], 5).astype(int)
        red = [
            [0, 13, 50, 87, 107], [10, 27, 64, 101, 121], [33, 53, 90, 127, 147],
            [59, 79, 116, 153, 173], [73, 93, 130, 167, 187],
        ]
        assert np.abs(out[..., 0] - np.array(red)).max() <= 1

    def test_shrinking_averages_instead_of_sampling(self):
        # A one-pixel checkerboard has no detail left at a quarter of its
        # size. A filter without antialiasing picks single pixels and returns
        # black-and-white noise; this one returns mid grey.
        board = ((np.indices((64, 64)).sum(axis=0) % 2) * 255).astype(np.uint8)
        out = tagging.resize_bicubic(np.repeat(board[..., None], 3, axis=2), 16)
        assert out.min() >= 120 and out.max() <= 135

    def test_a_large_frame_is_brought_down_before_the_exact_filter(self, monkeypatch):
        seen = []
        original = tagging.resize_bicubic
        monkeypatch.setattr(
            tagging, "resize_bicubic", lambda rgb, size: seen.append(rgb.shape) or original(rgb, size)
        )
        mean = std = np.array([0.5, 0.5, 0.5], dtype=np.float32)
        batch = tagging.preprocess(_png(width=3000, height=1000), 32, mean, std)
        assert batch.shape == (1, 3, 32, 32)
        assert seen == [(43, 128, 3)]


class FakeSession:
    """Stands in for the ONNX encoder: returns one fixed image embedding."""

    def __init__(self, embedding):
        self._embedding = np.asarray(embedding, dtype=np.float32)
        self.fed = None

    def get_inputs(self):
        class Input:
            name = "pixel_values"
            shape = [1, 3, 32, 32]

        return [Input()]

    def run(self, _outputs, feeds):
        self.fed = feeds
        return [self._embedding[None, :]]


@pytest.fixture
def installed(monkeypatch, tmp_path):
    """A three-tag vocabulary with orthogonal text embeddings, on disk."""
    vocabulary = [
        {"key": "cake", "prompt": "a photo of a cake"},
        {"key": "night", "prompt": "a photo taken at night"},
        {"key": "pets", "prompt": "a photo of a dog or a cat", "threshold": 0.99},
    ]
    vocab_path = tmp_path / "tag_vocabulary.json"
    vocab_path.write_text(json.dumps({"version": 1, "tags": vocabulary}))
    encoder_path = tmp_path / "tag_image_encoder.onnx"
    encoder_path.write_bytes(b"not really an onnx file")
    embeddings_path = tmp_path / "tag_text_embeddings.npz"

    def write(**overrides):
        meta = {
            "model": "test-model",
            "encoder_sha256": tagging.file_sha256(str(encoder_path)),
            "vocabulary_sha256": tagging.vocabulary_fingerprint(vocabulary),
            "logit_scale": 10.0,
            "logit_bias": -5.0,
            "mean": [0.5, 0.5, 0.5],
            "std": [0.5, 0.5, 0.5],
            **overrides,
        }
        np.savez(
            embeddings_path,
            meta=np.array(json.dumps(meta)),
            keys=np.array([t["key"] for t in vocabulary]),
            embeddings=np.eye(3, dtype=np.float32),
        )

    write()
    monkeypatch.setattr(config, "TAG_VOCABULARY_PATH", str(vocab_path))
    monkeypatch.setattr(config, "TAG_ENCODER_PATH", str(encoder_path))
    monkeypatch.setattr(config, "TAG_EMBEDDINGS_PATH", str(embeddings_path))
    monkeypatch.setattr(config, "TAG_SCORE_THRESHOLD", 0.5)
    monkeypatch.setattr(config, "TAG_TOP_K", 5)

    session = FakeSession([3.0, 0.0, 4.0])  # normalizes to [0.6, 0, 0.8]
    monkeypatch.setattr(tagging.ort, "InferenceSession", lambda *a, **k: session)
    return {"write": write, "session": session, "vocab_path": vocab_path}


class TestTagPipeline:
    def test_scores_the_image_against_the_vocabulary(self, installed):
        pipeline = tagging.TagPipeline()
        found = pipeline.process(_png())

        # sigmoid(10 * cos - 5): cake 0.6 -> 0.73, night 0 -> 0.007,
        # pets 0.8 -> 0.95 but below its own 0.99 threshold.
        assert [t["tag"] for t in found] == ["cake"]
        assert found[0]["score"] == pytest.approx(1 / (1 + np.exp(-1.0)), abs=1e-3)
        assert installed["session"].fed["pixel_values"].shape == (1, 3, 32, 32)
        assert pipeline.model_version.startswith("test-model+vocab")

    def test_refuses_embeddings_made_for_another_vocabulary(self, installed):
        installed["vocab_path"].write_text(json.dumps({"version": 1, "tags": [
            {"key": "cake", "prompt": "a reworded prompt"},
            {"key": "night", "prompt": "a photo taken at night"},
            {"key": "pets", "prompt": "a photo of a dog or a cat"},
        ]}))
        with pytest.raises(tagging.TaggingUnavailable, match="do not match"):
            tagging.TagPipeline()

    def test_refuses_embeddings_made_with_another_encoder(self, installed):
        installed["write"](encoder_sha256="0" * 64)
        with pytest.raises(tagging.TaggingUnavailable, match="image encoder"):
            tagging.TagPipeline()

    def test_missing_embeddings_are_unavailable_not_a_crash(self, installed, monkeypatch, tmp_path):
        monkeypatch.setattr(config, "TAG_EMBEDDINGS_PATH", str(tmp_path / "absent.npz"))
        with pytest.raises(tagging.TaggingUnavailable):
            tagging.TagPipeline()
