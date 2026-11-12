# Color pipeline policy (SDR)

This document states what ReelTerminal actually does to color at every stage —
import, decode, compositing, preview, export, verification — and what it
supports, assumes, and refuses. It is the contract behind the `color` block in
`technicalQuality` analysis results and the matrix-aware `verify.artifact`
comparison options.

## Working space

- **Compositing/preview work in the browser's sRGB canvas space.** All decoded
  frames are converted to RGB by the decode step below before any
  compositing, grading or drawing.
- **Exports are SDR, 8-bit, `yuv420p`, limited range.** 10-bit and HDR are
  explicitly unsupported (see "Out of scope").

## Decode (import / preview / re-import)

- Files **with complete container color tags** (matrix / primaries /
  transfer / range) are decoded honoring those tags. BT.601-tagged, BT.709-tagged,
  full-range and limited-range SDR files all decode correctly, and round-trip
  through export without matrix errors.
- Files **without color tags** are decoded assuming **BT.709 limited** — this
  is mediabunny's Chromium workaround (it fills incomplete decoder-config
  colorSpace with bt709/limited before configuring `VideoDecoder`). If such a
  file was actually encoded with the BT.601 matrix — the swscale/ffmpeg
  default for untagged output, and the common shape of externally
  pre-composited intermediates — saturated reds/blues **will shift on import**.
  ReelTerminal detects and reports this case (see below); it does not silently
  trust it and does not re-label pixels.
- `technicalQuality` analysis reports a `color` block for every file:
  `{facts: {matrix, primaries, transfer, range, pixFmt, bitDepth, source},
  support, notes}` where `support` is one of
  `supported-sdr | unknown-metadata | unsupported-hdr | unsupported-bit-depth |
  unsupported-matrix | unverifiable`. `unknown-metadata` carries the
  "decode assumes BT.709" note; `unverifiable` means ffprobe was unavailable
  and **no color-correctness claim is made**.

## Software rendering

Some CPU YUV-to-RGB implementations approximate the limited-range BT.709 blue
coefficient, shifting saturated colors even when source tags are complete.
ReelTerminal checks the effective conversion with a fixed synthetic pixel when
video decoding is used. Where needed, supported 8-bit YUV frames use the precise
BT.709 matrix before preview, thumbnail or export compositing. The conversion
respects source range and retains visible geometry, alpha, primaries and
transfer metadata; RGB clipping happens after the matrix, including for source
headroom and footroom. Resulting RGB frames are marked full range.
Accurate native conversion keeps its existing path. This correction requires
additional CPU work and does not guarantee real-time high-resolution playback.

It does not infer missing source metadata, preserve HDR/10-bit color or change
the untagged-input policy above.

## Export

Two honest routes, both tagged; pixels and tags always move together — a
metadata re-label is never used to "fix" a pixel conversion.

- **WebCodecs route (default `chromium-webcodecs`)**: Chromium's WebCodecs
  H.264 encoder converts the sRGB RGBA canvas frames with the **BT.601
  matrix** and tags the stream `smpte170m` + limited range (VUI and MP4
  `colr`). `VideoEncoderConfig.colorSpace` is
  **ignored** by this Chromium (`isConfigSupported` strips it), so the
  conversion matrix cannot be changed through the WebCodecs API. Re-tagging
  those bytes as BT.709 would lie about the pixels, so the tag stays
  `smpte170m`. Round-trip inside ReelTerminal and any tag-honoring player is
  correct.
- **ffmpeg frame routes (`chromium-frames-ffmpeg`, desktop sidecar export,
  ffmpeg.wasm fallback)**: we control the RGB→YUV conversion, and pin it to
  **BT.709 limited** with explicit flags
  (`scale=out_color_matrix=bt709:out_range=tv` +
  x264/x265 `colorprim/transfer/colormatrix=bt709` + `-color_range tv`).

### Out of scope (reported, not faked)

- HDR transfers (PQ `smpte2084`, HLG `arib-std-b67`) — not tone-mapped;
  importing one does not preserve its intended look.
- 10-bit+ precision — the pipeline composites and exports 8-bit.
- Exotic matrices outside the SDR set
  (bt709/bt601/smpte170m/bt470bg/smpte240m).

## Verification discipline

Pixel comparisons must never be computed across a guessed matrix:

- `verify.artifact`'s `compare` accepts `colorMatrix` (pinned for both sides)
  or per-side `targetColorMatrix` / `referenceColorMatrix` for mixed-matrix
  comparisons. Every comparison check records which decode matrix was used.
- `verify.artifact`'s probe report exposes the container color tags of the
  artifact (`probe.color`).
- When checking color, compare against a correctly decoded reference.
  Agreement under one shared guessed matrix does not establish accuracy.

## Practical guidance for agents

1. After any external compositing step, encode the intermediate **with
   explicit tags** (`-colorspace/-color_primaries/-color_trc/-color_range`
   or `scale=out_color_matrix=…`), or re-import and let
   `media.analyze_start` (`technicalQuality`) tell you what the container
   actually says before trusting colors.
2. When comparing two videos pixel-wise, read each file's tags (probe.color /
   technicalQuality.color) and pass explicit per-side matrices to
   `verify.artifact` when they differ.
3. Do not conclude "no color difference" from a comparison that decoded both
   sides through one assumed matrix.

## Expected output differences

Chroma subsampling and lossy compression can change individual RGB values even
with correct metadata. Use a correctly decoded reference and check both
representative colors and the final appearance. Matching tags alone do not
prove matching pixel interpretation.
