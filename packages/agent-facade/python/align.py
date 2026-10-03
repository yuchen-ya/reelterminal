"""image.align worker: estimate a translation/similarity/affine transform
between two still images and report it with honest, method-specific
diagnostics.

Request (JSON on stdin):
{
  "reference": "<path>",            # alignment target raster
  "moving": "<path>",               # image warped onto the reference
  "alignedOutput": "<path>",        # where the aligned PNG is written
  "transform": "translation" | "similarity" | "affine",
  "stableRegion": {"x","y","width","height"} | null,   # reference-raster pixels
  "eccIterations": int,             # optional, default 200
  "eccEpsilon": float               # optional, default 1e-6
}

Response (JSON on stdout): {"ok": true, "result": {...}} or
{"ok": false, "error": {"code", "message"}}. An estimation failure is NOT an
error response: result.status is "failed" with reasonCode/reason and whatever
diagnostics exist — the caller surfaces that honestly.

The estimated matrix is ALWAYS the homogeneous 3x3 (row-major list)
    [w00 w01 w02]
    [w10 w11 w12]
    [0   0   1  ]
mapping MOVING-image pixel coordinates -> REFERENCE-image pixel coordinates,
origin top-left of each image's own raster. The aligned image is
cv2.warpAffine(moving, warp, (refW, refH)); pixels outside the warped moving
image are black fill and are EXCLUDED from every residual via the reported
valid-coverage polygon. Residuals are grayscale mean-abs-diff inside
(validCoverage ∩ stableRegion). Scores are method-specific (ECC correlation
coefficient vs ORB inlier statistics) and never presented as one unified
confidence.
"""

import json
import sys

import cv2
import numpy as np


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


def load_gray_bgr(path):
    raw = cv2.imdecode(np.fromfile(path, dtype=np.uint8), cv2.IMREAD_COLOR)
    if raw is None:
        raise ValueError(f"cannot decode image: {path}")
    # imdecode with np.fromfile handles non-ASCII paths on Windows that
    # cv2.imread cannot.
    return raw, cv2.cvtColor(raw, cv2.COLOR_BGR2GRAY)


def mask_for(shape, stable_region):
    mask = np.full(shape[:2], 255, dtype=np.uint8)
    if stable_region is not None:
        mask[:] = 0
        x, y = int(stable_region["x"]), int(stable_region["y"])
        w, h = int(stable_region["width"]), int(stable_region["height"])
        mask[y:y + h, x:x + w] = 255
    return mask


def clip_polygon_to_raster(polygon, raster_w, raster_h):
    """Sutherland–Hodgman clip of a convex polygon against the raster rect."""

    def clip(points, axis, bound, keep_le):
        if not points:
            return points

        def inside(p):
            return p[axis] <= bound if keep_le else p[axis] >= bound

        def intersect(a, b):
            span = b[axis] - a[axis]
            if abs(span) < 1e-12:
                return b
            t = (bound - a[axis]) / span
            return (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)

        out = []
        n = len(points)
        for i in range(n):
            cur, nxt = points[i], points[(i + 1) % n]
            if inside(cur):
                out.append(cur)
                if not inside(nxt):
                    out.append(intersect(cur, nxt))
            elif inside(nxt):
                out.append(intersect(cur, nxt))
        return out

    poly = [(float(p[0]), float(p[1])) for p in polygon]
    poly = clip(poly, 0, float(raster_w), True)
    poly = clip(poly, 1, float(raster_h), True)
    poly = clip(poly, 0, 0.0, False)
    poly = clip(poly, 1, 0.0, False)
    return [[round(x, 2), round(y, 2)] for x, y in poly]


def polygon_mask(polygon, shape):
    mask = np.zeros(shape[:2], dtype=np.uint8)
    if len(polygon) >= 3:
        pts = np.round(np.array(polygon, dtype=np.float64)).astype(np.int32)
        cv2.fillPoly(mask, [pts], 255)
    return mask


def residual(ref_gray, aligned_gray, valid_mask, stable_region):
    region_mask = mask_for(ref_gray.shape, stable_region)
    combined = cv2.bitwise_and(valid_mask, region_mask)
    pixels = int(np.count_nonzero(combined))
    if pixels == 0:
        return {"sampledPixels": 0, "meanAbsDiffGray": None,
                "region": "empty overlap between valid coverage and the scored region"}
    diff = cv2.absdiff(ref_gray, aligned_gray)
    where = "stableRegion∩validCoverage" if stable_region is not None else "validCoverage"
    return {
        "sampledPixels": pixels,
        "meanAbsDiffGray": round(float(diff[combined > 0].sum()) / (pixels * 255.0), 6),
        "region": where,
    }


