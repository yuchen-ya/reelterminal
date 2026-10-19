"""Verify real unpacked resources without opening an Electron/user project.

Only generated synthetic images are used. No model weights are loaded/downloaded.
CI requires OpenCV; developer machines can report algorithms as unverified.
"""
import argparse
import hashlib
import importlib.util
import json
from pathlib import Path
import re
import struct
import subprocess
import sys
import tempfile
import zlib


WORKERS = ("audio_models.py", "caption_models.py", "align.py", "track.py", "mask_refine.py", "propagate.py")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def decode_icon(path):
    """Decode PNG scanlines, including all five filters, using stdlib only."""
    data = path.read_bytes()
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "invalid PNG signature"
    offset, compressed, header = 8, bytearray(), None
    while offset < len(data):
        size = struct.unpack_from(">I", data, offset)[0]
        kind = data[offset + 4:offset + 8]
        payload = data[offset + 8:offset + 8 + size]
        crc = struct.unpack_from(">I", data, offset + 8 + size)[0]
        assert zlib.crc32(kind + payload) & 0xFFFFFFFF == crc, "PNG CRC mismatch"
        if kind == b"IHDR":
            header = struct.unpack(">IIBBBBB", payload)
        if kind == b"IDAT":
            compressed.extend(payload)
        offset += size + 12
        if kind == b"IEND":
            break
    assert header and offset == len(data), "incomplete PNG"
    width, height, depth, color, compression, filtering, interlace = header
    assert 0 < width <= 4096 and 0 < height <= 4096
    assert depth == 8 and compression == filtering == interlace == 0, "unsupported icon PNG encoding"
    channels = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}[color]
    stride = width * channels
    scanlines = zlib.decompress(compressed)
    assert len(scanlines) == height * (stride + 1)
    previous, pixels = bytearray(stride), bytearray()
    for y in range(height):
        start = y * (stride + 1)
        mode = scanlines[start]
        assert mode in range(5), "invalid PNG filter"
        row = bytearray(scanlines[start + 1:start + 1 + stride])
        for x in range(stride):
            left = row[x - channels] if x >= channels else 0
            above = previous[x]
            upper_left = previous[x - channels] if x >= channels else 0
            predictor = 0
            if mode == 1:
                predictor = left
            elif mode == 2:
                predictor = above
            elif mode == 3:
                predictor = (left + above) // 2
            elif mode == 4:
                p = left + above - upper_left
                distances = (abs(p - left), abs(p - above), abs(p - upper_left))
                predictor = (left, above, upper_left)[distances.index(min(distances))]
            row[x] = (row[x] + predictor) & 255
        pixels.extend(row)
        previous = row
    return {"width": width, "height": height, "decodedPixelSha256": hashlib.sha256(pixels).hexdigest()}


def worker(directory, name, request, progress):
    progress[name] = {"status": "running", "stage": "process-start"}
    process = subprocess.run([sys.executable, "-I", "-B", str(directory / name)],
                             input=json.dumps(request), text=True, capture_output=True, timeout=30)
    # Keep a bounded diagnosis without publishing stderr paths or request media.
    progress[name] = {"status": "failed", "stage": "worker-exit", "exitCode": process.returncode}
    exception = re.findall(r"^([\w.]+(?:Error|Exception)):", process.stderr, re.MULTILINE)
    if exception:
        progress[name]["exceptionType"] = exception[-1]
    assert process.returncode == 0, f"{name}: process exit {process.returncode}"
    progress[name]["stage"] = "protocol"
    response = json.loads(process.stdout)
    assert response.get("ok") is True, f"{name}: worker rejected synthetic request"
    progress[name] = {"status": "running", "stage": "algorithm-assertions", "exitCode": 0}
    return response["result"]


