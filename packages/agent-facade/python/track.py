"""motion.track worker: follow a user-drawn region through an exact PNG
frame sequence with sparse Lucas–Kanade optical flow + forward-backward
checking + RANSAC similarity estimation.

Request (JSON on stdin):
{
  "framesDir": "<path>",            # holds f%06d.png named by frame index
  "frameIndices": [10, 11, ...],    # ascending zero-based decode indices
  "region": {"x","y","width","height"},   # source-raster pixels at frameIndices[0]
  "gridStep": int | null,           # seed grid spacing px (default from region size)
  "maxForwardBackwardError": float, # px, default 2.0
  "minInliers": int,                # default 6
  "overlayDir": "<path>",           # where overlay PNGs are written
  "overlayCount": int               # max overlays (default 12, cap 16)
}

Response (JSON on stdout): {"ok": true, "result": {...}}.

Behavior contract (mirrors the facade verb's disclosures):
- The FIRST frame defines the region; its matrix is the identity.
- Each step tracks the SAME seed-point set; points that fail the
  forward-backward check drop out and are never re-seeded, so the tracked
  count shrinks monotonically and drift stays visible in the stats.
- A step fails the whole run (forward-backward collapse, too few RANSAC
  inliers, region leaving the raster): the failing frame is marked "lost"
  with a reason, every later frame is "not_tracked" with null matrices, and
  termination carries atFrame + reason. The tracker NEVER re-seeds across a
  loss and NEVER continues emitting plausible-looking matrices.
- All coordinates are source-raster pixels (origin top-left) of the PNG
  frames as decoded — the caller extracts them and owns PTS mapping.
"""

import json
import os
import sys

import cv2
import numpy as np

LK_PARAMS = dict(winSize=(21, 21), maxLevel=3,
                 criteria=(cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, 30, 0.01))
RANSAC_THRESHOLD_PX = 2.0


