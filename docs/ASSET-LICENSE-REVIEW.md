# Asset, font, and model rights review

Checked 2026-10-04 against the source checkout and the resource URLs used by the applications.

## Local release update

The local-first release removes the sample catalog, the private Whisper mirror
and the default vidstab CDN. Studio accepts user-imported footage; Whisper
loads the same ONNX Community repositories directly through Transformers.js;
vidstab stays unavailable unless a deployment supplies its own core. Those
retired private resources are not shipped or downloaded by default.

The previous inspection below is retained as an audit record, not a claim that
these discontinued resources remain release requirements. The public
FFmpeg.wasm core still needs artifact-specific license/source review. Font
notice mappings remain unchanged; model downloads remain network-dependent.

## Historical findings before local-first changes

The checked-in application marks and fonts have traceable terms. The runtime models served directly by Google and IMG.LY also have license evidence in their upstream model cards or package metadata. This review does **not** clear release while three externally hosted resource groups remain without artifact-level rights records:

1. The four Studio sample videos served from the OpenReel CDN have no source or subject-release records in this repository.
2. The Whisper ONNX files mirrored to OpenReel R2 have no recorded source revision, conversion-license record, or copy-by-copy mapping. The existing note incorrectly says both source models are Apache-2.0.
3. The FFmpeg and vidstab WebAssembly cores loaded at runtime do not have an artifact-specific source/build/license record here. The native FFmpeg sidecar review does not cover these browser cores.

These are evidence gaps, not findings that the assets are necessarily unlicensed. Resolve them before publishing the affected assets or enabling their download paths in a release. The broader npm dependency review remains in [desktop release readiness](../apps/desktop/LICENSES/RELEASE-READINESS.md); it is outside this review except where a specific package is downloaded as a runtime asset.

## Checked-in artwork and fonts

| Asset | Location and delivery | Rights evidence and result |
|---|---|---|
| ReelTerminal mark and app icons | `apps/desktop/build/icon.svg`, `apps/desktop/build/icon.png`, `apps/{image,studio,web}/public/favicon.svg`, and `apps/web/public/icons/*.png`. The SVGs are the same simple mark; the PNG files are the raster app/PWA variants. | No third-party artwork source is referenced in the files or app manifests. They are maintained in this repository under the project MIT license in [LICENSE](../LICENSE); no separate asset restriction was found. |
| Interface icon glyphs | Rendered from `lucide-react` imports in the apps; icons are code components, not separate checked-in image files. | The desktop generated dependency notices contain the Lucide attribution and license. Package-level closure is part of the existing npm review. |
| Google Fonts bundled with the web renderer | `apps/web/public/fonts/google-fonts.css` references 56 families and 264 WOFF2 files. The renderer is built from these local files; desktop packaging includes the renderer output and its font license directory. | [`licenses/manifest.json`](../apps/web/public/fonts/licenses/manifest.json) maps all 56 families to upstream Google Fonts directories, copyright notices, and license texts. A local inventory check found all 264 WOFF2 files mapped and present, and every referenced license file present. The mapped terms are OFL, Apache-2.0, and Ubuntu Font Licence 1.0. Upstream paths currently use the Google Fonts `main` branch rather than immutable commits; the checked-in license texts and file map remain available with the assets. |
| Helvetiker 3D typefaces | `apps/web/public/fonts/helvetiker_{regular,bold}.typeface.json`; included with the renderer. The core 3D renderer also fetches the bold default from `https://threejs.org/examples/fonts/helvetiker_bold.typeface.json`. | The local manifest records the Three.js examples source and the MgOpen license embedded in the font metadata. The complete Magenta/MgOpen license text is present at [`licenses/helvetiker/LICENSE.txt`](../apps/web/public/fonts/licenses/helvetiker/LICENSE.txt). Its terms allow inclusion in a larger software package, require the notice with copies, and prohibit selling the font by itself. |
| Google Fonts loaded remotely by Image and Studio | `apps/image/index.html` requests 14 Google Fonts families; `apps/studio/index.html` requests Geist and Geist Mono. The browser fetches the stylesheet and font files from Google rather than receiving local font files from these two apps. | These families are also mapped in the checked-in Google Fonts manifest with local license texts. The font CSS/API response is not pinned to an immutable font revision. No separate redistribution by ReelTerminal was found for these two apps. |
| User-selected fonts | The desktop font upload flow stores user-selected font files locally. | These are user-provided resources and are not bundled with the application or hosted as product assets. This review does not claim rights in user files. |

## Runtime models and media cores

