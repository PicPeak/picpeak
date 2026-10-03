"""
API contract tests (#1074).

The pipeline is stubbed out — these cover the auth boundary and the request
guards, which is where a mistake is a security problem rather than an
accuracy problem. Model behaviour is the spike's job, not a unit test's.
"""

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token-not-a-secret"


class StubPipeline:
    dim = 512

    def process(self, image_bytes: bytes):
        if image_bytes == b"undecodable":
            raise ValueError("Image could not be decoded")
        return [
            {
                "bbox": [10.0, 20.0, 30.0, 40.0],
                "score": 0.99,
                "landmarks": [[1.0, 2.0]] * 5,
                "yaw": 0.0,
                "pitch": 0.0,
                "blur": 123.4,
                "embedding": [0.1] * 512,
            }
        ]


@pytest.fixture
def client(monkeypatch):
    from app import config, main

    monkeypatch.setattr(config, "TOKEN", TOKEN)
    monkeypatch.setattr(main.config, "TOKEN", TOKEN)
    monkeypatch.setattr(main, "FacePipeline", StubPipeline)

    with TestClient(main.app) as c:
        yield c


def _image_file(data: bytes = b"fake-jpeg-bytes"):
    return {"image": ("photo.jpg", data, "image/jpeg")}


class TestAuth:
    def test_health_needs_no_token(self, client):
        # The compose healthcheck calls this without a secret.
        r = client.get("/health")
        assert r.status_code == 200
        assert r.json() == {"status": "ok"}

    def test_info_without_token_is_401(self, client):
        assert client.get("/info").status_code == 401

    def test_info_with_wrong_token_is_401(self, client):
        r = client.get("/info", headers={"X-Face-ML-Token": "wrong"})
        assert r.status_code == 401

    def test_faces_without_token_is_401(self, client):
        r = client.post("/faces", files=_image_file())
        assert r.status_code == 401

    def test_401_body_leaks_nothing(self, client):
        # A prober should not learn whether the header name was even right.
        r = client.post("/faces", files=_image_file())
        assert r.json() == {"detail": "Unauthorized"}

    def test_startup_refuses_an_empty_token(self, monkeypatch):
        from app import config, main

        monkeypatch.setattr(config, "TOKEN", "")
        monkeypatch.setattr(main.config, "TOKEN", "")
        monkeypatch.setattr(main, "FacePipeline", StubPipeline)

        # Running open is the one failure mode this service must not have.
        with pytest.raises(RuntimeError, match="FACE_ML_TOKEN"):
            with TestClient(main.app):
                pass


class TestInfo:
    def test_reports_the_model_identity_the_backend_stores(self, client):
        from app import config

        r = client.get("/info", headers={"X-Face-ML-Token": TOKEN})
        assert r.status_code == 200
        body = r.json()
        assert body["model_version"] == config.MODEL_VERSION
        assert body["dim"] == 512


class TestFaces:
    def test_returns_faces_with_the_model_version(self, client):
        from app import config

        r = client.post(
            "/faces", files=_image_file(), headers={"X-Face-ML-Token": TOKEN}
        )
        assert r.status_code == 200
        body = r.json()
        assert body["model_version"] == config.MODEL_VERSION
        assert len(body["faces"]) == 1
        assert len(body["faces"][0]["embedding"]) == 512
        assert body["faces"][0]["bbox"] == [10.0, 20.0, 30.0, 40.0]

    def test_empty_upload_is_400(self, client):
        r = client.post(
            "/faces", files=_image_file(b""), headers={"X-Face-ML-Token": TOKEN}
        )
        assert r.status_code == 400

    def test_undecodable_image_is_400_not_500(self, client):
        # 4xx matters: the backend must mark the photo failed rather than
        # retry it forever, which is what it does for 5xx.
        r = client.post(
            "/faces",
            files=_image_file(b"undecodable"),
            headers={"X-Face-ML-Token": TOKEN},
        )
        assert r.status_code == 400

    def test_oversize_upload_is_413(self, client, monkeypatch):
        from app import main

        monkeypatch.setattr(main.config, "MAX_IMAGE_BYTES", 10)
        r = client.post(
            "/faces",
            files=_image_file(b"x" * 100),
            headers={"X-Face-ML-Token": TOKEN},
        )
        assert r.status_code == 413

    def test_oversize_content_length_is_413_before_the_body_is_read(self, client, monkeypatch):
        # A declared size far beyond the cap is refused by the middleware,
        # before the multipart parser has spooled anything. The body sent here
        # is tiny; only the header claims 1 GiB.
        from app import main

        monkeypatch.setattr(main.config, "MAX_IMAGE_BYTES", 10)
        r = client.post(
            "/faces",
            content=b"not even multipart",
            headers={
                "X-Face-ML-Token": TOKEN,
                "Content-Type": "multipart/form-data; boundary=x",
                "Content-Length": str(1024 * 1024 * 1024),
            },
        )
        assert r.status_code == 413

    def test_oversize_upload_is_read_in_bounded_chunks(self, client, monkeypatch):
        # Streaming the part is what keeps peak memory near the cap: the
        # handler may never request more than MAX_IMAGE_BYTES + 1 bytes from
        # the spooled upload, and must stop as soon as it passes the cap.
        from starlette.datastructures import UploadFile as StarletteUploadFile

        from app import main

        cap = 1024
        monkeypatch.setattr(main.config, "MAX_IMAGE_BYTES", cap)
        requested: list[int] = []
        original_read = StarletteUploadFile.read

        async def recording_read(self, size=-1):
            requested.append(size)
            return await original_read(self, size)

        monkeypatch.setattr(StarletteUploadFile, "read", recording_read)
        r = client.post(
            "/faces",
            files=_image_file(b"x" * (cap * 50)),
            headers={"X-Face-ML-Token": TOKEN},
        )
        assert r.status_code == 413
        assert requested, "the upload was never read through UploadFile.read"
        assert all(0 < size <= cap + 1 for size in requested)
        assert sum(requested) <= cap + 1

    def test_upload_at_the_cap_is_accepted(self, client, monkeypatch):
        from app import main

        cap = 1024
        monkeypatch.setattr(main.config, "MAX_IMAGE_BYTES", cap)
        r = client.post(
            "/faces",
            files=_image_file(b"x" * cap),
            headers={"X-Face-ML-Token": TOKEN},
        )
        assert r.status_code == 200
