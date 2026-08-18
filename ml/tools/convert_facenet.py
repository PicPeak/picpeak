#!/usr/bin/env python3
"""
Produce `facenet512.onnx` from deepface's published Keras weights (#1074).

Run this ONCE, by hand. Publish the resulting file as a release asset and
pass its URL + SHA-256 to the image build. It is deliberately not part of the
Docker build:

  1. TensorFlow is ~600MB of build dependency for a file that never ships in
     the final image.
  2. The result is architecture-independent, so converting once beats
     converting on both legs of every multi-arch build.

NOT byte-reproducible. Two runs on the same machine with the same pinned
versions produce functionally identical graphs — same 336 nodes, same 271
initializers, weights matching to 0.000e+00 — but a handful of initializer
names differ (tf2onnx's traced-op naming is not deterministic), so the file
bytes and therefore the SHA-256 differ. Measured, not assumed.

The consequence for anyone re-running this: **your checksum will not match
the published one, and that is expected — it is not evidence of tampering.**
The SHA-256 in the image build pins one specific published artifact so that
URL cannot start serving different bytes. To validate a fresh conversion,
rely on the parity check below (which compares against the Keras original),
not on reproducing a hash.

Why we may redistribute at all: deepface ships FaceNet-512 under MIT. That
was the deciding factor over the more accurate InsightFace weights, which are
non-commercial only — see ml/LICENSES.md and #1074 §1.

Usage
-----
    python3.11 -m venv .venv && . .venv/bin/activate   # 3.11: TF has no 3.12+ wheels
    pip install -r tools/requirements-convert.txt

    curl -fsSL -o facenet512_weights.h5 \\
      https://github.com/serengil/deepface_models/releases/download/v1.0/facenet512_weights.h5
    echo "3f76b5117a9ca574d536af8199e6720089eb4ad3dc7e93534496d88265de864f  facenet512_weights.h5" \\
      | sha256sum -c -

    python tools/convert_facenet.py facenet512_weights.h5 facenet512.onnx

The script verifies the converted graph against the Keras original before it
writes anything permanent, then prints the SHA-256 to publish alongside it.
"""

import argparse
import hashlib
import sys
from pathlib import Path

# Input geometry of deepface's FaceNet-512. pipeline.py reads this off the
# model at runtime rather than assuming it, but this is what it will find.
INPUT_SHAPE = (None, 160, 160, 3)
EMBEDDING_DIM = 512

# A converted graph that is subtly wrong still returns 512 plausible floats,
# so parity is checked rather than assumed. Tolerance is float32 noise: the
# observed worst case over random inputs was 2.1e-06 absolute, cosine
# 1.0000000000.
PARITY_SAMPLES = 3
MIN_COSINE = 0.99999


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as fh:
        for chunk in iter(lambda: fh.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("weights", type=Path, help="facenet512_weights.h5")
    parser.add_argument("output", type=Path, help="destination .onnx")
    parser.add_argument(
        "--opset",
        type=int,
        default=17,
        help="ONNX opset (default 17 — supported by onnxruntime 1.29)",
    )
    parser.add_argument(
        "--skip-verify",
        action="store_true",
        help="skip the Keras/ONNX parity check (not recommended)",
    )
    args = parser.parse_args()

    if not args.weights.is_file():
        print(f"error: {args.weights} not found", file=sys.stderr)
        return 1

    # Imported late so `--help` works without a TensorFlow install.
    import numpy as np
    import tensorflow as tf
    import tf2onnx
    from deepface.models.facial_recognition.Facenet import InceptionResNetV1

    # Build the architecture and load the checksummed file from disk rather
    # than going through deepface's own loader — that one downloads the
    # weights itself, which would defeat the point of pinning them.
    print("Building InceptionResNetV1(dimension=512)…")
    model = InceptionResNetV1(dimension=EMBEDDING_DIM)
    model.load_weights(str(args.weights))
    print(f"  {model.count_params():,} parameters")

    print(f"Converting to ONNX (opset {args.opset})…")
    spec = (tf.TensorSpec(INPUT_SHAPE, tf.float32, name="input"),)
    tf2onnx.convert.from_keras(
        model, input_signature=spec, opset=args.opset, output_path=str(args.output)
    )

    if not args.skip_verify:
        import onnxruntime as ort

        print("Verifying ONNX output matches Keras…")
        sess = ort.InferenceSession(
            str(args.output), providers=["CPUExecutionProvider"]
        )
        name = sess.get_inputs()[0].name
        rng = np.random.default_rng(0)
        worst_cosine, worst_abs = 1.0, 0.0

        for _ in range(PARITY_SAMPLES):
            x = rng.standard_normal((1, *INPUT_SHAPE[1:])).astype("float32")
            keras_out = model.predict(x, verbose=0)[0]
            onnx_out = sess.run(None, {name: x})[0][0]

            worst_abs = max(worst_abs, float(np.abs(keras_out - onnx_out).max()))
            cosine = float(
                (keras_out / np.linalg.norm(keras_out))
                @ (onnx_out / np.linalg.norm(onnx_out))
            )
            worst_cosine = min(worst_cosine, cosine)

        print(f"  worst abs diff {worst_abs:.3e}, worst cosine {worst_cosine:.10f}")
        if worst_cosine < MIN_COSINE:
            print(
                f"error: parity check FAILED (cosine {worst_cosine} < {MIN_COSINE}). "
                "The converted graph does not match the original — do not publish it.",
                file=sys.stderr,
            )
            args.output.unlink(missing_ok=True)
            return 1

    size_mb = args.output.stat().st_size / (1024 * 1024)
    print()
    print(f"Wrote {args.output} ({size_mb:.1f} MB)")
    print(f"SHA-256: {_sha256(args.output)}")
    print()
    print("Publish it as a release asset, then set the repository variables")
    print("FACENET_ONNX_URL and FACENET_ONNX_SHA256 (Settings → Variables).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
