"""
Phase 0 spike (#1074): does our pipeline separate different people?

Runs LFW's standard 1000-pair test protocol (500 same, 500 different) through
the PRODUCTION FacePipeline — YuNet detection, our Umeyama alignment, our
per-image standardization, FaceNet-512 ONNX — and reports the cosine
distribution, the best threshold, and the error rates that matter for
CLUSTERING specifically.

Clustering is not verification. For verification a false accept and a false
reject cost the same. For clustering they do not: a false merge puts a
stranger into someone's "download my photos", while a false split just makes
a duplicate row in the strip that the photographer can merge away. So the
operating point is chosen to hold false merges low, not to maximise accuracy.
"""
import os
import sys
import numpy as np
import cv2

# Run from the ml/ directory with FACE_MODEL_DIR pointing at a directory
# holding face_detection_yunet_2023mar.onnx and facenet512.onnx:
#
#   pip install -r requirements.txt scikit-learn
#   FACE_MODEL_DIR=/path/to/models python tools/benchmark_threshold.py
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
os.environ.setdefault('FACE_MODEL_DIR', '/models')

from app.pipeline import FacePipeline  # noqa: E402
from sklearn.datasets import fetch_lfw_pairs  # noqa: E402

print('Loading LFW test pairs…')
data = fetch_lfw_pairs(subset='test', color=True, resize=1.0,
                       slice_=(slice(0, 250), slice(0, 250)), funneled=True)
pairs, labels = data.pairs, data.target

print('Loading pipeline…')
pipe = FacePipeline()

def embed(arr):
    """sklearn hands back float32 RGB normalized to [0, 1] — NOT 0..255.
    Casting straight to uint8 produces a black frame and zero detections."""
    rgb8 = np.clip(arr * 255.0, 0, 255).astype(np.uint8)
    bgr = cv2.cvtColor(rgb8, cv2.COLOR_RGB2BGR)
    ok, buf = cv2.imencode('.jpg', bgr, [cv2.IMWRITE_JPEG_QUALITY, 95])
    if not ok:
        return None
    faces = pipe.process(buf.tobytes())
    if not faces:
        return None
    # Largest detection — LFW is one centred subject per frame.
    best = max(faces, key=lambda f: f['bbox'][2] * f['bbox'][3])
    return np.asarray(best['embedding'], dtype=np.float32)

sims, kept, missed = [], [], 0
for i, (a, b) in enumerate(pairs):
    ea, eb = embed(a), embed(b)
    if ea is None or eb is None:
        missed += 1
        continue
    sims.append(float(ea @ eb))
    kept.append(int(labels[i]))
    if (i + 1) % 100 == 0:
        print(f'  {i+1}/{len(pairs)}…', flush=True)

sims = np.array(sims)
kept = np.array(kept)
same, diff = sims[kept == 1], sims[kept == 0]

print()
print('=' * 66)
print(f'Pairs evaluated : {len(sims)} of {len(pairs)}  '
      f'({missed} skipped — no face detected in one or both)')
print(f'Detection rate  : {1 - missed/len(pairs):.1%}')
print()
print(f'SAME person  cosine: mean {same.mean():.4f}  sd {same.std():.4f}  '
      f'p5 {np.percentile(same,5):.4f}  min {same.min():.4f}')
print(f'DIFF person  cosine: mean {diff.mean():.4f}  sd {diff.std():.4f}  '
      f'p95 {np.percentile(diff,95):.4f}  max {diff.max():.4f}')
print(f'Separation (mean gap): {same.mean() - diff.mean():.4f}')

# Sweep thresholds.
grid = np.linspace(0.0, 1.0, 1001)
acc = [( (same >= t).sum() + (diff < t).sum() ) / len(sims) for t in grid]
best_i = int(np.argmax(acc))
best_t, best_acc = grid[best_i], acc[best_i]

print()
print(f'Best accuracy   : {best_acc:.2%} at threshold {best_t:.3f}')

# The clustering-relevant operating points: pick the threshold where the
# false-MERGE rate (different people scored as the same) is capped.
print()
print('Operating points (false merge = different people judged the same):')
print(f'  {"thresh":>7}  {"false merge":>11}  {"false split":>11}  {"accuracy":>8}')
for target in (0.10, 0.05, 0.02, 0.01):
    t = float(np.quantile(diff, 1 - target))
    fm = (diff >= t).mean()
    fs = (same < t).mean()
    a = ((same >= t).sum() + (diff < t).sum()) / len(sims)
    print(f'  {t:7.3f}  {fm:10.1%}  {fs:10.1%}  {a:7.1%}   (target {target:.0%})')

print()
print(f'Currently seeded default: 0.620 → '
      f'false merge {(diff >= 0.62).mean():.1%}, '
      f'false split {(same < 0.62).mean():.1%}, '
      f'accuracy {(((same >= 0.62).sum() + (diff < 0.62).sum()) / len(sims)):.1%}')
print('=' * 66)

# Last run (2026-08-18), 1000/1000 pairs, 100% detection:
#   same 0.6958 +/- 0.1415 | diff 0.0849 +/- 0.1674 | separation 0.6109
#   peak accuracy 96.60% @ 0.405
#   shipped default 0.50 -> 1.0% false merge, 8.2% false split, 95.4% accuracy
