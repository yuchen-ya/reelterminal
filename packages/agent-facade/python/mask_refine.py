"""Create a static grayscale alpha mask from a PNG mask or GrabCut rectangle.

The worker does not modify project state. It only writes the requested mask
PNG and, when a source color PNG is provided, a tinted review overlay PNG.
GrabCut's rectangle is an initialization hint and needs textured, separable
foreground/background; it is not an automatic precise subject cutout.
"""

import json
import os
import struct
import sys
import zlib

import cv2
import numpy as np

MAX_DIMENSION = 4096
MAX_PIXELS = 16_777_216
MAX_INPUT_BYTES = 64 * 1024 * 1024


def emit_ok(result):
    json.dump({"ok": True, "result": result}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def fail(code, message):
    json.dump({"ok": False, "error": {"code": code, "message": message}}, sys.stdout)
    sys.stdout.write("\n")
    return 0


def rejected(code, message, **details):
    return emit_ok({"status": "rejected", "reasonCode": code, "reason": message, **details})


def read_png(path, role):
    try:
        with open(path, "rb") as stream:
            encoded = stream.read(MAX_INPUT_BYTES + 1)
    except OSError as exc:
        return None, f"cannot read {role} PNG: {exc}"
    if len(encoded) > MAX_INPUT_BYTES:
        return None, f"{role} PNG exceeds the {MAX_INPUT_BYTES}-byte input limit"
    if len(encoded) < 33 or encoded[:8] != b"\x89PNG\r\n\x1a\n" or encoded[12:16] != b"IHDR" or struct.unpack(">I", encoded[8:12])[0] != 13:
        return None, f"{role} input must be a valid PNG"
    ihdr_crc = zlib.crc32(encoded[12:29]) & 0xFFFFFFFF
    if ihdr_crc != struct.unpack(">I", encoded[29:33])[0]:
        return None, f"{role} PNG has an invalid IHDR checksum"
    width, height = struct.unpack(">II", encoded[16:24])
    if width < 1 or height < 1 or width > MAX_DIMENSION or height > MAX_DIMENSION or width * height > MAX_PIXELS:
        return None, f"{role} PNG raster {width}x{height} exceeds limits (max dimension {MAX_DIMENSION}, max pixels {MAX_PIXELS})"
    bit_depth = encoded[24]
    if bit_depth > 8:
        return None, f"{role} PNG uses {bit_depth}-bit samples; mask refinement accepts 8-bit PNG only"
    image = cv2.imdecode(np.frombuffer(encoded, dtype=np.uint8), cv2.IMREAD_UNCHANGED)
    if image is None or image.shape[1] != width or image.shape[0] != height or image.dtype != np.uint8:
        return None, f"cannot decode {role} PNG raster"
    if image.ndim == 3 and image.shape[2] not in (3, 4):
        return None, f"{role} PNG must be grayscale, RGB, or RGBA"
    return image, None


def write_png(path, image):
    ok, encoded = cv2.imencode(".png", image)
    if not ok:
        raise RuntimeError(f"OpenCV could not encode PNG: {path}")
    encoded.tofile(path)


def alpha_from_mask(image):
    if image.ndim == 2:
        return image.copy()
    if image.shape[2] == 4:
        alpha = image[:, :, 3]
        if np.any(alpha != 255):
            return alpha.copy()
        image = image[:, :, :3]
    return cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)


def integer_field(request, name, default, minimum, maximum):
    value = request.get(name, default)
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum or value > maximum:
        raise ValueError(f"{name} must be an integer in [{minimum}, {maximum}]")
    return value


