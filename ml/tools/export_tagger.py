#!/usr/bin/env python3
"""
Produce the two scene-tagging artifacts (issue 1733):

  tag_image_encoder.onnx     the image tower of a SigLIP model, as ONNX
  tag_text_embeddings.npz    the text embeddings of app/tag_vocabulary.json

Run this by hand, like convert_facenet.py, and for the same reasons: PyTorch
and transformers are a build dependency of more than a gigabyte for two files
that are identical on every architecture.

  * Publish `tag_image_encoder.onnx` as a release asset and pass its URL and
    SHA-256 to the image build (TAG_ENCODER_ONNX_URL / TAG_ENCODER_ONNX_SHA256).
  * Commit `tag_text_embeddings.npz` to `ml/app/`. It is about 130 KB and
    belongs to the vocabulary that sits beside it.

Both come out of ONE run on purpose. The text embeddings only mean anything
against the encoder they were produced with, so the .npz records the
encoder's SHA-256 and the sidecar refuses a pair that does not match. For the
same reason, RE-RUN THIS WHENEVER A KEY OR A PROMPT in tag_vocabulary.json
changes: the .npz also records a fingerprint of the vocabulary.

Reproducibility, as measured: two runs on one machine with the versions in
requirements-export-tagger.txt and the revision recorded in LICENSES.md gave
byte-identical files both times. That is an observation about those versions
on that machine (macOS arm64), not a guarantee: after any re-run, compare the
printed encoder SHA-256 with the one in LICENSES.md. If it differs, the
committed .npz no longer matches the published encoder, and one of the two
has to be replaced.

The script checks the exported graph against the PyTorch model on random
input before it writes the embeddings (observed worst difference 8.6e-06).

Usage
-----
    python3 -m venv .venv && . .venv/bin/activate
    pip install -r tools/requirements-export-tagger.txt

    python tools/export_tagger.py \\
        --model google/siglip-base-patch16-224 \\
        --revision <commit sha of that model repository> \\
        --out-dir .

`--revision` has no default. Pin the exact commit you reviewed the licence
of, and record it in LICENSES.md together with the printed checksums. The
revision the committed embeddings were made from is recorded there.
"""

import argparse
import hashlib
import json
import sys
from pathlib import Path

ML_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ML_DIR))

# Float32 noise between PyTorch and ONNX Runtime on the same input.
PARITY_TOLERANCE = 1e-3


def _features(output):
    """Newer transformers return an output object where older ones return the tensor."""
    return output if hasattr(output, "shape") else output.pooler_output


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--model", required=True, help="Hugging Face model id (a SigLIP checkpoint)")
    parser.add_argument("--revision", required=True, help="exact commit of the model repository")
    parser.add_argument("--out-dir", default=".", type=Path)
    args = parser.parse_args()

    import numpy as np
    import onnxruntime as ort
    import torch
    from transformers import AutoModel, AutoProcessor

    from app.tagging import file_sha256, load_vocabulary, vocabulary_fingerprint

    vocabulary = load_vocabulary(str(ML_DIR / "app" / "tag_vocabulary.json"))

    model = AutoModel.from_pretrained(args.model, revision=args.revision).eval()
    processor = AutoProcessor.from_pretrained(args.model, revision=args.revision)
    if not hasattr(model, "logit_bias"):
        print("ERROR: not a SigLIP-style model (no logit_bias); the sidecar scores with a sigmoid.", file=sys.stderr)
        return 1

    image_processor = processor.image_processor
    size = image_processor.size
    side = int(size.get("height") or size.get("shortest_edge"))

    class ImageTower(torch.nn.Module):
        def __init__(self, inner):
            super().__init__()
            self.inner = inner

        def forward(self, pixel_values):
            return _features(self.inner.get_image_features(pixel_values=pixel_values))

    tower = ImageTower(model).eval()
    dummy = torch.randn(1, 3, side, side)
    encoder_path = args.out_dir / "tag_image_encoder.onnx"
    torch.onnx.export(
        tower,
        (dummy,),
        str(encoder_path),
        input_names=["pixel_values"],
        output_names=["image_embeds"],
        opset_version=18,
        # One self-contained file: the image build pins a single checksum.
        dynamo=True,
        external_data=False,
    )

    # A converted graph that is subtly wrong still returns plausible floats.
    session = ort.InferenceSession(str(encoder_path), providers=["CPUExecutionProvider"])
    worst = 0.0
    for _ in range(4):
        probe = torch.randn(1, 3, side, side)
        with torch.no_grad():
            expected = tower(probe).numpy()
        actual = session.run(None, {"pixel_values": probe.numpy()})[0]
        worst = max(worst, float(np.abs(expected - actual).max()))
    print(f"parity: worst absolute difference {worst:.2e}")
    if worst > PARITY_TOLERANCE:
        print("ERROR: the ONNX encoder does not reproduce the PyTorch model.", file=sys.stderr)
        encoder_path.unlink()
        return 1

    # SigLIP was trained with prompts padded to the full context length;
    # padding="longest" gives measurably different embeddings.
    tokens = processor.tokenizer(
        [t["prompt"] for t in vocabulary], padding="max_length", truncation=True, return_tensors="pt"
    )
    with torch.no_grad():
        text = _features(model.get_text_features(**tokens))
        text = text / text.norm(dim=-1, keepdim=True)

    meta = {
        "model": f"{args.model.split('/')[-1]}@{args.revision[:12]}",
        "encoder_sha256": file_sha256(str(encoder_path)),
        "vocabulary_sha256": vocabulary_fingerprint(vocabulary),
        "logit_scale": float(model.logit_scale.exp().item()),
        "logit_bias": float(model.logit_bias.item()),
        "mean": [float(v) for v in image_processor.image_mean],
        "std": [float(v) for v in image_processor.image_std],
    }
    embeddings_path = args.out_dir / "tag_text_embeddings.npz"
    np.savez(
        embeddings_path,
        meta=np.array(json.dumps(meta)),
        keys=np.array([t["key"] for t in vocabulary]),
        embeddings=text.numpy().astype(np.float32),
    )

    print(f"wrote {encoder_path} ({encoder_path.stat().st_size / 1e6:.1f} MB)")
    print(f"  sha256 {meta['encoder_sha256']}")
    print(f"wrote {embeddings_path} ({len(vocabulary)} tags, dim {text.shape[-1]})")
    print(f"  sha256 {hashlib.sha256(embeddings_path.read_bytes()).hexdigest()}")
    print(f"input {side}x{side}, logit_scale {meta['logit_scale']:.4f}, logit_bias {meta['logit_bias']:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
