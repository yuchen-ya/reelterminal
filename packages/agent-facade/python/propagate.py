"""Short-range masked patch propagation using conservative LK similarity tracking.

The patch and grayscale mask are aligned to the first decoded source frame.
This worker estimates one cumulative similarity transform from that frame to
each following frame. It never re-seeds after a loss. At the first unreliable
step, that frame and every later frame are copied from the original and marked
needsRepair in the response. It does not write video or project state.

Request/response use one JSON document on stdin/stdout, matching the other
OpenCV workers. Paths are supplied by the trusted facade after containment
checks; arbitrary tracking JSON is deliberately not accepted.
"""

import json
import math
import os
import shutil
import sys

import cv2
import numpy as np

LK_PARAMS = dict(
    winSize=(21, 21),
    maxLevel=3,
    criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01),
)
RANSAC_THRESHOLD_PX = 2.0
MAX_PIXELS = 16_000_000
MAX_DIMENSION = 4096


def emit_ok(result):
    json.dump({"ok": True, "result": result}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def fail(code, message):
    json.dump({"ok": False, "error": {"code": code, "message": message}}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def read_image(path, flags):
    raw = cv2.imdecode(np.fromfile(path, dtype=np.uint8), flags)
    if raw is None:
        raise ValueError(f"cannot decode PNG: {path}")
    return raw


def frame_path(frames_dir, index):
    return os.path.join(frames_dir, f"f{int(index):06d}.png")


def transform_points(points, matrix):
    return cv2.transform(np.asarray(points, dtype=np.float64), matrix)[0]


def corners_in_mask(gray, alpha, min_features):
    # Seed only inside pixels which will actually receive the patch. Eroding
    # the binary support avoids unstable corners on a feathered mask boundary.
    binary = np.where(alpha >= 0.40, 255, 0).astype(np.uint8)
    if min(binary.shape) >= 3:
        binary = cv2.erode(binary, np.ones((3, 3), np.uint8), iterations=1)
    corners = cv2.goodFeaturesToTrack(
        gray,
        maxCorners=600,
        qualityLevel=0.005,
        minDistance=3,
        blockSize=7,
        mask=binary,
    )
    if corners is None or len(corners) < min_features:
        return None, 0
    return corners.astype(np.float32), len(corners)


def mask_bounds(alpha):
    ys, xs = np.nonzero(alpha > 1e-5)
    if len(xs) == 0:
        return None
    return {
        "x": int(xs.min()),
        "y": int(ys.min()),
        "width": int(xs.max() - xs.min() + 1),
        "height": int(ys.max() - ys.min() + 1),
    }


def warp_patch(premultiplied_bgr, source_alpha, matrix, width, height):
    # Warp premultiplied colors and alpha separately. Dividing after warp
    # avoids dark fringes where transparent pixels surround painted pixels.
    flags = cv2.INTER_LINEAR
    warped_alpha = cv2.warpAffine(
        source_alpha, matrix[:2], (width, height), flags=flags,
        borderMode=cv2.BORDER_CONSTANT, borderValue=0,
    )
    warped_premul = cv2.warpAffine(
        premultiplied_bgr, matrix[:2], (width, height), flags=flags,
        borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0),
    )
    return warped_premul, np.clip(warped_alpha, 0.0, 1.0)


def composite(original_bgr, premultiplied, alpha):
    base = original_bgr.astype(np.float32) / 255.0
    result = premultiplied + base * (1.0 - alpha[:, :, None])
    return np.clip(np.rint(result * 255.0), 0, 255).astype(np.uint8)


def verify_outside_mask(original_bgr, output_bgr, alpha):
    outside = alpha <= 0.0
    return int(np.count_nonzero(np.any(original_bgr[outside] != output_bgr[outside], axis=1)))


def scene_change_measure(previous_gray, current_gray):
    """Conservative global change gate for obvious cuts and full-frame flashes.

    This is a candidate detector, not a cut classifier: it may stop on rapid
    full-frame motion or a flash and cannot identify every subtle cut.
    """
    previous_small = cv2.resize(previous_gray, (64, 36), interpolation=cv2.INTER_AREA)
    current_small = cv2.resize(current_gray, (64, 36), interpolation=cv2.INTER_AREA)
    delta = cv2.absdiff(previous_small, current_small).astype(np.float32) / 255.0
    mean_sad = float(delta.mean())
    tile_means = delta.reshape(6, 6, 8, 8).mean(axis=(1, 3))
    changed_tile_fraction = float(np.count_nonzero(tile_means > 0.18) / tile_means.size)
    previous_hist = cv2.calcHist([previous_small], [0], None, [32], [0, 256])
    current_hist = cv2.calcHist([current_small], [0], None, [32], [0, 256])
    cv2.normalize(previous_hist, previous_hist, alpha=1.0, norm_type=cv2.NORM_L1)
    cv2.normalize(current_hist, current_hist, alpha=1.0, norm_type=cv2.NORM_L1)
    histogram_distance = float(cv2.compareHist(previous_hist, current_hist, cv2.HISTCMP_BHATTACHARYYA))
    suspected = (mean_sad >= 0.29 or
                 (mean_sad >= 0.18 and changed_tile_fraction >= 0.50) or
                 histogram_distance >= 0.62)
    return {
        "meanLumaSad": round(mean_sad, 5),
        "changedTileFraction": round(changed_tile_fraction, 5),
        "grayHistogramBhattacharyya": round(histogram_distance, 5),
        "suspectedSceneChange": bool(suspected),
    }


def local_appearance_measure(previous_gray, current_gray, step_matrix, cumulative_candidate,
                             source_alpha, width, height):
    """Reject visible local appearance changes that could be an occlusion.

    The prior frame is warped by the fitted step, then compared only within
    the eroded propagated mask. This errs toward stopping on animation or
    lighting changes: it is a safety gate, not a semantic occlusion detector.
    """
    previous_warped = cv2.warpAffine(
        previous_gray, step_matrix[:2], (width, height), flags=cv2.INTER_LINEAR,
        borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    support = cv2.warpAffine(
        np.where(source_alpha >= 0.4, 255, 0).astype(np.uint8),
        cumulative_candidate[:2], (width, height), flags=cv2.INTER_NEAREST,
        borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    if min(width, height) >= 5:
        support = cv2.erode(support, np.ones((5, 5), np.uint8), iterations=1)
    valid = support > 0
    if int(np.count_nonzero(valid)) < 16:
        return {"sampledPixels": int(np.count_nonzero(valid)), "suspectedOcclusionOrAppearanceChange": True}
    difference = cv2.absdiff(previous_warped, current_gray)[valid].astype(np.float32) / 255.0
    mean_sad = float(difference.mean())
    changed_fraction = float(np.count_nonzero(difference >= (32.0 / 255.0)) / len(difference))
    return {
        "sampledPixels": int(len(difference)),
        "meanGraySad": round(mean_sad, 5),
        "pixelsChangedByAtLeast32Fraction": round(changed_fraction, 5),
        "suspectedOcclusionOrAppearanceChange": bool(mean_sad >= 0.14 or changed_fraction >= 0.24),
    }


def draw_overlay(bgr, alpha, frame_index, status, reason_code=None):
    overlay = bgr.copy()
    binary = np.where(alpha > 0.02, 255, 0).astype(np.uint8)
    contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    color = (0, 210, 80) if status == "patched" else (0, 30, 255)
    if contours:
        cv2.drawContours(overlay, contours, -1, color, 2)
    label = f"f{frame_index:06d} {status}"
    if reason_code:
        label += f" {reason_code}"
    cv2.putText(overlay, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX,
                0.55, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(overlay, label, (8, 22), cv2.FONT_HERSHEY_SIMPLEX,
                0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return overlay


def write_png(path, bgr):
    ok, encoded = cv2.imencode(".png", bgr)
    if not ok:
        raise OSError(f"could not encode PNG: {path}")
    encoded.tofile(path)


def select_overlay_positions(frame_count, overlay_limit, failure_position=None):
    """Choose bounded review samples, anchoring endpoints and the loss frame."""
    limit = min(frame_count, overlay_limit)
    if limit <= 1:
        return [0] if frame_count else []

    selected = {0, frame_count - 1}
    if failure_position is not None and len(selected) < limit:
        selected.add(int(failure_position))

    while len(selected) < limit:
        ordered = sorted(selected)
        gaps = [(right - left, left, right) for left, right in zip(ordered, ordered[1:]) if right - left > 1]
        if not gaps:
            break
        _, left, right = max(gaps, key=lambda gap: (gap[0], -gap[1]))
        selected.add((left + right) // 2)
    return sorted(selected)


def main():
    try:
        request = json.load(sys.stdin)
        frames_dir = request["framesDir"]
        frame_indices = [int(index) for index in request["frameIndices"]]
        patch_path = request["patchPath"]
        mask_path = request["maskPath"]
        output_dir = request["outputDir"]
        overlay_dir = request["overlayDir"]
        options = request.get("options", {})
        max_fb_error = float(options.get("maxForwardBackwardError", 2.0))
        min_inliers = int(options.get("minInliers", 4))
        min_retention = float(options.get("minTrackRetention", 0.55))
        overlay_count = int(options.get("overlayCount", 12))
    except (KeyError, TypeError, ValueError) as exc:
        return fail("bad_request", f"missing or invalid request field: {exc}")

    if len(frame_indices) < 2 or len(frame_indices) > 120:
        return fail("bad_request", "frameIndices must contain 2..120 frames")
    if any(frame_indices[i] + 1 != frame_indices[i + 1] for i in range(len(frame_indices) - 1)):
        return fail("bad_request", "frameIndices must be a contiguous ascending decode range")
    if not (0 < max_fb_error <= 20 and 4 <= min_inliers <= 50 and
            0.25 <= min_retention <= 1.0 and 1 <= overlay_count <= 16):
        return fail("bad_request", "tracking options are outside supported bounds")

    try:
        first_bgr = read_image(frame_path(frames_dir, frame_indices[0]), cv2.IMREAD_COLOR)
        height, width = first_bgr.shape[:2]
        if width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_PIXELS:
            return fail("unsupported_raster", f"decoded raster {width}x{height} exceeds worker limits")

        patch = read_image(patch_path, cv2.IMREAD_UNCHANGED)
        mask_image = read_image(mask_path, cv2.IMREAD_UNCHANGED)
        if patch.shape[:2] != (height, width) or mask_image.shape[:2] != (height, width):
            return fail("size_mismatch", "patch and grayscale mask must match the first decoded frame raster")
        if patch.dtype != np.uint8 or mask_image.dtype != np.uint8:
            return fail("unsupported_bit_depth", "patch and grayscale mask must be 8-bit PNGs")
        if len(mask_image.shape) != 2:
            return fail("mask_not_grayscale", "mask must be an 8-bit grayscale PNG")
        mask_gray = mask_image
        alpha_mask = mask_gray.astype(np.float32) / 255.0
        if not np.any(alpha_mask > 0):
            return fail("empty_mask", "mask must contain at least one non-zero pixel")

        if len(patch.shape) == 2:
            patch_bgr = cv2.cvtColor(patch, cv2.COLOR_GRAY2BGR)
            patch_alpha = np.ones((height, width), dtype=np.float32)
        elif patch.shape[2] == 4:
            patch_bgr = patch[:, :, :3]
            patch_alpha = patch[:, :, 3].astype(np.float32) / 255.0
        elif patch.shape[2] == 3:
            patch_bgr = patch
            patch_alpha = np.ones((height, width), dtype=np.float32)
        else:
            return fail("bad_patch", "patch PNG must be grayscale, RGB or RGBA")
        source_alpha = np.clip(alpha_mask * patch_alpha, 0.0, 1.0)
        source_premul = patch_bgr.astype(np.float32) / 255.0 * source_alpha[:, :, None]
        if not np.any(source_alpha > 0):
            return fail("empty_patch", "patch alpha and mask do not overlap")

        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(overlay_dir, exist_ok=True)
        gray = cv2.cvtColor(first_bgr, cv2.COLOR_BGR2GRAY)
        points, seed_count = corners_in_mask(gray, source_alpha, min_inliers)
        cumulative = np.eye(3, dtype=np.float64)
        frames_out = []
        termination = None
        previous_gray = gray
        previous_points = points
        overlays = []

        for position, frame_index in enumerate(frame_indices):
            current_bgr = first_bgr if position == 0 else read_image(
                frame_path(frames_dir, frame_index), cv2.IMREAD_COLOR)
            if current_bgr.shape[:2] != (height, width):
                return fail("raster_changed", f"decoded source raster changed at frame {frame_index}; refusing a mixed-size candidate range")

            status = "patched"
            reason_code = None
            frame_details = {
                "frame": frame_index,
                "status": "patched",
                "matrix3x3": [float(v) for v in cumulative.ravel()],
                "trackedPointCount": seed_count if position == 0 else 0,
                "inlierCount": seed_count if position == 0 else 0,
                "medianForwardBackwardErrorPx": 0.0 if position == 0 else None,
                "inlierRmsePx": 0.0 if position == 0 else None,
            }

            if termination is None and position > 0:
                current_gray = cv2.cvtColor(current_bgr, cv2.COLOR_BGR2GRAY)
                scene_change = scene_change_measure(previous_gray, current_gray)
                frame_details["sceneChange"] = scene_change
                if scene_change["suspectedSceneChange"]:
                    termination = {
                        "atFrame": frame_index,
                        "reasonCode": "scene_change_suspected",
                        "reason": ("the low-resolution whole-frame luma change exceeds the conservative cut/flash gate "
                                   f"(mean SAD {scene_change['meanLumaSad']}, changed tiles "
                                   f"{scene_change['changedTileFraction']}, histogram distance "
                                   f"{scene_change['grayHistogramBhattacharyya']})"),
                    }
                elif previous_points is None:
                    termination = {"atFrame": frame_index, "reasonCode": "insufficient_features",
                                   "reason": "the patch mask has too few stable image features to track"}
                else:
                    next_points, forward_status, _ = cv2.calcOpticalFlowPyrLK(
                        previous_gray, current_gray, previous_points, None, **LK_PARAMS)
                    if next_points is None or forward_status is None:
                        termination = {"atFrame": frame_index, "reasonCode": "lk_failed",
                                       "reason": "Lucas–Kanade returned no point correspondences"}
                    else:
                        back_points, back_status, _ = cv2.calcOpticalFlowPyrLK(
                            current_gray, previous_gray, next_points, None, **LK_PARAMS)
                        if back_points is None or back_status is None:
                            termination = {"atFrame": frame_index, "reasonCode": "lk_failed",
                                           "reason": "backward Lucas–Kanade returned no point correspondences"}
                        else:
                            fb_errors = np.linalg.norm(previous_points[:, 0] - back_points[:, 0], axis=1)
                            valid = ((forward_status.ravel() == 1) & (back_status.ravel() == 1) &
                                     np.isfinite(fb_errors) & (fb_errors <= max_fb_error))
                            good_previous = previous_points[valid]
                            good_next = next_points[valid]
                            valid_count = int(np.count_nonzero(valid))
                            median_fb = float(np.median(fb_errors[valid])) if valid_count else None
                            required_retained = max(min_inliers, int(math.ceil(seed_count * min_retention)))
                            if valid_count < required_retained:
                                termination = {
                                    "atFrame": frame_index,
                                    "reasonCode": "correspondence_loss",
                                    "reason": (f"only {valid_count} of {seed_count} seed features survived forward/backward checks; "
                                               "possible occlusion, cut or motion blur"),
                                }
                            else:
                                step, inliers = cv2.estimateAffinePartial2D(
                                    good_previous, good_next,
                                    method=cv2.RANSAC,
                                    ransacReprojThreshold=RANSAC_THRESHOLD_PX,
                                    maxIters=5000,
                                    confidence=0.995,
                                )
                                inlier_count = 0 if inliers is None else int(np.count_nonzero(inliers))
                                if step is None or inlier_count < required_retained or inlier_count / max(valid_count, 1) < 0.55:
                                    termination = {
                                        "atFrame": frame_index,
                                        "reasonCode": "inconsistent_similarity",
                                        "reason": (f"similarity fit retained {inlier_count} of {valid_count} correspondences; "
                                                   "possible occlusion, cut or non-rigid motion"),
                                    }
                                else:
                                    inlier_mask = inliers.ravel().astype(bool)
                                    projected = cv2.transform(good_previous[inlier_mask], step.astype(np.float64))[:, 0]
                                    residuals = np.linalg.norm(projected - good_next[inlier_mask][:, 0], axis=1)
                                    rmse = float(np.sqrt(np.mean(residuals ** 2)))
                                    if not np.isfinite(rmse) or rmse > 2.5:
                                        termination = {
                                            "atFrame": frame_index,
                                            "reasonCode": "weak_similarity_fit",
                                            "reason": f"similarity reprojection RMSE {rmse:.2f}px exceeds 2.5px",
                                        }
                                    else:
                                        step3 = np.vstack([step, [0.0, 0.0, 1.0]])
                                        candidate_cumulative = step3 @ cumulative
                                        appearance = local_appearance_measure(
                                            previous_gray, current_gray, step3,
                                            candidate_cumulative, source_alpha, width, height)
                                        frame_details["localAppearance"] = appearance
                                        if appearance["suspectedOcclusionOrAppearanceChange"]:
                                            termination = {
                                                "atFrame": frame_index,
                                                "reasonCode": "occlusion_or_appearance_change_suspected",
                                                "reason": ("the prior frame no longer matches inside the propagated mask after alignment "
                                                           f"(mean SAD {appearance.get('meanGraySad')}, changed fraction "
                                                           f"{appearance.get('pixelsChangedByAtLeast32Fraction')})"),
                                            }
                                        else:
                                            cumulative = candidate_cumulative
                                            warped_probe = cv2.warpAffine(
                                                source_alpha, cumulative[:2], (width, height),
                                                flags=cv2.INTER_NEAREST,
                                                borderMode=cv2.BORDER_CONSTANT, borderValue=0)
                                            covered = float(np.count_nonzero(warped_probe > 0.1))
                                            total = float(np.count_nonzero(source_alpha > 0.1))
                                            if total == 0 or covered / total < 0.80:
                                                termination = {
                                                    "atFrame": frame_index,
                                                    "reasonCode": "mask_out_of_bounds",
                                                    "reason": "less than 80% of the transformed patch mask remains inside the frame",
                                                }
                                            else:
                                                previous_points = good_next[inlier_mask].reshape(-1, 1, 2)
                                                frame_details.update({
                                                    "matrix3x3": [float(v) for v in cumulative.ravel()],
                                                    "trackedPointCount": valid_count,
                                                    "inlierCount": inlier_count,
                                                    "medianForwardBackwardErrorPx": round(median_fb, 4) if median_fb is not None else None,
                                                    "inlierRmsePx": round(rmse, 4),
                                                })
                                                previous_gray = current_gray

            if termination is not None and frame_index >= termination["atFrame"]:
                status = "needsRepair"
                reason_code = termination["reasonCode"] if frame_index == termination["atFrame"] else "stopped_after_loss"
                frame_details.update({
                    "status": "needsRepair",
                    "matrix3x3": None,
                    "trackedPointCount": 0,
                    "inlierCount": 0,
                    "reasonCode": reason_code,
                    "reason": termination["reason"] if frame_index == termination["atFrame"] else "propagation stopped at the first unreliable frame",
                })
                output_bgr = current_bgr
                output_alpha = np.zeros((height, width), dtype=np.float32)
            else:
                warped_premul, warped_alpha = warp_patch(source_premul, source_alpha, cumulative, width, height)
                output_bgr = composite(current_bgr, warped_premul, warped_alpha)
                outside_changes = verify_outside_mask(current_bgr, output_bgr, warped_alpha)
                if outside_changes:
                    return fail("outside_mask_changed", f"frame {frame_index} changed {outside_changes} pixels outside the transformed mask")
                output_alpha = warped_alpha
                frame_details["effectiveMaskBounds"] = mask_bounds(warped_alpha)
                frame_details["outsideMaskDifferingPixels"] = outside_changes
                frame_details["status"] = "patched"

            final_path = os.path.join(output_dir, f"f{frame_index:06d}.png")
            if status == "needsRepair":
                shutil.copyfile(frame_path(frames_dir, frame_index), final_path)
            else:
                write_png(final_path, output_bgr)
            frame_details["path"] = final_path
            frames_out.append(frame_details)

        failure_position = None if termination is None else termination["atFrame"] - frame_indices[0]
        overlay_positions = select_overlay_positions(len(frame_indices), overlay_count, failure_position)
        for position in overlay_positions:
            row = frames_out[position]
            frame_index = frame_indices[position]
            source_output = read_image(row["path"], cv2.IMREAD_COLOR)
            status = row["status"]
            if status == "patched":
                matrix = np.asarray(row["matrix3x3"], dtype=np.float64).reshape(3, 3)
                _, overlay_alpha = warp_patch(source_premul, source_alpha, matrix, width, height)
            else:
                overlay_alpha = np.zeros((height, width), dtype=np.float32)
            overlay_path = os.path.join(overlay_dir, f"overlay-f{frame_index:06d}.png")
            write_png(overlay_path, draw_overlay(
                source_output, overlay_alpha, frame_index, status, row.get("reasonCode")))
            overlays.append({"frame": frame_index, "path": overlay_path, "status": status})

        result = {
            "status": "needsRepair" if termination is not None else "propagated",
            "raster": {"width": width, "height": height},
            "range": {"startFrame": frame_indices[0], "endFrame": frame_indices[-1] + 1, "halfOpen": True},
            "algorithm": "LK sparse optical flow + forward/backward checks + RANSAC similarity (estimateAffinePartial2D)",
            "matrixDirection": "first-frame->current-frame",
            "coordinateSpace": "decoded-source-frame-raster pixels, origin top-left",
            "maskBounds": mask_bounds(source_alpha),
            "seedPointCount": seed_count,
            "parameters": {
                "maxForwardBackwardErrorPx": max_fb_error,
                "minInliers": min_inliers,
                "minTrackRetention": min_retention,
                "ransacReprojThresholdPx": RANSAC_THRESHOLD_PX,
                "minimumSimilarityInlierRatio": 0.55,
                "maximumSimilarityRmsePx": 2.5,
                "minimumMaskVisibleFraction": 0.80,
                "overlayCount": overlay_count,
                "overlaySelectionStrategy": "unique frames; first and last are anchors when limit>=2; the first unreliable frame is added when a slot remains; remaining slots bisect the largest time gaps",
                "localAppearanceGate": {
                    "meanGraySadThreshold": 0.14,
                    "pixelDifferenceThreshold": 32,
                    "changedPixelFractionThreshold": 0.24,
                    "semantics": "conservative suspected occlusion or appearance-change candidate detector",
                },
                "sceneChangeGate": {
                    "sampleRaster": "64x36 grayscale",
                    "meanLumaSadThreshold": 0.29,
                    "tileSadThreshold": 0.18,
                    "changedTileFractionThreshold": 0.50,
                    "grayHistogramBhattacharyyaThreshold": 0.62,
                    "semantics": "conservative suspected-cut/full-frame-flash candidate detector; not a universal cut classifier",
                },
            },
            "termination": termination,
            "frames": frames_out,
            "overlays": overlays,
            "limitations": [
                "The patch and mask are aligned to the first decoded source frame; one cumulative similarity transform maps them to following frames.",
                "This is rigid similarity-based propagation, not dense/non-rigid optical-flow warping. It cannot preserve changing shape or reveal pixels hidden by occlusion.",
                "At the first weak correspondence, local appearance change, suspected whole-frame cut/flash, fit failure, or mask leaving the raster, that frame and all later frames remain original and are marked needsRepair; tracking is never restarted.",
                "Candidate PNG frames and review overlays only. No video encoding, timeline edit, or project state change occurs.",
                "The whole-frame cut and local occlusion/appearance gates are conservative image-change candidates; they can stop on legitimate animation/lighting changes and cannot identify every subtle partial occlusion. Inspect the supplied overlays before adoption.",
                "Review overlays are unique and never exceed overlayCount. With a limit of at least two the first and last frames are anchors; with at least three, an internal first-loss frame takes a slot before evenly spaced samples. A limit of one can show only the first frame; a limit of two may omit an internal loss frame.",
            ],
        }
        return emit_ok(result)
    except (OSError, ValueError, cv2.error) as exc:
        return fail("worker_failed", f"patch propagation failed: {exc}")


if __name__ == "__main__":
    sys.exit(main())