def algorithms(directory, temp, progress):
    import cv2
    import numpy as np
    cv2.setNumThreads(1)
    root = Path(temp)
    frames = root / "frames"
    frames.mkdir()
    # Deterministic, textured, identical frames make the expected transform identity.
    image = np.random.default_rng(1977).integers(0, 256, (256, 256, 3), dtype=np.uint8)
    image = cv2.GaussianBlur(image, (3, 3), 0.6)
    mask = np.zeros((256, 256), dtype=np.uint8)
    mask[40:216, 40:216] = 255
    def png(path, array):
        ok, encoded = cv2.imencode(".png", array)
        assert ok
        encoded.tofile(str(path))
        return str(path)
    for index in range(3):
        png(frames / f"f{index:06d}.png", image)
    source = str(frames / "f000000.png")
    mask_path = png(root / "mask.png", mask)
    aligned_path = str(root / "aligned.png")
    aligned = worker(directory, "align.py", {"reference": source, "moving": source,
                      "alignedOutput": aligned_path, "transform": "translation"}, progress)
    assert aligned["status"] == "aligned"
    assert np.allclose(np.array(aligned["matrix3x3"]).reshape(3, 3), np.eye(3), atol=0.05)
    assert cv2.imread(aligned_path).shape == image.shape
    progress["align.py"] = {"status": "passed", "stage": "algorithm-assertions", "exitCode": 0}
    # motion-tools.ts creates this directory before invoking track.py. Match
    # that caller contract: the worker writes overlays but does not create it.
    track_overlays = root / "track-overlays"
    track_overlays.mkdir()
    tracking = worker(directory, "track.py", {"framesDir": str(frames), "frameIndices": [0, 1, 2],
                      "region": {"x": 40, "y": 40, "width": 176, "height": 176},
                      "overlayDir": str(track_overlays), "overlayCount": 2}, progress)
    assert tracking["status"] == "tracked"
    assert len(tracking["frames"]) == 3
    for row in tracking["frames"]:
        assert row["status"] == "tracked"
        assert np.allclose(np.array(row["matrix3x3"]).reshape(3, 3), np.eye(3), atol=0.05)
    assert len(list(track_overlays.glob("*.png"))) >= 2
    progress["track.py"] = {"status": "passed", "stage": "algorithm-assertions", "exitCode": 0}
    alpha_path = str(root / "alpha.png")
    refined = worker(directory, "mask_refine.py", {"mode": "mask", "maskPath": mask_path,
                     "alphaOutput": alpha_path, "dilatePx": 1, "featherPx": 2}, progress)
    assert refined["status"] == "created" and refined["maskStats"]["softEdgePixels"] > 0
    assert cv2.imread(alpha_path, cv2.IMREAD_GRAYSCALE).shape == mask.shape
    progress["mask_refine.py"] = {"status": "passed", "stage": "algorithm-assertions", "exitCode": 0}
    output = root / "propagated"
    propagated = worker(directory, "propagate.py", {"framesDir": str(frames), "frameIndices": [0, 1, 2],
                        "patchPath": source, "maskPath": mask_path, "outputDir": str(output),
                        "overlayDir": str(root / "propagate-overlays"), "options": {"overlayCount": 2}}, progress)
    assert propagated["status"] == "propagated"
    assert len(propagated["frames"]) == 3 and all(row["status"] == "patched" for row in propagated["frames"])
    assert len(list(output.glob("*.png"))) == 3
    for result_path in output.glob("*.png"):
        assert cv2.imread(str(result_path), cv2.IMREAD_UNCHANGED).shape[:2] == (256, 256)
    progress["propagate.py"] = {"status": "passed", "stage": "algorithm-assertions", "exitCode": 0}
    return {"status": "passed", "workers": ["align.py", "track.py", "mask_refine.py", "propagate.py"],
            "cv2Version": cv2.__version__, "numpyVersion": np.__version__, "fixture": "generated-seed-1977-identical-256px-frames"}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--resources", type=Path, required=True)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--report", type=Path, required=True)
    parser.add_argument("--require-opencv", action="store_true")
    args = parser.parse_args()
    result = {"status": "failed", "algorithms": {"status": "unverified"}, "modelInference": "not-tested",
              "macDockInteraction": "not-tested"}
    try:
        result["sourceHead"] = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=args.source_root, text=True).strip()
        result["sourceDirty"] = bool(subprocess.check_output(["git", "status", "--porcelain"], cwd=args.source_root, text=True).strip())
        directory = args.resources / "app.asar.unpacked" / "dist" / "python"
        source = args.source_root / "packages" / "agent-facade" / "python"
        result["workers"] = {}
        for name in WORKERS:
            physical = directory / name
            assert physical.is_file(), f"missing physical worker: {name}"
            assert digest(physical) == digest(source / name), f"worker source mismatch: {name}"
            compile(physical.read_bytes(), name, "exec")
            result["workers"][name] = {"physicalReadable": True, "compiled": True, "sha256": digest(physical)}
        audio = subprocess.run([sys.executable, "-I", "-B", str(directory / "audio_models.py")],
                               input="{}", text=True, capture_output=True, timeout=15)
        assert audio.returncode == 0 and json.loads(audio.stdout)["event"] == "error"
        result["audioProtocolStartup"] = "passed-unknown-task-error"
        helper = subprocess.run([sys.executable, "-I", "-B", "-c",
                                 "import runpy,sys; m=runpy.run_path(sys.argv[1]); assert callable(m['restore_word_text'])",
                                 str(directory / "caption_models.py")], capture_output=True, timeout=15)
        assert helper.returncode == 0, "caption helper cannot be loaded by external Python"
        result["captionHelperStartup"] = "passed-no-model-load"
        icon = args.resources / "icon.png"
        assert digest(icon) == digest(args.source_root / "apps/desktop/build/icon.png"), "runtime icon mismatch"
        result["icon"] = {"sha256": digest(icon), **decode_icon(icon)}
        has_cv = all(importlib.util.find_spec(name) is not None for name in ("cv2", "numpy"))
        if has_cv:
            result["algorithmWorkers"] = {}
            with tempfile.TemporaryDirectory(prefix="packaged-resources-") as temp:
                result["algorithms"] = algorithms(directory, temp, result["algorithmWorkers"])
            result["opencvWorkerStartup"] = "passed-four-real-worker-processes"
        else:
            result["algorithms"] = {"status": "unverified", "reason": "interpreter lacks cv2/numpy"}
            result["opencvWorkerStartup"] = "blocked-missing-cv2-numpy"
            assert not args.require_opencv, "OpenCV algorithms required but dependencies are missing"
        result["status"] = "passed" if has_cv else "partial"
    except Exception as error:
        result["failureType"] = type(error).__name__
        if "algorithmWorkers" in result:
            result["algorithms"]["status"] = "failed"
            for progress in result["algorithmWorkers"].values():
                if progress["status"] == "running":
                    progress["status"] = "failed"
        raise
    finally:
        args.report.parent.mkdir(parents=True, exist_ok=True)
        args.report.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(result))


if __name__ == "__main__":
    main()
