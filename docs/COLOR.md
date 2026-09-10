# Color pipeline policy (SDR)

This document states what ReelTerminal actually does to color at every stage —
import, decode, compositing, preview, export, verification — and what it
supports, assumes, and refuses. It is the contract behind the `color` block in
`technicalQuality` analysis results and the matrix-aware `verify.artifact`
comparison options. Everything below was verified empirically against the
shipping Chromium (regression: `packages/runtime-chromium/src/color-pipeline.test.ts`).

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

## Export

Two honest routes, both tagged; pixels and tags always move together — a
metadata re-label is never used to "fix" a pixel conversion.

- **WebCodecs route (default `chromium-webcodecs`)**: Chromium's WebCodecs
  H.264 encoder converts the sRGB RGBA canvas frames with the **BT.601
  matrix** and tags the stream `smpte170m` + limited range (VUI and MP4
  `colr`). This was verified directly: `VideoEncoderConfig.colorSpace` is
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
  Historically these routes converted through swscale's default BT.601 matrix
  and wrote **no VUI at all**, leaving every downstream player to guess — a
  real pixel + metadata double error on saturated colors.

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
- The regression suite decodes the same export through the correct and a
  wrong matrix and asserts the wrong one measurably diverges — matrix-blind
  similarity checks cannot creep back in unnoticed.

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

## Tolerances used by the regression suite

One encode hop (yuv420 chroma subsampling + CRF 18) on the deterministic
bar/skin-tone pattern: mean |Δ| ≤ 8 (0–255 RGB) per hop; import→preview→export
→re-import across two hops ≤ 10. The BT.601↔BT.709 matrix error on the same
pattern is ≥ 4 mean |Δ| and must exceed the correct-matrix error by > 2 —
an order of separation that keeps honest encodes green and matrix bugs red.
