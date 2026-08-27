# agent-facade — core Project invariants (Slice 1)

Scope: the in-process facade writes canonical `project.textClips` through the core
`text/create` action applied by `ActionExecutor` to a `structuredClone`'d draft
(`packages/agent-facade/src/session.ts:1-11`, `:402-428`). This doc records, with
file:line evidence, the invariants that plan must respect. All paths are relative to
the repo root. Where behavior is probe-verified rather than read from code, the audit
file is cited.

Every claim below was verified against the working tree on 2026-08-27; two
trim/duration claims were additionally verified by executing the real
`ActionExecutor` under `node --experimental-transform-types`
(audit/probes/adversarial-state.mjs and a one-off probe reusing its loader — see §5).

---

## 1. Canonical TextClip shape

**The interface** (`packages/core/src/text/types.ts:12-36`) — REQUIRED fields:
`id`, `trackId`, `startTime`, `duration`, `text`, `style: TextStyle`,
`transform: Transform`, **`keyframes: Keyframe[]`** (required array,
types.ts:21). Optional: `animation` (:20), `effects` (:23), `blendMode` (:24),
`blendOpacity` (:25), `emphasisAnimation` (:26), `behindSubject` (:27),
`metadata` (:28), `text3d` (:35).

**TextStyle required fields** (types.ts:61-80): `fontFamily`, `fontSize`,
`fontWeight`, `fontStyle`, `color`, `textAlign`, `verticalAlign`, `lineHeight`,
`letterSpacing`; optionals include `backgroundColor`, `strokeColor`,
`strokeWidth`, `shadow*`, `textDecoration`, `shader`.

**Full-shape defaults** (packages/core/src/text/types.ts):
- `DEFAULT_TEXT_STYLE` :193-205 → `{ fontFamily: "Inter", fontSize: 48,
  fontWeight: "bold", fontStyle: "normal", color: "#ffffff",
  strokeColor: "#111827", strokeWidth: 2, textAlign: "center",
  verticalAlign: "middle", lineHeight: 1.2, letterSpacing: 0 }`.
- `DEFAULT_TEXT_TRANSFORM` :207-213 → `{ position: {x:0.5,y:0.5} /*normalized*/,
  scale:{1,1}, rotation:0, anchor:{0.5,0.5}, opacity:1 }`. NOTE: these are
  NORMALIZED 0–1 positions; they are a different semantic from timeline-clip
  transforms, whose default position is `{x:0,y:0}` absolute pixels plus
  `fitMode:"contain"` (action-executor.ts:690-697). Do not mix the two.

**What `titleEngine.createTextClip` defaults vs requires**
(packages/core/src/text/title-engine.ts:16-26, 68-96):
- Requires: `trackId`, `startTime`, `text` (no defaults; CreateTextClipOptions
  title-engine.ts:16-26).
- Defaults: `id` → generated if omitted (:69); `style` = DEFAULT_TEXT_STYLE
  shallow-merged with any partial (:71-74); `transform` = DEFAULT_TEXT_TRANSFORM
  shallow-merged (:76-79); `duration` → `options.duration ?? 5` (:85);
  `keyframes` → always `[]` (:90); `metadata` passed through (:91);
  `animation` optional (:89).

**Id formats used elsewhere for overlay clips:**
- Engine-generated: `` `text-${Date.now()}-${Math.random().toString(36).slice(2,11)}` `` —
  TitleEngine.generateId (title-engine.ts:567-569).
- Duplicates/pastes in the web store: `` `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2,11)}` `` where prefix ∈ {text, shape, svg, sticker}
  (apps/web/src/stores/project/text-graphics-slice.ts:86). Keyframe ids of the
  duplicate get suffixed `${duplicateId}-keyframe-${index}`
  (text-graphics-slice.ts:116-119).
