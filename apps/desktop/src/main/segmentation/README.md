# MobileSAM CPU segmentation worker

This directory provides one production backend for still images and exact
decoded video frames. It is not yet connected to public IPC/UI. Worker bundling,
model installation and packaged resource resolution belong to their coordinated
owners; the backend accepts absolute worker/encoder/decoder paths. It does not
download models, use Python/WASM at runtime, or offer multiple model backends.

## Caller contract

Create one `PromptableSegmentationBackend` per task with
`{ workerPath, encoderPath, decoderPath }`. Its readonly `promptTokenLimit` is 32.

```ts
await backend.segment({
  frame: { id, revision, width, height, rgba, rotation: 0 },
  refinementId: stableMaskEditingSessionId,
  prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }], box },
}, signal);
```

The service owns authorization and decoding; it must not trust renderer-supplied
paths or pixels. `frame.id` distinguishes task/media/exact-frame identity,
`revision` changes whenever pixels change, and `rotation` is clockwise
0/90/180/270. RGBA is decoded unrotated top-left-origin uint8, alpha ignored;
caller normalizes EXIF mirroring before submission. Keep request objects/pixels
immutable until their promise settles. No pixel hashing is performed.

`refinementId` is **required and stable across clicks in one mask editing
session**. It is not a per-click/latest-request generation ID. Use a new ID on
clear/restart/leave/target change, or explicitly call `resetRefinement()` when
clearing on the same pixels. `resetRefinement()` cancels outstanding work and
clears prior logits while retaining embeddings; `clearCache()` also drops
embeddings. Dispose the task backend when finished.

Points and XYXY box edges are finite `[0,1]` in the **oriented display image**,
independent of viewport zoom/pan. Positive/negative points each consume one user
token; a box consumes two. Accept 1–32 user tokens, explicitly reject excess;
the internal no-box padding token does not consume this cap. No clipping or
silent prompt truncation. Input is bounded to 4096² pixels and maximum side
16384; extremely thin inputs whose official resized short edge rounds to zero
are rejected. The full current prompt set is submitted on each correction.

Result includes `frameId`, `frameRevision`, `refinementId`, oriented `width` and
`height`, binary `alpha` Uint8Array (0/255), `predictedIou`, `candidateIndex`,
`embeddingReused`, `priorMaskUsed`, and worker `timings` in milliseconds
(`loadMs`, `preprocessMs`, `encoderMs`, `decoderMs`, `workerMs`). Predicted IoU is
an uncalibrated model output and may exceed 1; it is not a measured accuracy or
acceptance criterion. Worker timing excludes thread startup/IPC; measure around
`segment()` for the whole backend call.

## Model and exact graph contract

Source/checkpoint is the author's MobileSAM revision
`f706ad9c4eb7f219c00d9050e46328518ffb65d2`:
<https://github.com/ChaoningZhang/MobileSAM/tree/f706ad9c4eb7f219c00d9050e46328518ffb65d2>.
Apache-2.0 license and upstream attribution are retained in
`LICENSE-MobileSAM.txt`. Preserve license/source notices and converted-model
provenance when models are distributed. Weight distribution is not configured
by this directory.

The isolated source-derived FP32 export uses `model.image_encoder` and the
unmodified author's `SamOnnxModel(return_single_mask=False)`, opset17. Checkpoint
is 40,728,226 bytes; encoder 27,969,731 bytes; decoder 16,496,929 bytes.

| Graph | Inputs | Outputs |
| --- | --- | --- |
| Encoder | `images` float32 `[1,3,1024,1024]`, already normalized/padded | `image_embeddings` float32 `[1,256,64,64]` |
| Decoder | `image_embeddings`; `point_coords` float32 `[1,N,2]`; `point_labels` float32 `[1,N]`; `mask_input` float32 `[1,1,256,256]`; `has_mask_input` float32 `[1]`; `orig_im_size` float32 `[H,W]` | `masks` `[1,4,H,W]`; `iou_predictions` `[1,4]`; `low_res_masks` `[1,4,256,256]`, all float32 |