def failed(method, reason_code, reason, diagnostics):
    return {"status": "failed", "method": method, "reasonCode": reason_code,
            "reason": reason, "diagnostics": diagnostics}


def ecc_translation(ref_gray, mov_gray, stable_region, iterations, epsilon):
    """ECC from identity. Returns (warp2x3 | None, result_fields).

    findTransformECC returns the warp in TEMPLATE->INPUT direction (it is
    applied with WARP_INVERSE_MAP per the OpenCV docs), so it is inverted
    here to honor the worker's documented output direction: moving->
    reference (the matrix warpAffine(moving, M) needs to place the moving
    image on the reference canvas).
    """
    warp = np.eye(2, 3, dtype=np.float32)
    criteria = (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT,
                int(iterations), float(epsilon))
    mask = mask_for(ref_gray.shape, stable_region)
    try:
        cc, warp = cv2.findTransformECC(
            ref_gray, mov_gray, warp, cv2.MOTION_TRANSLATION, criteria, mask, 5)
    except cv2.error as exc:
        message = str(exc)
        if "converge" in message.lower():
            return None, failed(
                "ecc-translation", "ecc_not_converged",
                f"findTransformECC did not converge (low texture or a shift larger than the basin of attraction): {message}",
                {"eccIterationsRequested": iterations, "eccEpsilon": epsilon})
        # Anything else (bad dtype, bad mask, internal limit) is a script
        # error, not an estimation outcome — re-raise for the protocol layer.
        raise
    # Invert the template->input warp: [R|t] with R = I for translation.
    forward = np.vstack([warp, [[0.0, 0.0, 1.0]]])
    backward = np.linalg.inv(forward)
    return backward[:2, :], {
        "status": "aligned", "method": "ecc-translation",
        "diagnostics": {
            "note": "ECC correlation coefficient — an ECC-specific score, not comparable with other methods' scores",
            "correlationCoefficient": round(float(cc), 6),
            "eccIterationsRequested": iterations,
            "eccEpsilon": epsilon,
        },
    }