- The core action itself enforces NO format: `text/create` validation only checks
  that `params.clip.id` is a string (packages/core/src/actions/handlers/overlay.ts:44-49),
  then appends `params.clip` verbatim into `project.textClips`
  (overlay.ts:50-53). Handlers registered for text/shape/svg/sticker at
  overlay.ts:135-146.
- Related convention worth honoring: `validateProjectJson` treats clip.mediaId
  values starting with `text-`/`shape-`/`svg-`/`sticker-`/`motion-` as virtual
  clips exempt from media-existence checks (packages/core/src/storage/project-serializer.ts:309-315).

> FLAG (facade plan): the facade's planned path — build the clip and send it via
> `text/create` — bypasses `titleEngine.createTextClip` entirely, so NOTHING in
> the core applies the defaults above. If the facade sends partial `style`/`{}`
> or omits `keyframes`, the action still succeeds (overlay.ts:44-53 accepts it)
> but the shape silently violates TextClip and render degrades later (e.g.
> `ctx.font = "...48px..."` built from style fields at title-engine.ts:463 gets
> an invalid string when fontSize/fontFamily are undefined). The facade MUST
> mint full canonical clips itself (merge DEFAULT_TEXT_STYLE /
> DEFAULT_TEXT_TRANSFORM / duration=5 / keyframes=[]), i.e. replicate
> title-engine.ts:81-92 in the draft builder.

## 2. Hydration precedent (how the web app rebuilds engines)

The single rehydration entry point is
`syncOverlayEnginesFromProject` at
apps/web/src/stores/project/store-helpers.ts:219-268. It:
1. `getTitleEngine()?.loadTextClips(project.textClips ?? [])` (:224).
   `TitleEngine.loadTextClips` clears the internal Map and re-inserts each clip
   keyed by id, storing the object AS-IS (title-engine.ts:577-582) — no
   normalization, no copying.
2. Loads shape/svg/sticker engines from their project arrays (:225-230).
3. Re-primes per-track-clip engine side-state that lives OUTSIDE the Project:
   speed/reverse from `inPoint/outPoint` spans (:231-238), chroma-key settings
   (:239-251), adjustment layers (:252), masks (:253-258), multicam groups
   (:259-261), nested sequences (:262-267).

Call sites of `syncOverlayEnginesFromProject`:
- history-slice undo (:274) and redo (:486) — apps/web/src/stores/project/history-slice.ts;
  exposed to slices via project-store.ts:819 and :2884. I.e. every time the
  authoritative Project moves (undo/redo), engines are RE-HYDRATED from arrays.
Direct `loadTextClips(project.textClips ?? [])` precedents outside the helper:
project load path apps/web/src/stores/project-store.ts:1758, crash-recovery path
:2979, clear-on-new-project `loadTextClips([])` :1725.

Engine creation/init is host-side singleton work: the web engine store creates
and initializes `coreTitleEngine.initialize(1920, 1080)`
(apps/web/src/stores/engine-store.ts:186, repeated inside `initialize()` :231).

**Conclusion:** `TitleEngine` needs nothing but the serialized clips themselves —
`loadTextClips` copies references as-is (title-engine.ts:577-582) and canvas
context is created lazily on first measure/render (wrapText falls back to
`this.initialize()` at title-engine.ts:420-422). So `project.textClips` ALONE is
sufficient to rehydrate the text engine.

