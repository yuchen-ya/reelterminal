# Web production chunking

ReelTerminal keeps route/component lazy boundaries authoritative and uses
manual chunks only for stable third-party package boundaries. Manual chunking
must not pull a module that is dynamically imported by an engine back into the
startup graph.

## 2026-09-04 evidence

Measured with `pnpm --filter @openreel/web build` from the same working tree:

| Chunk | Before | After | Reason |
|---|---:|---:|---|
| largest application `index` | 2,033.41 kB | 1,566.29 kB | animation and shader vendors no longer mix with app/core code |
| `react` | 293.25 kB | 193.12 kB | package-segment matching no longer captures pnpm peer suffixes such as `_react@...` |
| animation vendor | inside `index` | 338.77 kB | stable gsap/framer/motion cache boundary |
| shader vendor | inside `index` | 165.57 kB | stable Paper shader cache boundary |
| script-view application code | eagerly shared | 6.97 kB, lazy | the closed modal no longer loads its serializer/highlighter UI |
| syntax highlighting | incorrectly in `react` | 42.05 kB, lazy | loaded only when Script View opens |

The main application chunk fell by about 23%. React fell by about 34%.
`mediabunny` (699.30 kB), Three.js (985.37 kB), the Whisper worker (870.77
kB), and its ONNX WASM asset remain intentionally separate runtime assets.
They are large upstream engines, not candidates for arbitrary internal
splitting in application config.

Shader/effect pickers keep their complete accessible catalog, but render
canvas/style previews only as entries approach the scroll viewport. The
EffectsBridge singleton likewise coalesces initialization attempts and backs
off failed best-effort initialization; explicit editor initialization remains
immediately retryable. These runtime changes avoid doing expensive preview or
GPU setup work merely because a picker/store snapshot exists.

An experiment that forced all of `packages/core/src` into one manual chunk was
rejected: Rollup reported that FFmpeg fallback, audio extraction, WebGPU, and
Canvas2D modules were both dynamically and statically captured by that chunk.
That removed useful runtime boundaries, so the rule is not present in the
final config.

## Maintenance rule

Use exact `/node_modules/<package>/` matches. After changing a group, compare
the production table and reject the change if Rollup reports a formerly lazy
engine module becoming static. Prefer a real `lazy(() => import(...))`
component boundary for optional UI; use manual chunks for cacheability, not as
a substitute for lazy loading.