All pixel work runs in the worker using standard TypeScript/typed arrays. No
sharp production dependency is assumed. Rotate, resize the longest side to 1024
with antialiased bilinear RGB uint8 resampling (rounded each separable pass),
normalize using raw RGB mean `[123.675,116.28,103.53]` and std
`[58.395,57.12,57.375]`, then pad bottom/right with **normalized zero**.
Coordinates use rounded resized width/height before padding. This is not
EfficientSAM's square stretch. For points without a box append `(0,0), label=-1`;
box corners follow points with labels 2/3. Labels 0/1 mean background/foreground.

The four outputs are **mask candidates**, not prompt slots. An ambiguous single
point selects highest predicted IoU among candidates 1..3, matching official
`multimask_output=True`; multiclick/box uses candidate0, matching official
`multimask_output=False`. Threshold selected logits at zero. A suitable accepted
prior is the selected raw low-resolution float logits, never the binary mask.

## Scheduling and refinement ownership

CPU sessions load lazily in a Node worker, intra-op threads2/inter-op1. Keep one
active native inference and one latest queued request. Superseded/aborted
promises reject immediately with `AbortError`; already-running native inference
finishes cooperatively, and late masks are discarded. `dispose()` terminates
the worker. Explicit errors are returned; no model fallback or automatic retry.

Worker embedding LRU stores at most two frames/8MiB. Key includes frame ID,
pixel revision, raw dimensions and rotation. Only one active refinement history
is retained. Change frame/source revision/orientation/refinementId, explicit
clear, moving/removing/reordering a point or changing/removing a prior box resets
prior use. Only append-only new points or adding a first box reuse prior logits.
Returning to a previously cached frame can reuse its embedding but not another
frame's refinement history. Accepted plus staged low-res logits add at most
512KiB beyond the embedding cache; native arenas/output tensors are separate.

Only main-process acceptance of the **current sequence and matching frame +
refinementId** ACKs the worker's staged prior. Cancelled/old results or ACKs cannot
publish into a later session. If an outer media-service ownership check rejects
an otherwise returned result, it must reset refinement before continuing that
session. Latest-request IDs and refinement-session IDs remain separate.

## Verification and limits

Run from `apps/desktop`:

```powershell
pnpm exec vitest run src/main/segmentation
```

Pure geometry/cache/refinement/scheduler tests need no model. Optional real tests
skip if local authorized fixtures or weights are absent. Development defaults:
`.cache/mobilesam-validation-2026-11-07/`, with `native-fixtures/manifest.json`,
RGBA inputs and official `.f32` references. Override
`REEL_SEGMENTATION_MODEL_DIR` / `REEL_SEGMENTATION_FIXTURE_DIR` for other existing
development paths. Tests do not download anything. Public photos stay ignored.

Preprocessing parity checks both prior public photos and a rotated upsampling
fixture against offline official torchvision/PIL tensors (tolerance1e-6). The
real CPU smoke uses the actual production RGBA worker, two authorized public
images, two calls per image: initial point then eight-token positive/negative
and box correction using the accepted first result as prior. Point intent and
prior/cache metadata are asserted; saved overlays are separately visually read.
Reports/raw masks live at `.cache/mobilesam-native-smoke/`.

On Windows x64 Ryzen7 9700X, the recorded full `segment()` calls were 571ms cold
for 1072x603 dogs, 33ms cached correction; 455ms for a new 3000x2103 image with
warm sessions, 78ms cached correction. These include worker startup on first
call, RGBA transfer, actual worker preprocessing, inference, threshold and
response; exclude original JPEG decode and visualization. Whole-process RSS
snapshots including test runner/worker ranged521–1071MiB, not peak or model-only
memory. This is a tiny execution/latency sample, not a benchmark or quality rate.

Prior official predictor parity of this same graph/checkpoint passed: encoder
max error3.05e-6, low-res logits5.72e-5, checked binary masks100% agreement. That
establishes conversion parity, not natural-image ground-truth accuracy. The
production worker's native input tensor now independently matches those inputs.
Eight prompt tokens have actual end-to-end evidence; cap32 is an input/resource
bound, not a promise that every sequence gives good segmentation. Fine hair,
matting, video propagation, semantic classes and automatic mask repair are not
provided. Candidate selection/model scores cannot guarantee every user intent.

The backend is ready for the coordinated media-service and package integration;
without IPC/UI integration it is not a completed user-facing feature.