def orb_features(ref_gray, mov_gray, ref_mask, want_affine):
    """ORB match + RANSAC. Returns (warp2x3 | None, result_fields)."""
    method_name = "orb-ransac-affine" if want_affine else "orb-ransac-similarity"
    orb = cv2.ORB_create(nfeatures=4000)
    kp1, des1 = orb.detectAndCompute(mov_gray, None)      # moving: all of it
    kp2, des2 = orb.detectAndCompute(ref_gray, ref_mask)  # reference: mask-limited
    diag = {"keypointsMoving": 0 if kp1 is None else len(kp1),
            "keypointsReference": 0 if kp2 is None else len(kp2),
            "goodMatches": 0}
    if des1 is None or des2 is None or len(kp1) < 8 or len(kp2) < 8:
        diag["reasonHint"] = "low texture, or the stable region is empty/too small"
        return None, failed(
            method_name, "insufficient_features",
            f"too few ORB keypoints: moving {diag['keypointsMoving']}, reference {diag['keypointsReference']} (need ≥ 8 each)",
            diag)
    matcher = cv2.BFMatcher(cv2.NORM_HAMMING)
    good = []
    for pair in matcher.knnMatch(des1, des2, k=2):
        if len(pair) == 2 and pair[0].distance < 0.75 * pair[1].distance:
            good.append(pair[0])
    diag["goodMatches"] = len(good)
    if len(good) < 8:
        return None, failed(
            method_name, "insufficient_features",
            f"only {len(good)} ratio-test matches pass (need ≥ 8) — little real overlap or repetitive texture",
            diag)
    src = np.float64([kp1[m.queryIdx].pt for m in good]).reshape(-1, 1, 2)
    dst = np.float64([kp2[m.trainIdx].pt for m in good]).reshape(-1, 1, 2)
    estimator = cv2.estimateAffine2D if want_affine else cv2.estimateAffinePartial2D
    warp, inliers = estimator(src, dst, method=cv2.RANSAC,
                              ransacReprojThreshold=3.0, maxIters=5000,
                              confidence=0.995)
    inlier_count = 0 if inliers is None else int(inliers.sum())
    diag["ransacInliers"] = inlier_count
    diag["ransacInlierRatio"] = round(inlier_count / len(good), 4)
    if warp is None or inlier_count < 6:
        return None, failed(
            method_name, "no_consistent_model",
            f"RANSAC found no consistent {method_name.split('-')[-1]} model ({inlier_count} inliers of {len(good)} matches)",
            diag)
    src_in = src[inliers.ravel().astype(bool)]
    dst_in = dst[inliers.ravel().astype(bool)]
    proj = cv2.transform(src_in, warp.astype(np.float64))[:, 0, :]
    diag["inlierRmsePx"] = round(
        float(np.sqrt(np.mean(np.sum((proj - dst_in[:, 0, :]) ** 2, axis=1)))), 3)
    diag["note"] = ("ORB inlier count/RMSE/RANSAC ratio — feature-method scores, "
                    "not comparable with ECC scores")
    return warp.astype(np.float64), {
        "status": "aligned", "method": method_name, "diagnostics": diag}


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:  # noqa: BLE001 — protocol errors must be reported
        return fail("bad_request", f"request is not valid JSON: {exc}")
    try:
        reference_path = request["reference"]
        moving_path = request["moving"]
        aligned_output = request["alignedOutput"]
        transform = request.get("transform", "translation")
        stable_region = request.get("stableRegion")
        iterations = int(request.get("eccIterations", 200))
        epsilon = float(request.get("eccEpsilon", 1e-6))
    except (KeyError, TypeError, ValueError) as exc:
        return fail("bad_request", f"missing or invalid request field: {exc}")
    if transform not in ("translation", "similarity", "affine"):
        return fail("bad_request", f"unknown transform: {transform!r}")

    try:
        ref_bgr, ref_gray = load_gray_bgr(reference_path)
        mov_bgr, mov_gray = load_gray_bgr(moving_path)
    except (OSError, ValueError) as exc:
        return fail("unreadable_image", str(exc))

    rh, rw = ref_gray.shape[:2]
    mh, mw = mov_gray.shape[:2]
    if (rw, rh) != (mw, mh):
        return fail(
            "size_mismatch",
            f"reference is {rw}x{rh} but moving is {mw}x{mh} — resize the moving image to "
            f"the reference raster first (this worker refuses to guess the relation)")

    if transform == "translation":
        warp, result = ecc_translation(ref_gray, mov_gray, stable_region,
                                       iterations, epsilon)
    else:
        warp, result = orb_features(ref_gray, mov_gray,
                                    mask_for(ref_gray.shape, stable_region),
                                    want_affine=(transform == "affine"))
    if warp is None:
        return emit_ok(result)

    aligned = cv2.warpAffine(mov_bgr, warp, (rw, rh), flags=cv2.INTER_LINEAR,
                             borderMode=cv2.BORDER_CONSTANT, borderValue=(0, 0, 0))
    ok_encode, encoded = cv2.imencode(".png", aligned)
    if not ok_encode:
        return fail("encode_failed", "aligned image PNG encode failed")
    try:
        encoded.tofile(aligned_output)
    except OSError as exc:
        return fail("write_failed", f"cannot write aligned image: {exc}")

    hom = np.vstack([warp, [[0.0, 0.0, 1.0]]])
    corners = np.array([[0, 0], [mw, 0], [mw, mh], [0, mh]], dtype=np.float64)
    warped_corners = cv2.transform(np.array([corners]), hom)[0]
    polygon = clip_polygon_to_raster(warped_corners, rw, rh)
    valid_mask = polygon_mask(polygon, ref_gray.shape)
    if int(np.count_nonzero(valid_mask)) == 0:
        result.update({
            "status": "failed", "reasonCode": "no_overlap",
            "reason": "the warped moving image does not overlap the reference raster",
            "matrix3x3": [float(v) for v in hom.ravel()],
            "matrixDirection": "moving->reference",
        })
        return emit_ok(result)

    result.update({
        "matrix3x3": [float(v) for v in hom.ravel()],
        "matrixDirection": "moving->reference",
        "coordinateSpace": "reference-raster pixels, origin top-left",
        "referenceRaster": {"width": rw, "height": rh},
        "movingRaster": {"width": mw, "height": mh},
        "alignedImage": aligned_output,
        "validCoverage": {"polygon": polygon,
                          "pixelCount": int(np.count_nonzero(valid_mask))},
        "residual": residual(ref_gray, cv2.cvtColor(aligned, cv2.COLOR_BGR2GRAY),
                             valid_mask, stable_region),
    })
    return emit_ok(result)


if __name__ == "__main__":
    sys.exit(main())
