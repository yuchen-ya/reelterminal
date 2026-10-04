# Browser caption models

The web editor loads local caption models through Transformers.js from the
`openreel` R2 bucket. Two quality tiers are mirrored:

- Fast: `models/onnx-community/whisper-tiny/resolve/main/` (~100 MB)
- Accurate: `models/onnx-community/whisper-large-v3-turbo_timestamped/resolve/main/`
  (~760 MB)

Only tokenizer/config files and the Q4 encoder/merged-decoder ONNX weights are
mirrored. The OpenAI source model cards list different licenses: Whisper Tiny
is Apache-2.0, while Whisper Large V3 Turbo is MIT. The ONNX Community cards
identify these OpenAI base models and the ONNX conversion, but do not provide a
separate license declaration or an immutable source revision for the converted
files. Do not treat the source model cards alone as a complete provenance
record for the bytes mirrored to R2. Before publishing or refreshing the R2
copies, record the exact ONNX Community revisions, source file list, applicable
license texts/notices, and permission/provenance for the conversion and hosted
copies. Model binaries must not be committed to this repository.

R2 objects use long-lived public cache headers. The web worker uses the browser
cache after the first download and prefers WebGPU for the accurate tier, with a
WASM fallback. Publish a versioned prefix and update
`apps/web/src/workers/whisper-models.ts` when replacing the weights.