| Resource | Runtime source and actual path | Rights evidence and remaining action |
|---|---|---|
| MediaPipe Face Landmarker and selfie segmentation models | `apps/studio/src/effect/preview/DetectorPool.ts` downloads `face_landmarker/.../float16/1/face_landmarker.task` and `selfie_segmenter/.../float16/1/selfie_segmenter.tflite` from `storage.googleapis.com`. `packages/core/src/ai/person-segmentation-worker.ts` downloads `selfie_multiclass_256x256/.../latest/...tflite` and a `selfie_segmenter/.../latest/...tflite` fallback. | Google's official Face Detector, Face Mesh V2, Blendshape V2, Selfie Segmentation, and Multiclass Segmentation model cards each identify Apache License 2.0. The model files are served by Google rather than checked into or mirrored by this repository. The Studio URLs pin version `1`; the shared core segmentation URLs use mutable `latest` aliases. Sources: [Face Landmarker guide and model cards](https://developers.google.com/edge/mediapipe/solutions/vision/face_landmarker), [Selfie Segmentation model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20MediaPipe%20Selfie%20Segmentation.pdf), and [Multiclass Segmentation model card](https://storage.googleapis.com/mediapipe-assets/Model%20Card%20Multiclass%20Segmentation.pdf). |
| MediaPipe runtime code and WASM | `@mediapipe/tasks-vision@0.10.35` is loaded from jsDelivr and unpkg in the Studio and segmentation-worker paths. | This is the exact runtime package/CDN path, separate from the model-weight records above. Its package notice is present in the generated desktop dependency-license file; the full dependency closure is covered by the linked npm review. |
| IMG.LY background-removal model | `apps/image/src/services/background-removal-service.ts` calls `@imgly/background-removal@1.7.0` without overriding `publicPath`. Its default fetch uses `https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist/`; the default model is `isnet_fp16`. | The versioned [IMG.LY package release](https://www.npmjs.com/package/%40imgly/background-removal/v/1.7.0) documents first-use downloads and the default asset host. Its packaged `ThirdPartyLicenses.json` identifies the ISNET model as MIT-licensed and links the source project. The model files are served by IMG.LY, not checked into or mirrored by this repository. |
| Whisper Tiny and Large V3 Turbo ONNX weights | `apps/web/src/workers/whisper-worker.ts` downloads files from `https://media.openreel.video/models/` using a `{model}/resolve/{revision}/` template; the app does not pass an immutable revision override. The retired R2 mirror used paths under `main`; its deployment instructions have been removed. | The OpenAI source model card lists Apache-2.0 for [Whisper Tiny](https://huggingface.co/openai/whisper-tiny) and MIT for [Whisper Large V3 Turbo](https://huggingface.co/openai/whisper-large-v3-turbo). The [ONNX Community Tiny](https://huggingface.co/onnx-community/whisper-tiny) and [Large V3 Turbo](https://huggingface.co/onnx-community/whisper-large-v3-turbo_timestamped) cards identify their OpenAI base models and ONNX conversion, but do not provide a separate artifact license or an immutable source revision. This repository does not map its R2 objects to a specific ONNX Community revision or record the corresponding license/permission for the hosted copies. Record that source-to-copy chain, applicable license texts/notices, and an immutable model revision; use the corrected per-model source licenses rather than the previous blanket Apache-2.0 statement before releasing the mirror. |
| FFmpeg.wasm fallback core | `packages/core/src/media/ffmpeg-fallback.ts` fetches `https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm/{ffmpeg-core.js,ffmpeg-core.wasm}` on first use. | The published [0.12.6 package metadata](https://app.unpkg.com/%40ffmpeg/core%400.12.6/files/package.json) says MIT, while the [FFmpeg.wasm upstream project](https://github.com/ffmpegwasm/ffmpeg.wasm) says the compiled core follows the licenses of FFmpeg and the external libraries it contains. The repository records the URL but not the exact core build configuration, enabled codecs/libraries, or corresponding source materials, so the package metadata alone does not establish the license of this exact binary. Record the artifact's build profile and applicable notices/source location; if the core is mirrored or redistributed by ReelTerminal, satisfy the source/notice terms for the actual build. The existing [FFmpeg sidecar review](../apps/desktop/LICENSES/FFMPEG.md) covers native sidecars and explicitly excludes them from packages; it does not close this browser-core record. |
| vidstab WebAssembly cores | `packages/core/src/media/media-cdn-config.ts` points to `https://mediashares.openreel.video/ffmpeg-vidstab/mt` and `/st`; `packages/core/src/video/stabilization/vidstab-engine.ts` fetches `ffmpeg-core.js`, `ffmpeg-core.wasm`, and, for the multithreaded build, `ffmpeg-core.worker.js` on first use. | These are first-party-hosted downloadable binaries, but the repository has no matching source revision, build configuration, dependency/codec list, or license/notice mapping for either core. The [vid.stab upstream](https://github.com/georgmartius/vid.stab) says the current project is LGPL-2.1-or-later and releases through v1.1.2 were GPL; the actual bundled version and FFmpeg build flags are unknown here. The complete FFmpeg core's terms depend on the compiled components, so do not infer a license from the feature name or from current upstream alone. Record each artifact's version, build profile, applicable notices, and corresponding source access before continuing to serve these binaries with a release. |

## Studio sample clips

[`apps/studio/public/samples/index.json`](../apps/studio/public/samples/index.json) lists these videos under relative `/samples/` URLs. [`apps/studio/public/samples/README.md`](../apps/studio/public/samples/README.md) says production serves them from `https://cdn.openreel.video/samples/`; the MP4 files themselves are not present in this checkout.

| ID | Catalog label | Rights evidence in repository |
|---|---|---|
| `portrait-closeup-01` | Portrait close-up | No file, source, license, or subject release recorded. |
| `portrait-midshot-02` | Portrait mid-shot | No file, source, license, or subject release recorded. |
| `body-fullshot-03` | Full body | No file, source, license, or subject release recorded. |
| `outdoor-landscape-05` | Outdoor landscape | No file, source, or license recorded. |

The private CDN location alone does not establish permission to use the footage. Before these samples are served with the product, add per-clip provenance and a rights record covering commercial display/hosting and any applicable attribution or time/territory limits. For recognizable people, retain the appropriate appearance releases/consents. If those records cannot be produced, remove the affected clips from the catalog and CDN before release.

## Records checked

- [Third-party notices](../THIRD_PARTY_NOTICES.md) and [font manifest](../apps/web/public/fonts/licenses/manifest.json).
- Runtime URL and call-site checks in `apps/web`, `apps/studio`, `apps/image`, and `packages/core`.
- Read-only consistency check: every one of the 264 WOFF2 files was covered by the font manifest, with no missing font files or license texts.
- Existing JavaScript dependency conclusions are not repeated here; see [desktop release readiness](../apps/desktop/LICENSES/RELEASE-READINESS.md).