def emit_ok(result):
    json.dump({"ok": True, "result": result}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def fail(code, message):
    # A structured failure response is a SUCCESSFUL protocol exchange: exit 0
    # so the caller reads the JSON instead of treating the process as crashed.
    json.dump({"ok": False, "error": {"code": code, "message": message}}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def frame_path(frames_dir, index):
    return os.path.join(frames_dir, f"f{int(index):06d}.png")


def load_gray(path):
    raw = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if raw is None:
        raise ValueError(f"cannot decode frame image: {path}")
    return raw, cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)


def seed_points(gray, region, raster_w, raster_h, grid_step):
    """Seed KLT points with goodFeaturesToTrack INSIDE the region.

    Corner seeding is the classic region tracker: a uniform grid mixes
    featureless background points that "track" at zero flow and hijack the
    RANSAC model, while corners are the only points that constrain motion.
    A region with too few detectable features is a legitimate immediate
    failure (insufficient seed features), reported honestly.
    """
    x0, y0 = int(region["x"]), int(region["y"])
    x1, y1 = x0 + int(region["width"]), y0 + int(region["height"])
    x0, y0 = max(0, x0), max(0, y0)
    x1, y1 = min(raster_w, x1), min(raster_h, y1)
    if x1 - x0 < 4 or y1 - y0 < 4:
        return None, 0
    mask = np.zeros(gray.shape[:2], dtype=np.uint8)
    mask[y0:y1, x0:x1] = 255
    spacing = grid_step if grid_step else max(3, int(round(min(x1 - x0, y1 - y0) / 8.0)))
    corners = cv2.goodFeaturesToTrack(
        gray, maxCorners=400, qualityLevel=0.005, minDistance=max(3, spacing // 2),
        blockSize=7, mask=mask)
    count = 0 if corners is None else len(corners)
    # 4 well-distributed corners already determine a similarity transform;
    # fewer than 4 cannot, so refuse to seed honestly.
    if corners is None or count < 4:
        return None, count
    # calcOpticalFlowPyrLK requires CV_32F points shaped (N, 1, 2).
    return corners.astype(np.float32), count


def transform_corners(corners, matrix_3x3):
    return cv2.transform(np.array([corners], dtype=np.float64),
                         np.asarray(matrix_3x3, dtype=np.float64))[0]


def raster_bbox_overlap(polygon, raster_w, raster_h):
    xs = [p[0] for p in polygon]
    ys = [p[1] for p in polygon]
    return not (max(xs) < 0 or min(xs) > raster_w or max(ys) < 0 or min(ys) > raster_h)


def draw_overlay(bgr, polygon, points, label):
    vis = bgr.copy()
    pts = np.round(np.array(polygon, dtype=np.float64)).astype(np.int32)
    cv2.polylines(vis, [pts.reshape(-1, 1, 2)], True, (0, 255, 255), 2)
    for p in points:
        cv2.circle(vis, (int(round(p[0])), int(round(p[1]))), 2, (0, 0, 255), -1)
    cv2.putText(vis, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(vis, label, (8, 20), cv2.FONT_HERSHEY_SIMPLEX, 0.55,
                (255, 255, 255), 1, cv2.LINE_AA)
    return vis


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001
        return fail("bad_request", f"request is not valid JSON: {exc}")
    try:
        frames_dir = request["framesDir"]
        frame_indices = [int(i) for i in request["frameIndices"]]
        region = request["region"]
        grid_step = request.get("gridStep")
        max_fb_error = float(request.get("maxForwardBackwardError", 2.0))
        min_inliers = max(4, int(request.get("minInliers", 4)))
        overlay_dir = request["overlayDir"]
        overlay_count = min(16, max(1, int(request.get("overlayCount", 12))))
    except (KeyError, TypeError, ValueError) as exc:
        return fail("bad_request", f"missing or invalid request field: {exc}")
    if len(frame_indices) == 0:
        return fail("bad_request", "frameIndices is empty")

    first_bgr, first_gray = load_gray(frame_path(frames_dir, frame_indices[0]))
    rh, rw = first_gray.shape[:2]
    points, feature_count = seed_points(first_gray, region, rw, rh, grid_step)
    if points is None:
        if feature_count < 4 and feature_count > 0:
            return fail("unsatisfiable_region",
                        f"the region has too little texture to seed tracking "
                        f"({feature_count} detectable feature points, need ≥ 4) — "
                        f"tracking cannot start honestly on featureless content")
        return fail("bad_request",
                    f"region {region} is too small for seeding in the {rw}x{rh} raster "
                    f"(needs ≥ 4x4 px of in-raster area)")
    seed_count = len(points)
    x0, y0 = float(region["x"]), float(region["y"])
    x1, y1 = x0 + float(region["width"]), y0 + float(region["height"])
    initial_corners = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                               dtype=np.float64)
    cumulative = np.eye(3, dtype=np.float64)

    frames_out = [{
        "frame": frame_indices[0], "status": "tracked",
        "matrix3x3": [1.0, 0, 0, 0, 1.0, 0, 0, 0, 1.0],
        "regionPolygon": [[float(p[0]), float(p[1])] for p in initial_corners],
        "trackedPointCount": seed_count, "inlierCount": seed_count,
        "medianFbErrorPx": 0.0, "maxFbErrorPx": 0.0,
        "inlierRmsePx": 0.0, "medianShiftPx": 0.0,
    }]

    # Overlays: a fixed stride over the requested span, plus the loss frame.
    overlay_files = []
    max_overlays = overlay_count
    stride = max(1, len(frame_indices) // max_overlays)

    prev_gray = first_gray
    prev_bgr = first_bgr
    if 0 % stride == 0:
        path = os.path.join(overlay_dir, f"overlay-f{frame_indices[0]:06d}.png")
        ok_enc, encoded = cv2.imencode(
            ".png", draw_overlay(first_bgr, initial_corners, points[:, 0, :],
                                 f"f{frame_indices[0]:06d} tracked pts={seed_count}"))
        if ok_enc:
            encoded.tofile(path)
            overlay_files.append({"frame": frame_indices[0], "path": path})

    termination = None
    last_polygon = [[float(p[0]), float(p[1])] for p in initial_corners]
    loss_frame_bgr = first_bgr
    for position in range(1, len(frame_indices)):
        frame_index = frame_indices[position]
        try:
            bgr, gray = load_gray(frame_path(frames_dir, frame_index))
        except (OSError, ValueError) as exc:
            termination = {"atFrame": frame_index,
                           "reasonCode": "frame_unreadable",
                           "reason": str(exc)}
            break
        loss_frame_bgr = bgr
        p1, st, _err = cv2.calcOpticalFlowPyrLK(prev_gray, gray, points, None, **LK_PARAMS)
        if p1 is None or st is None:
            termination = {"atFrame": frame_index, "reasonCode": "lk_failed",
                           "reason": "calcOpticalFlowPyrLK returned no points"}
            break
        p0_back, st_back, _err2 = cv2.calcOpticalFlowPyrLK(gray, prev_gray, p1, None, **LK_PARAMS)
        fb_errors = np.linalg.norm(points[:, 0, :] - p0_back[:, 0, :], axis=1)
        valid = (st.ravel() == 1) & (st_back.ravel() == 1) & (fb_errors <= max_fb_error)
        tracked_point_count = int(np.count_nonzero(valid))
        median_fb = float(np.median(fb_errors[valid])) if tracked_point_count else None
        max_fb = float(fb_errors[valid].max()) if tracked_point_count else None
        if tracked_point_count < min_inliers:
            termination = {
                "atFrame": frame_index,
                "reasonCode": "forward_backward_error",
                "reason": (f"only {tracked_point_count} of {len(points)} tracked points survive the "
                           f"forward-backward check (≤ {max_fb_error} px, min {min_inliers}) — "
                           f"motion blur, occlusion or a cut"),
            }
            frames_out.append({
                "frame": frame_index, "status": "lost",
                "trackedPointCount": tracked_point_count,
                "medianFbErrorPx": round(float(np.median(fb_errors)), 3),
                "maxFbErrorPx": round(float(fb_errors.max()), 3),
                "reason": termination["reason"],
            })
            break

        good_prev = points[valid]
        good_next = p1[valid]
        step_matrix, inliers = cv2.estimateAffinePartial2D(
            good_prev, good_next, method=cv2.RANSAC,
            ransacReprojThreshold=RANSAC_THRESHOLD_PX, maxIters=5000,
            confidence=0.995)
        inlier_count = 0 if inliers is None else int(inliers.sum())
        if step_matrix is None or inlier_count < min_inliers:
            termination = {
                "atFrame": frame_index,
                "reasonCode": "insufficient_inliers",
                "reason": (f"RANSAC kept {inlier_count} of {tracked_point_count} points under a "
                           f"similarity model (min {min_inliers}) — inconsistent local motion, "
                           f"occlusion or a cut"),
            }
            frames_out.append({
                "frame": frame_index, "status": "lost",
                "trackedPointCount": tracked_point_count,
                "medianFbErrorPx": round(median_fb, 3) if median_fb is not None else None,
                "maxFbErrorPx": round(max_fb, 3) if max_fb is not None else None,
                "reason": termination["reason"],
            })
            break

        inlier_mask = inliers.ravel().astype(bool)
        proj = cv2.transform(good_prev[inlier_mask], step_matrix.astype(np.float64))[:, 0, :]
        dst = good_next[inlier_mask][:, 0, :]
        inlier_rmse = float(np.sqrt(np.mean(np.sum((proj - dst) ** 2, axis=1))))
        shifts = np.linalg.norm(dst - good_prev[inlier_mask][:, 0, :], axis=1)

        step_3x3 = np.vstack([step_matrix, [[0.0, 0.0, 1.0]]])
        cumulative = step_3x3 @ cumulative
        polygon = transform_corners(initial_corners, cumulative)
        polygon_list = [[round(float(p[0]), 2), round(float(p[1]), 2)] for p in polygon]
        if not raster_bbox_overlap(polygon_list, rw, rh):
            termination = {
                "atFrame": frame_index,
                "reasonCode": "region_out_of_bounds",
                "reason": "the tracked region has left the frame raster entirely",
            }
            frames_out.append({
                "frame": frame_index, "status": "lost",
                "trackedPointCount": int(inlier_count),
                "medianFbErrorPx": round(float(np.median(shifts)), 3),
                "maxFbErrorPx": round(float(shifts.max()), 3),
                "reason": termination["reason"],
            })
            break

        points = good_next[inlier_mask].reshape(-1, 1, 2)
        frames_out.append({
            "frame": frame_index, "status": "tracked",
            "matrix3x3": [float(v) for v in cumulative.ravel()],
            "regionPolygon": polygon_list,
            "trackedPointCount": int(inlier_count),
            "inlierCount": int(inlier_count),
            "medianFbErrorPx": round(median_fb, 3) if median_fb is not None else None,
            "maxFbErrorPx": round(max_fb, 3) if max_fb is not None else None,
            "inlierRmsePx": round(inlier_rmse, 3),
            "medianShiftPx": round(float(np.median(shifts)), 3),
        })
        last_polygon = polygon_list
        if position % stride == 0 or position == len(frame_indices) - 1:
            path = os.path.join(overlay_dir, f"overlay-f{frame_index:06d}.png")
            ok_enc, encoded = cv2.imencode(
                ".png", draw_overlay(bgr, polygon_list, points[:, 0, :],
                                     f"f{frame_index:06d} inl={inlier_count} fb={median_fb if median_fb is not None else -1:.2f}"))
            if ok_enc:
                encoded.tofile(path)
                overlay_files.append({"frame": frame_index, "path": path})
        prev_gray, prev_bgr = gray, bgr

    if termination is not None:
        for position in range(len(frames_out), len(frame_indices)):
            frames_out.append({"frame": frame_indices[position],
                               "status": "not_tracked", "matrix3x3": None})
        loss_frame = termination["atFrame"]
        path = os.path.join(overlay_dir, f"overlay-f{loss_frame:06d}.png")
        # The loss overlay draws the LAST VALID region polygon on the frame
        # where tracking failed — review context, not a claimed position.
        ok_enc, encoded = cv2.imencode(
            ".png", draw_overlay(loss_frame_bgr, last_polygon, [],
                                 f"f{loss_frame:06d} LOST"))
        if ok_enc:
            encoded.tofile(path)
            overlay_files.append({"frame": loss_frame, "path": path})

    result = {
        "status": "lost" if termination is not None else "tracked",
        "raster": {"width": rw, "height": rh},
        "initialRegion": region,
        "seedPointCount": seed_count,
        "parameters": {
            "algorithm": "LK sparse optical flow (pyrLK 21x21, 3 levels) + forward-backward check + RANSAC similarity (estimateAffinePartial2D)",
            "maxForwardBackwardErrorPx": max_fb_error,
            "minInliers": min_inliers,
            "ransacReprojThresholdPx": RANSAC_THRESHOLD_PX,
            "seedGridStepPx": grid_step,
        },
        "frames": frames_out,
        "termination": termination,
        "overlays": overlay_files,
        "coordinateSpace": "source-frame raster pixels, origin top-left; matrix maps frame[0] region coordinates -> this frame's coordinates",
    }
    return emit_ok(result)


if __name__ == "__main__":
    sys.exit(main())
