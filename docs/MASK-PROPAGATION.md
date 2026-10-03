# Mask refinement and short patch propagation

These local OpenCV tools produce candidates only. They share the Command API,
schema/MCP discovery, source containment and artifact rules with the existing
frame tools. Neither verb changes the timeline or starts a model download.

## Runtime and limits

Configure `REELTERMINAL_OPENCV_PYTHON` (or `REELTERMINAL_PYTHON_PATH`) or provide
a Python with `cv2` and `numpy` on PATH. Both discovery and worker execution
use isolated Python (`-I`); user-site-only packages do not qualify. Worker
scripts ship alongside desktop builds and may also be located through
`REELTERMINAL_OPENCV_SCRIPT_DIR`.

`capabilities.get.motionTools.maskRefine` and `.patchPropagate` report their
own script and runtime requirements. Propagation additionally needs the same
FFmpeg/FFprobe backend as exact frame extraction. Both require media and
artifact roots. Commands are bounded synchronous candidate calls; they are
not asynchronous jobs and `job.cancel` does not cancel them. Process timeouts
remain enforced. Break long footage into separately reviewed short ranges.

## mask.refine

```powershell
reelctl mask refine --file mask.json
```

Example `mask.json` (paths must be inside configured roots):

```json
{
  "initialization": {
    "mask": {"path": "E:/media/mask.png"},
    "source": {"path": "E:/media/frame.png"}
  },
  "dilatePx": 1,
  "erodePx": 0,
  "featherPx": 1
}
```

Omit `source` for a mask-only operation. For GrabCut, replace `mask` with
`rect: {"x": 40, "y": 30, "width": 100, "height": 80}` and optionally
`iterations` (1–10); `source` is then required. Rectangle initialization is
only a segmentation proposal, not automatic precise character matting.

The operation applies elliptical dilation, then erosion, then Gaussian
feathering. Dilation/erosion radii are 0–64 pixels; feather sigma is 0–32.
Coordinates are original PNG pixels, top-left origin. Source and mask must
match dimensions. Output is an 8-bit grayscale alpha PNG plus a tinted review
overlay when a source is supplied. A no-op grayscale mask preserves pixels.
RGBA masks use their alpha if it is not uniformly opaque; otherwise RGB
luminance is used. Source alpha is preserved in the optional overlay.

Input limits are 64 MiB per PNG, 4096 pixels per edge, 16,777,216 pixels;
samples above 8-bit are rejected. Headers and dimensions are checked before
OpenCV decode. Empty masks and invalid rectangles are rejected. Inspect
the result before using it for compositing.

## patch.propagate

```powershell
reelctl patch propagate --file propagate.json
```

```json
{
  "source": {"mediaId": "imported-video-id"},
  "range": {"startFrame": 10, "endFrame": 42},
  "patch": {"path": "E:/media/first-frame-patch.png"},
  "mask": {"path": "E:/media/refined-mask.png"},
  "options": {"maxForwardBackwardError": 2, "minInliers": 4, "overlayCount": 12}
}
```

The range uses zero-based decoded-frame indices and a half-open end. Patch
and mask are full-frame PNGs aligned to **startFrame**, in its decoded raster
(including decoder autorotation). Patch accepts 8-bit RGB/RGBA; mask must be
single-channel 8-bit grayscale. Refine other mask formats first.

Features are seeded inside the effective mask on the original first frame.
LK forward/backward checks and RANSAC estimate a cumulative similarity
transform: first-frame → current-frame. Mask and premultiplied patch colors
are warped by that transform and composited over each original decoded
frame. Premultiplication prevents hidden RGB in transparent pixels from
creating dark or colored borders.

This is a **short rigid-region approximation**, not dense nonrigid character
animation. Global scene-change and local appearance gates are heuristics:
they may stop on a flash, lighting change or legitimate animation, and cannot
guarantee detection of every cut or partial occlusion. The first detected
loss stops propagation; that frame and all later frames are copied unchanged
and marked `needsRepair` with null transforms. It never silently reseeds.

Limits: 120 frames, 4096 pixels per edge, 16,000,000 pixels per frame and
250,000,000 total frame-pixels. Budget is checked before frame extraction.
1080p × 120 fits; large rasters require shorter ranges. Generated originals,
masks, candidates and overlays can still consume substantial disk space.

Results include lossless candidate PNGs, real per-frame PTS, transforms,
termination reason, mask bounds, outside-mask pixel checks and inspection
overlays. VFR is retained in the frame manifest, not silently encoded into a
CFR video. No output video is implicitly created. Source-native playback is
supported; timeline speed/reverse mappings remain the caller's responsibility.

## Review and adoption

Inspect the overlays and use the existing `video.compare`/contact-sheet tools.
Review the first loss and neighboring frames explicitly. PNG pixels outside
the effective warped alpha must remain equal to the corresponding original
decoded frame. Lossless PNG equality does not imply a later lossy MP4 will
be byte-identical.

For CFR, encode a checked image sequence using the original rate, then use
`edit.validate` and `edit.apply` with `media.replace` to adopt a candidate.
Check replacement impact and preserve the existing project revision/identity.
For VFR, preserve the recorded timing in a separately validated encoding
process; do not assume a nominal fps. Existing undo/redo handles adoption.

## Timing assessment clarification

The frame backend now verifies the complete PTS sequence before reporting
stream-wide CFR. The scan is bounded by 50,000 video packets, 30 seconds and
the process-output budget. Hitting a bound returns `unknown`; seconds-to-frame
conversions must not invent exact frame indices in that case. Late VFR changes
after an initially constant section are covered by a real regression fixture.