BUT `project.textClips` alone is NOT sufficient to make text APPEAR in a rendered
frame. `VideoEngine.getActiveTextClips` filters engine clips by
`timeline.tracks` membership: a text clip renders only if there exists a track
with `type === "text"` and `!hidden` whose `id` equals `clip.trackId`
(packages/core/src/video/video-engine.ts:1764-1776). The web store mirrors this:
createTextClip refuses without an existing track
(text-graphics-slice.ts:210-215). See also G2 in
audit/areas/media-render-e2e.md:242-245 ("Overlay state split-brain … headless
text/shape work silently vanishes at render/export").

Adapter checklist therefore: serialize Project must contain (a) `textClips[]`
entries, (b) matching `type:"text"` tracks under `timeline.tracks`, (c) fonts
available to whatever canvas context renders (host-side concern; renderer only
emits a CSS font shorthand string — title-engine.ts:454-477 — and contains no
FontFace/document.fonts loading logic), (d) engine initialized at target
dimensions before use (engine-store.ts:186 pattern).

## 3. Serialization safety

Non-JSON-safe MediaItem fields (packages/core/src/types/project.ts:53-73):
- `fileHandle: FileSystemFileHandle | null` (:57) — host handle; JSON collapses
  it to `{}`, identity unrecoverable.
- `blob: Blob | null` (:58) — `JSON.stringify(new Blob())` → `"{}"`; the Blob
  survives `structuredClone` in Node ≥18 but never JSON.
- `waveformData: Float32Array | null` (:61) — typed array; `structuredClone`
  round-trips exactly, but `JSON.stringify` flattens it to a sparse-looking
  object `{"0":…,"1":…}` (values coerced to strings), destroying both type and
  numeric fidelity.
- `filmstripThumbnails?: FilmstripThumbnail[]` (:62) — SAFE: plain
  `{timestamp:number,url:string}` records (:76-79); serializer leaves it alone.

How export handles them — `ProjectSerializer.exportToJson` runs
`stripMediaBlobs` (packages/core/src/storage/project-serializer.ts:192-198,
implementation :399-415): every media item becomes
`{ ...item, blob: null, fileHandle: null, waveformData: null }` (:401-406) and
that stripped copy is what gets stringified (:195-197). Reload marks blob-less
items `isPlaceholder: true` with `originalUrl` fallback (:209-220). Consistent
audit finding G4: "Serialized projects carry no media blobs" across processes
(audit/areas/media-render-e2e.md:248-250).

Additional precedent that JSON round-trip is THE sanctioned clone for model data:
web store helpers snapshot overlay clips via `JSON.parse(JSON.stringify(clip))`
(store-helpers.ts:59-60), and ActionExecutor.execute takes its undo-snapshot the
same way (action-executor.ts:98).

**Conclusion (facade-imported MediaItem):** for BOTH
`JSON.parse(JSON.stringify(project))` and `structuredClone(project)` to be
lossless and stable across repeated stringify passes, imported items MUST have
`blob === null`, `fileHandle === null`, `waveformData === null` — exactly the set
stripMediaBlobs nulls (project-serializer.ts:401-406). Bytes stay on disk behind
a path/url (the facade's node-media-adapter already probes local files rather
than holding Blobs). Remaining fields (metadata numbers/strings, thumbnailUrl,
sourceFile, filmstripThumbnails url strings) are plain JSON. Two residual edges:
`Infinity`/`NaN` become `null` in JSON (keep all numerics finite —
calculateProjectDuration guards this too, see §4), and properties explicitly set
to `undefined` are dropped by the first JSON pass (harmless but shapes differ
between structuredClone'd draft and JSON view of it).

> FLAG (facade plan, reinforcing): `ActionExecutor.execute` snapshots the WHOLE
> project with `JSON.parse(JSON.stringify(project))` before applying
> (action-executor.ts:98) purely to generate inverse actions. A draft carrying a
> real Blob or Float32Array would have those degraded inside undo snapshots.
> Keeping non-serializable fields out of the draft makes even that internal
> snapshot lossless.

## 4. timeline.duration invariant — recalculated after EVERY action

`ActionExecutor.applyAction` ends with
`this.recalculateTimelineDuration(project)` on BOTH exit paths: immediately after
any registered custom handler (action-executor.ts:248-255) and after the
built-in prefix dispatch switch (:256-283, comment at :281).
`recalculateTimelineDuration` assigns
`(project.timeline).duration = calculateProjectDuration(project)`
(:285-288). There is no action type that skips it.

`calculateProjectDuration` (packages/core/src/timeline/project-duration.ts:12-33)
scans: `timeline.tracks[].clips` (:18), **`project.textClips` (:19)**,
shapeClips/svgClips/stickerClips (:20-22), adjustmentLayers (:23),
nestedInstances (:24), motionInstances (:25), and timeline subtitles by endTime
(:27-30). `timedEnd` guards non-finite input: NaN/undefined startTime/duration
are treated as 0 and negatives clamped to 0 (:3-9).

Verified against the real executor: running `text/create` with
`{id:"text-999-abc", trackId:"t-text", startTime:0, duration:5, …}` onto an empty
timeline produced `timeline.duration === 5` (probe run, same loader harness as
audit/probes/adversarial-state.mjs). Invariant confirmed: adding a 0–5 s text
overlay to an empty timeline yields duration 5.

Caveat inherited from design: `timeline.duration` is derived-only. Never hand-edit it;
it recomputes underneath you after the next action.

## 5. MEDIA-04 — clip/trim stale-base quirk (~line 788)

The apply case (packages/core/src/actions/action-executor.ts:788-813): for the
matched clip it builds `updates`:
```ts
if (params.inPoint !== undefined) {
  updates.inPoint = params.inPoint;
  updates.duration = clip.outPoint - params.inPoint;      // :799-802 — base outPoint is ORIGINAL
}
if (params.outPoint !== undefined) {
  updates.outPoint = params.outPoint;
  updates.duration = params.outPoint - clip.inPoint;       // :803-806 — base inPoint is STALE
}
return { ...clip, ...updates };                            // :807
```
When BOTH points arrive in ONE action, the second block overwrites `duration`
computed from the PRE-ACTION `clip.inPoint`, so final
`duration = newOut − oldIn` instead of `newOut − newIn`: the error is exactly ΔinPoint.
(The first block's value is dead — overwritten by the second.) Audit evidence:
F9 packages/core/src/actions/action-executor.ts:788-813 "(stale-base bug at
:799-806)" (audit/areas/media-render-e2e.md:71-75); MEDIA-04 severity MEDIUM,
"shifts duration by ΔinPoint" (:269-271); risk-register.csv:42; e2e-contract.md:27
("reproduced in adversarial probe D2"); the probe itself asserts the exact
expected state and FAILS against current code
(audit/probes/adversarial-state.mjs:141-159, check D2 at :153).

Empirical confirmation today (real ActionExecutor, node --experimental-transform-types):

| input clip `{in,out,duration}` | sent | result | expected |
|---|---|---|---|
| `{0, 5, 5}` | ONE action `{inPoint:1, outPoint:3}` | `{1, 3, 3}` | `{1, 3, 2}` (off by ΔinPoint=1) |
| `{0, 6, 6}` | ONE action `{inPoint:0, outPoint:5}` | `{0, 5, 5}` | coincidentally correct (stale oldIn = newIn = 0) |
| `{0, 6, 6}` | TWO actions: `{inPoint:0}` then `{outPoint:5}` | step1 `{0,6,6}` → final `{0,5,5}` | exact |
| `{0, 6, 6}` | TWO actions: `{inPoint:1}` then `{outPoint:5}` | step1 `{0,6,5}` → final `{1,5,4}` | exact |

Arithmetic for the required example `{inPoint:0, outPoint:6, duration:6}` trimmed
to `{0,5}`:

ONE action `{inPoint:0, outPoint:5}`: block 1 sets inPoint=0,
duration = 6 − 0 = 6; block 2 sets outPoint=5, duration = 5 − clip.inPoint(**stale
0**) = 5. Final `{0,5,5}` — right answer ONLY because ΔinPoint = 0 here.

TWO sequential actions (facade policy): `clip/trim{inPoint:0}` applies alone →
inPoint=0, duration = 6−0 = 6, clip `{0,6,6}` unchanged net. Then
`clip/trim{outPoint:5}` reads the COMMITTED fresh clip: outPoint=5,
duration = 5 − 0 = 5 → `{0,5,5}`. Sequential correctness holds generally because
each executor step mutates and recalculates against the live draft
(action-executor.ts:242-283), e.g. `{0,6,6}` → `{inPoint:1}` gives `{1,6,5}`
(duration = 6−1 = 5) → `{outPoint:5}` gives `{1,5,4}` (duration = 5−1 = 4).
Because inPoint-only trims shorten `duration` while leaving `outPoint` fixed, the
two-step order (inPoint first, then outPoint) reproduces any target `{in,out}`
pair exactly.

Validator notes (packages/core/src/actions/action-validator.ts:646-707): in/out
must be non-negative numbers if present (:673-695); the `outPoint > inPoint`
ordering check fires ONLY when BOTH are present in the same action (:696-706) —
single-sided trims are exempt, which is why the facade can legally split the pair
across two actions even though intermediate states may be non-monotonic. Also
known from the same contract row: wrong arg NAMES silently no-op with ok:true
(NF-3, audit/e2e-contract.md:27) — strict boundary validation stays a facade job.

Facade rule derived: NEVER emit inPoint+outPoint in one clip/trim; either trim
one point per action (inPoint first), or pre-normalize so ΔinPoint is provably 0.

## 6. clip/add apply-case defaults (~line 657)

Apply case packages/core/src/actions/action-executor.ts:657-733:
- Track lookup by id; silently does nothing if absent (:676-679, note: validator
  catches missing/locked tracks first, see below).
- `duration` fallback order (:683-689): `params.duration` →
  `mediaItem.metadata.duration` when found AND `> 0` (images/graphics have 0)
  → literal `5`. Verified wording in source comment + code :685-689.
- `defaultTransform` (:690-697): `{position:{x:0,y:0}, scale:{1,1}, rotation:0,
  anchor:{0.5,0.5}, opacity:1, fitMode:"contain"}`; caller transform is
  shallow-merged OVER these if provided (:715-717).
- Id minting: ALWAYS `crypto.randomUUID()` inside the apply case — both for the
  `sourceClip` clone path (:701) and the fresh-clip path (:706). Callers cannot
  supply an id; `this.lastAddedIds.set("clip", newClip.id)` records it (:730,
  "__LAST_ADDED__" substitution mechanism :230-239).
- Other defaults: `inPoint ?? 0` (:711), `outPoint ?? clipDuration` (:712),
  `effects ?? []` (:713), `audioEffects ?? []` (:714), `volume ?? 1` (:718),
  `keyframes ?? []` (:719), `fade`/`speed`/`reversed`/`audioTrackIndex` present
  only if supplied (:720-727).

Validator case packages/core/src/actions/action-validator.ts:494-551 checks ONLY:
trackId is a string and the track EXISTS (:495-509) and is not locked (:512-518);
mediaId is a string and EXISTS in mediaLibrary (:520-540); startTime is a number
≥ 0 (:541-550). **There is NO overlap/collision validation whatsoever** — two
clips may occupy identical [startTime, startTime+duration] windows on one track.
Overlap policy is entirely upstream; the facade adds none unless desired (core is
permissive by design).

> FLAG (facade plan idempotency): because ids are minted INSIDE core apply, a
> retried batch cannot collide-dedupe on content — it will simply create a second
> clip. At-most-once semantics must come from the facade's idempotency ledger +
> `createdIds` diffing (session.ts documents this pattern at
> packages/agent-facade/src/session.ts:345-369), not from the action layer.

## 7. track/add behavior

Apply case packages/core/src/actions/action-executor.ts:420-461:
- Naming: `<TypeLabel> <countOfSameTypeTracks + 1>` with labels video→"Video",
  audio→"Audio", image→"Image", text→"Text", graphics→"Graphics"
  (:426-440). Names are NOT uniqueness-enforced; a second add produces the same
  display name if no other same-type track was added in between.
- Position semantics: `params.position` = insertion INDEX into
  `timeline.tracks`; default `timeline.tracks.length` (append at end)
  (:449-458). Insertion clamps are absent (slices beyond length behave as append
  because of how slice/splice-at-position is written :454-458).
- trackId override accepted: `id: params.trackId ?? `track-${crypto.randomUUID()}``
  (:438). lastAddedIds records "track" (:459).
- Duplicate trackIds are rejected NOWHERE:
  - Validator case (action-validator.ts:241-265) validates only `trackType` ∈
    {"video","audio","image","text","graphics"} (:242-253) and
    `position` being a non-negative number when present (:254-264). No
    uniqueness check, no format constraint on an explicit `trackId`.
  - Apply path (:420-461) inserts unconditionally; sending the same explicit
    trackId twice yields TWO tracks sharing one id. For a text track this
    directly poisons rendering lookups such as video-engine.ts:1764-1776 (the
    filter tests membership in a Set of text-track ids, duplicated id just
    matches — still renders, but every per-id mutation like track/remove or
    locked toggles hits both duplicates), and breaks facade "re-send =
    no-op/idempotent" expectations.

> FLAG (facade plan idempotency): explicit stable trackIds are fine and even
> desirable (deterministic replay target for text/clips), but the FACADE must own
> dedupe: before issuing track/add with an explicit id, check the draft already
> lacks a track with that id; treat "exists" as success for retries. Neither core
> layer does it.

Related silent-no-op hazard (same family): unknown action types under KNOWN
prefixes validate-and-apply as success with zero state change
(probe G1/G2 in audit/probes/adversarial-state.mjs:187-197, e2e-contract rows in
audit/e2e-contract.md) — the facade's closed-schema op validation is the only
guard (implemented at packages/agent-facade/src/validate.ts / ops.ts per
session.ts:37-39 contract).

## 8. Render-adapter seam requirements — Slice 1b, OUT OF SCOPE FOR SLICE 1

Minimum a Chromium adapter must do to produce text pixels from a serialized
Project: construct/host the singletons (or equivalents) and hydrate BEFORE any
render/export call — instantiate TitleEngine sized to project.settings via
`initialize(width,height)` (mirror engine-store.ts:186; lazy init exists at
title-engine.ts:420-422 but not for the top-level surface) and feed it
`loadTextClips(project.textClips ?? [])` exactly as store-helpers.ts:224 and
project-store.ts:1758 do, since `export-engine.calculateTimelineDuration` and
`video-engine.getActiveTextClips` read ENGINE state, never project.textClips
directly (export-engine.ts:1211; video-engine.ts:1764-1776) — the split-brain G2
gap in audit/areas/media-render-e2e.md:242-245; guarantee every textClip.trackId
resolves to a non-hidden `type:"text"` entry in timeline.tracks (hard filter,
video-engine.ts:1769-1772); make families named by each clip's
`style.fontFamily` resolvable through document.fonts/FontFace before frame N —
the renderer only composes a CSS font shorthand (title-engine.ts:463) and has no
font-loading logic; then per frame t, for active clips call
renderText(title-engine.ts) via video-engine.ts:1826-1848 which rasterizes to an
OffscreenCanvas, applies effects (:1841-1847), and composites by transform.
Remember serialized projects carry NO blobs (G4,
media-render-e2e.md:248-250), so media pixels need an external byte source keyed
by MediaItem path/sourceFile — placeholder items are `isPlaceholder:true` on
reload by construction (project-serializer.ts:209-220). Frame-length correctness
for text-only projects depends on this hydration because the legacy export gate
counts engine overlays only (export-engine.ts:196-210/:429 raise "Timeline is
empty" otherwise).

---

## Facade MUST / MUST NOT (Slice 1 checklist)

MUST:
1. Build FULL canonical TextClips itself (merge DEFAULT_TEXT_STYLE,
   DEFAULT_TEXT_TRANSFORM, duration=5 fallback, keyframes=[]) — core
   `text/create` performs zero normalization (overlay.ts:44-53).
2. Create/verify a `type:"text"` track exists in timeline.tracks with the same id
   as every textClip.trackId (video-engine.ts:1764-1776).
3. Split every trim into ≤1 point per action, inPoint before outPoint — exact
   `duration = outPoint − inPoint` verified (§5; MEDIA-04).
4. Keep blob/fileHandle/waveformData strictly null on imported MediaItems (=
   stripMediaBlobs set, project-serializer.ts:399-415) so JSON.stringify and
   structuredClone round-trip identically (§3).
5. Treat every action result as success:false ⇒ discard the whole draft —
   ActionExecutor mutates in place with NO internal rollback on throw
   (action-executor.ts:104-118); swap-on-all-success is the only safe lane.
6. Own idempotency: ledger/dedupe for trackId reuse and batch retries — neither
   validator nor apply rejects duplicate trackIds, and clip ids are minted
   unpredictably inside core (crypto.randomUUID, action-executor.ts:701/:706).
7. Strict-validate arg names/op types at the boundary; core reports
   wrong-name/unknown-prefix mutations as ok:true silent no-ops
   (adversarial-state.mjs A2/G1-G2; e2e-contract.md NF-3).

MUST NOT:
8. Rely on core to default anything in `text/create` params (see #1) or assume
   titleEngine.createTextClip runs on the headless path — it doesn't.
9. Send inPoint and outPoint together in one clip/trim (stale-base duration bug,
   action-executor.ts:799-806; adversarial probe D2 fails).
10. Emit outPoint < inPoint in a single-action trim payload (validator rejects
    when both present: action-validator.ts:696-706); per-action single-point
    order rules obviate it anyway.
11. Trust `timeline.duration` as authored state or write it manually — it is
    recomputed from scratch after EVERY action via calculateProjectDuration
    (action-executor.ts:253/:281-288; includes textClips, project-duration.ts:19).
12. Assume overlaps are prevented anywhere in core — clip/add validator checks
    only track existence/lock, media existence, startTime ≥ 0
    (action-validator.ts:494-551); overlap prevention (if wanted) is facade
    policy on the draft.

---

## Facade lifecycle & boundary rules (Slice 1 merge hardening)

Facade-side contracts added on 2026-08-27 (ADR 0001 addendum); these are
facade invariants, not core behavior:

13. `project.create` is a SINGLE-INITIALIZATION lifecycle verb outside the
    revision machinery (no `expectedRevision`). First create succeeds;
    same `idempotencyKey` + same payload replays the committed creation
    result (`replayed: true`) without resetting the project; same key +
    different payload, or any other create with a project open, fails
    CONFLICT. No replace/reset exists in Slice 1
    (packages/agent-facade/src/session.ts `projectCreate`).
14. Capability reporting is adapter-independent in this slice: an injected
    `ProjectRenderAdapter` is dormant (no verb calls it), so
    `capabilities.get` reports preview/export unavailable regardless
    (packages/agent-facade/src/capabilities.ts, src/render/adapter.ts).
15. Media probing MUST stream: mediabunny `FilePathSource` + explicit
    `Input.dispose()`, `fileSize` from `stat` — never a whole-file
    `readFile` buffer (packages/agent-facade/src/media/node-media-adapter.ts).
16. Project settings are hardened: `width`/`height`/`sampleRate`/`channels`
    positive integers, `frameRate` a positive finite number; and for BOTH
    `project.create params.settings` and `text.create` `style`, only the
    sanitized `validateObject` copies flow downstream — never the raw
    nested caller objects (src/session.ts PROJECT_SETTINGS_SCHEMA,
    src/ops.ts validateEditOp text.create).