def main():
    try:
        request = json.load(sys.stdin)
    except Exception as exc:
        return fail("bad_request", f"request is not valid JSON: {exc}")
    try:
        if not isinstance(request, dict):
            return fail("bad_request", "request must be a JSON object")
        mode = request.get("mode")
        if mode not in ("mask", "grabcut"):
            return fail("bad_request", "mode must be mask or grabcut")
        source_path = request.get("sourcePath")
        if mode == "grabcut" and not isinstance(source_path, str):
            return fail("bad_request", "GrabCut mode requires sourcePath")
        if source_path is not None and not isinstance(source_path, str):
            return fail("bad_request", "sourcePath must be a path string")
        alpha_output = request.get("alphaOutput")
        if not isinstance(alpha_output, str) or not alpha_output:
            return fail("bad_request", "alphaOutput must be a non-empty path")
        overlay_output = request.get("overlayOutput")
        if source_path and (not isinstance(overlay_output, str) or not overlay_output):
            return fail("bad_request", "overlayOutput is required when sourcePath is provided")

        dilate_px = integer_field(request, "dilatePx", 0, 0, 64)
        erode_px = integer_field(request, "erodePx", 0, 0, 64)
        feather_px = integer_field(request, "featherPx", 0, 0, 32)
        iterations = integer_field(request, "iterations", 5, 1, 10)

        source = None
        source_alpha = None
        if source_path:
            source, error = read_png(source_path, "source")
            if error:
                return rejected("invalid_source", error)
            if source.ndim == 3 and source.shape[2] == 4:
                source_alpha = source[:, :, 3].copy()
                source = source[:, :, :3].copy()
            elif source.ndim == 2:
                source = cv2.cvtColor(source, cv2.COLOR_GRAY2BGR)
            height, width = source.shape[:2]
        else:
            width = height = None

        if mode == "mask":
            mask_path = request.get("maskPath")
            if not isinstance(mask_path, str) or not mask_path:
                return fail("bad_request", "mask mode requires maskPath")
            image, error = read_png(mask_path, "mask")
            if error:
                return rejected("invalid_mask", error)
            alpha = alpha_from_mask(image)
            if width is None:
                height, width = alpha.shape[:2]
            elif alpha.shape != (height, width):
                return rejected("raster_mismatch", f"source is {width}x{height} but mask is {alpha.shape[1]}x{alpha.shape[0]}")
            method = "input-mask"
        else:
            if source is None:
                return fail("bad_request", "GrabCut mode requires a source PNG")
            rect = request.get("rect")
            if not isinstance(rect, dict):
                return fail("bad_request", "GrabCut mode requires a rectangle")
            fields = [rect.get(key) for key in ("x", "y", "width", "height")]
            if any(isinstance(value, bool) or not isinstance(value, int) for value in fields):
                return fail("bad_request", "rect x, y, width, and height must be integers")
            x, y, rect_width, rect_height = fields
            if x < 0 or y < 0 or rect_width < 2 or rect_height < 2 or x + rect_width > width or y + rect_height > height:
                return rejected("rect_out_of_bounds", f"rect must be at least 2x2 and fully inside the {width}x{height} source raster")
            grabcut_mask = np.zeros((height, width), dtype=np.uint8)
            bgd_model = np.zeros((1, 65), dtype=np.float64)
            fgd_model = np.zeros((1, 65), dtype=np.float64)
            cv2.grabCut(source, grabcut_mask, (x, y, rect_width, rect_height), bgd_model, fgd_model, iterations, cv2.GC_INIT_WITH_RECT)
            alpha = np.where((grabcut_mask == cv2.GC_FGD) | (grabcut_mask == cv2.GC_PR_FGD), 255, 0).astype(np.uint8)
            method = "grabcut-rectangle-initialization"

        if not np.any(alpha):
            return rejected("empty_mask", "initial mask contains no foreground pixels")

        if dilate_px:
            size = 2 * dilate_px + 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
            alpha = cv2.dilate(alpha, kernel)
        if erode_px:
            size = 2 * erode_px + 1
            kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (size, size))
            alpha = cv2.erode(alpha, kernel)
        if not np.any(alpha):
            return rejected("empty_after_morphology", "erosion removed the entire mask")
        if feather_px:
            alpha = cv2.GaussianBlur(alpha, (0, 0), sigmaX=float(feather_px), sigmaY=float(feather_px))
        if not np.any(alpha):
            return rejected("empty_after_feather", "feathering produced an empty mask")

        write_png(alpha_output, alpha)
        if source is not None:
            # Magenta tint makes the candidate boundary easy to inspect while
            # preserving the source details beneath the grayscale alpha.
            tint = np.zeros_like(source)
            tint[:, :] = (220, 40, 220)
            amount = (alpha.astype(np.float32) / 255.0 * 0.42)[:, :, None]
            overlay = np.clip(source.astype(np.float32) * (1.0 - amount) + tint.astype(np.float32) * amount, 0, 255).astype(np.uint8)
            if source_alpha is not None:
                overlay = np.dstack((overlay, source_alpha))
            write_png(overlay_output, overlay)

        return emit_ok({
            "status": "created",
            "method": method,
            "width": width,
            "height": height,
            "alphaMask": alpha_output,
            "overlayCandidate": overlay_output if source is not None else None,
            "maskStats": {
                "foregroundPixels": int(np.count_nonzero(alpha)),
                "opaquePixels": int(np.count_nonzero(alpha == 255)),
                "softEdgePixels": int(np.count_nonzero((alpha > 0) & (alpha < 255))),
            },
            "parameters": {
                "dilatePx": dilate_px,
                "erodePx": erode_px,
                "featherPx": feather_px,
                "iterations": iterations if method.startswith("grabcut") else None,
                "morphologyOrder": "dilate, then erode, then gaussian feather",
            },
        })
    except (KeyError, TypeError, ValueError) as exc:
        return fail("bad_request", str(exc))
    except Exception as exc:
        return fail("worker_error", f"mask refinement failed: {type(exc).__name__}: {exc}")


if __name__ == "__main__":
    sys.exit(main())
