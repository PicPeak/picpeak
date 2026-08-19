"""
Embedding-space fingerprint (#1084): did anything shift under our feet?

`requirements.txt` is pinned exactly so that rebuilds produce byte-identical
embeddings — a decode, resize or kernel that changes behaviour would silently
move every stored cluster without failing a single test. That guarantee is
only as strong as our ability to check it, and "the tests pass" does not check
it: the API tests stub the pipeline, and nothing compares numbers across two
builds.

This prints a hash per stage. Run it inside the OLD image and the NEW one, on
the SAME machine, and diff the output. Identical hashes mean stored clusters
stay valid; any difference means existing installs would need a re-scan, and
the change needs to be a deliberate, announced decision rather than a side
effect of a base-image or dependency bump.

    docker run --rm --entrypoint python <old-image> tools/fingerprint_pipeline.py
    docker run --rm --entrypoint python <new-image> tools/fingerprint_pipeline.py

Compare on one host only. The hashes are NOT portable across architectures —
OpenCV and onnxruntime both dispatch to different SIMD kernels on x86 and
aarch64, so an amd64 result will not match an arm64 one even when nothing has
changed. This answers "did this change move the numbers", not "is every
platform identical".

Inputs are generated, not read from disk: the point is a fixed stimulus that
needs no fixture and cannot drift.
"""
import hashlib
import json
import os
import struct
import sys
import zlib

import cv2
import numpy as np
import onnxruntime as ort

MODEL_DIR = os.environ.get("FACE_MODEL_DIR", "/models")


def _png(width, height):
    """A deterministic PNG. Encoded by hand so the bytes never depend on the
    encoder version — an image written by cv2.imwrite would itself be a
    moving target."""
    raw = b"".join(
        b"\x00" + bytes((x * 7 + y * 13) % 256 for x in range(width * 3))
        for y in range(height)
    )

    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)

    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(raw, 6))
        + chunk(b"IEND", b"")
    )


def _hash(array):
    return hashlib.sha256(np.ascontiguousarray(array, dtype=np.float32).tobytes()).hexdigest()[:16]


def main():
    out = {
        "_versions": {
            "python": sys.version.split()[0],
            "numpy": np.__version__,
            "cv2": cv2.__version__,
            "onnxruntime": ort.__version__,
        }
    }

    image = cv2.imdecode(np.frombuffer(_png(640, 480), np.uint8), cv2.IMREAD_COLOR)

    # Decode and preprocessing: these run on every photo before the models see
    # anything, so a change here moves the embeddings just as surely as a new
    # model would.
    out["decode"] = _hash(image)
    out["resize"] = _hash(cv2.resize(image, (320, 320), interpolation=cv2.INTER_LINEAR))
    out["cvtColor"] = _hash(cv2.cvtColor(image, cv2.COLOR_BGR2RGB))

    detector = cv2.FaceDetectorYN.create(
        os.path.join(MODEL_DIR, "face_detection_yunet_2023mar.onnx"), "", (320, 320)
    )
    detector.setInputSize((320, 320))
    retval, faces = detector.detect(cv2.resize(image, (320, 320)))
    out["detect_retval"] = int(retval)
    out["detect_faces"] = "none" if faces is None else _hash(faces)

    # The embedder gets a fixed tensor rather than a detected face: synthetic
    # input has no faces to find, and feeding the model directly is what
    # isolates a kernel change from a detection change.
    tensor = (np.arange(1 * 160 * 160 * 3, dtype=np.float32).reshape(1, 160, 160, 3) % 255.0) / 255.0
    session = ort.InferenceSession(
        os.path.join(MODEL_DIR, "facenet512.onnx"), providers=["CPUExecutionProvider"]
    )
    embedding = session.run(None, {session.get_inputs()[0].name: tensor})[0]
    out["embedding"] = _hash(embedding)
    out["embedding_l2"] = round(float(np.linalg.norm(embedding)), 6)

    print(json.dumps(out, indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
