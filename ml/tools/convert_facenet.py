#!/usr/bin/env python3
"""
Produce `facenet512.onnx` from deepface's published Keras weights (#1074).

Run this ONCE, by hand, on any machine. Publish the resulting file as a
release asset and pass its URL + SHA-256 to the image build. It is not part
of the Docker build for two reasons:

  1. TensorFlow is ~600MB of build dependency for a file that never ships in
     the final image.
  2. The ONNX is byte-identical regardless of the machine that produced it,
     so converting once beats converting on every architecture leg of every
     multi-arch build.

Why we redistribute at all: deepface ships FaceNet-512 under MIT, which
permits it. That was the deciding factor over the more accurate InsightFace
weights, which are non-commercial only — see ml/LICENSES.md and #1074 §1.

Usage
-----
    python -m venv .venv && . .venv/bin/activate
    pip install -r tools/requirements-convert.txt

    curl -fsSL -o facenet512_weights.h5 \\
      https://github.com/serengil/deepface_models/releases/download/v1.0/facenet512_weights.h5
    echo "3f76b5117a9ca574d536af8199e6720089eb4ad3dc7e93534496d88265de864f  facenet512_weights.h5" \\
      | sha256sum -c -

    python tools/convert_facenet.py facenet512_weights.h5 facenet512.onnx

Then verify the output before publishing:

    sha256sum facenet512.onnx
"""

import argparse
import sys
from pathlib import Path


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
    args = parser.parse_args()

    if not args.weights.is_file():
        print(f"error: {args.weights} not found", file=sys.stderr)
        return 1

    # Imported late so `--help` works without a TensorFlow install.
    import tf2onnx
    from deepface.models.facial_recognition.Facenet import InceptionResNetV1

    # Build the architecture directly and load the checksummed file from disk,
    # rather than going through deepface's loader — that one downloads the
    # weights itself, which would defeat the point of pinning them.
    print("Building InceptionResNetV1(dimension=512)…")
    model = InceptionResNetV1(dimension=512)
    model.load_weights(str(args.weights))

    # (None, 160, 160, 3) NHWC — pipeline.py reads the geometry off the model
    # rather than assuming it, but this is what it will find.
    spec = (
        __import__("tensorflow").TensorSpec(
            (None, 160, 160, 3), __import__("tensorflow").float32, name="input"
        ),
    )

    print(f"Converting to ONNX (opset {args.opset})…")
    tf2onnx.convert.from_keras(
        model, input_signature=spec, opset=args.opset, output_path=str(args.output)
    )

    size_mb = args.output.stat().st_size / (1024 * 1024)
    print(f"Wrote {args.output} ({size_mb:.1f} MB)")
    print("Publish it, then pass FACENET_ONNX_URL and FACENET_ONNX_SHA256 to the build.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
