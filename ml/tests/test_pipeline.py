"""
Unit tests for the parts of the pipeline that don't need model weights.

The pose and blur helpers are pure functions over landmark geometry, and the
landmark ORDER assumption is the one thing in this service that fails
silently if it's wrong — a shuffled template still produces 512 confident
floats, just from a face warped inside out. So it gets pinned here.
"""

import numpy as np
import pytest

from app.pipeline import (
    _TEMPLATE_112,
    _blur_score,
    _pose_from_landmarks,
    _umeyama,
)


def _frontal_landmarks() -> np.ndarray:
    """A synthetic, perfectly frontal face in YuNet's landmark order.

    Order: subject's right eye, left eye, nose, right mouth, left mouth.
    The subject's right eye appears on the IMAGE-left, so it carries the
    smaller x — the same convention `_TEMPLATE_112` encodes.
    """
    return np.array(
        [
            [40.0, 50.0],  # right eye (image-left)
            [80.0, 50.0],  # left eye
            [60.0, 70.0],  # nose, centred between the eyes
            [45.0, 92.0],  # right mouth
            [75.0, 92.0],  # left mouth
        ],
        dtype=np.float32,
    )


class TestTemplate:
    def test_landmark_order_is_left_to_right_for_paired_features(self):
        # Eyes: index 0 must sit left of index 1. Mouth corners: 3 left of 4.
        assert _TEMPLATE_112[0][0] < _TEMPLATE_112[1][0]
        assert _TEMPLATE_112[3][0] < _TEMPLATE_112[4][0]

    def test_nose_sits_between_the_eyes_horizontally(self):
        assert _TEMPLATE_112[0][0] < _TEMPLATE_112[2][0] < _TEMPLATE_112[1][0]

    def test_features_are_vertically_ordered_eyes_nose_mouth(self):
        eye_y = (_TEMPLATE_112[0][1] + _TEMPLATE_112[1][1]) / 2
        mouth_y = (_TEMPLATE_112[3][1] + _TEMPLATE_112[4][1]) / 2
        assert eye_y < _TEMPLATE_112[2][1] < mouth_y


class TestUmeyama:
    """The alignment estimator. Every test here is a regression guard.

    An estimator that fits three of the five landmarks perfectly and lets the
    mouth drift still produces a face-shaped crop and 512 confident floats —
    it just degrades every embedding. That is why this is pinned numerically
    rather than eyeballed.
    """

    def test_recovers_a_known_similarity_transform_exactly(self):
        src = _frontal_landmarks()
        angle = np.radians(20.0)
        rot = np.array(
            [[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]]
        )
        dst = (2.5 * (src @ rot.T)) + np.array([17.0, -9.0])

        m = _umeyama(src, dst.astype(np.float32))
        projected = (src @ m[:, :2].T) + m[:, 2]
        assert np.allclose(projected, dst, atol=1e-3)

    def test_distributes_residual_across_all_five_points(self):
        # A face whose eye-to-mouth proportion differs from the template —
        # no similarity transform can satisfy all five, so the question is
        # how the error is spread. An outlier-rejecting estimator (RANSAC,
        # LMEDS) parks it all on the mouth; least squares shares it out.
        src = _frontal_landmarks()
        src[3][1] = 110.0  # mouth further from the eyes than the template
        src[4][1] = 110.0

        m = _umeyama(src, _TEMPLATE_112)
        residual = np.linalg.norm((src @ m[:, :2].T) + m[:, 2] - _TEMPLATE_112, axis=1)

        assert residual.max() > 0, "expected an imperfect fit for this input"
        # No single point may absorb the bulk of the error.
        assert residual.max() < 3.0 * residual.mean()

    def test_never_returns_a_reflection(self):
        # A mirrored warp yields a confident embedding of a face that does
        # not exist, which would cluster as a separate person.
        m = _umeyama(_frontal_landmarks(), _TEMPLATE_112)
        assert np.linalg.det(m[:, :2]) > 0

    def test_is_deterministic(self):
        # Re-scans must not churn clusters.
        src = _frontal_landmarks()
        first = _umeyama(src, _TEMPLATE_112)
        for _ in range(5):
            assert np.array_equal(_umeyama(src, _TEMPLATE_112), first)

    def test_coincident_points_return_none_rather_than_dividing_by_zero(self):
        assert _umeyama(np.zeros((5, 2), dtype=np.float32), _TEMPLATE_112) is None


class TestPose:
    def test_frontal_face_is_near_zero_yaw(self):
        yaw, _ = _pose_from_landmarks(_frontal_landmarks())
        assert abs(yaw) < 1.0

    def test_nose_toward_subject_left_eye_gives_positive_yaw(self):
        lm = _frontal_landmarks()
        lm[2][0] = 75.0  # nose slides toward the image-right (subject's left)
        yaw, _ = _pose_from_landmarks(lm)
        assert yaw > 10.0

    def test_nose_toward_subject_right_eye_gives_negative_yaw(self):
        lm = _frontal_landmarks()
        lm[2][0] = 45.0
        yaw, _ = _pose_from_landmarks(lm)
        assert yaw < -10.0

    def test_yaw_is_scale_invariant(self):
        lm = _frontal_landmarks()
        lm[2][0] = 72.0
        small, _ = _pose_from_landmarks(lm)
        large, _ = _pose_from_landmarks(lm * 4.0)
        assert small == pytest.approx(large, abs=0.01)

    def test_nose_low_on_the_eye_mouth_axis_reads_as_looking_down(self):
        lm = _frontal_landmarks()
        lm[2][1] = 85.0  # nose drops toward the mouth
        _, pitch = _pose_from_landmarks(lm)
        assert pitch < 0

    def test_degenerate_landmarks_do_not_raise(self):
        flat = np.zeros((5, 2), dtype=np.float32)
        assert _pose_from_landmarks(flat) == (0.0, 0.0)


class TestBlur:
    def test_flat_image_scores_near_zero(self):
        flat = np.full((160, 160, 3), 128, dtype=np.uint8)
        assert _blur_score(flat) < 1.0

    def test_sharp_edges_score_higher_than_a_blurred_copy(self):
        import cv2

        sharp = np.zeros((160, 160, 3), dtype=np.uint8)
        sharp[:, ::8] = 255  # high-frequency vertical stripes
        blurred = cv2.GaussianBlur(sharp, (15, 15), 0)

        assert _blur_score(sharp) > _blur_score(blurred)
