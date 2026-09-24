# ADR 0009: Playback presents through one composeFrame contract

**Status:** Accepted

## Context

Preview playback and the paused renderer were two unrelated machines. Paused
scrubbing ran `renderFrameDirectly`, which resolves transitions by decoding both
sides and blending them. Live playback instead ran hand-rolled realtime loops
(`drawFrame` for native `<video>` elements, `processMultiTrackFrame` for the
MediaBunny path) plus a fourth producer in `PlaybackController` that composited
a full frame per clock tick into a canvas nobody displays
(`setDisplayCanvas` has no callers).

Two user-visible failures fell out of this split:

1. **Transitions disappear during playback.** Each playback loop carries the
   blend only as a best-effort special case. Any miss — image clips with no
   MediaBunny resources, both sides of a transition aliasing one cached
   `<video>` element (cache keyed by `mediaId`), a decode failure — silently
   fell back to drawing the single active clip or to `progress < 0.5 ? A : B`.
   Because a transition window straddles the cut, that fallback is exactly a
   hard cut.
2. **Playback freezes while time keeps running.** The displayed timecode and
   audio come from `MasterTimelineClock` (an AudioContext wall clock with its
   own rAF loop), independent of the canvas loops. An await that never settles
   (typically `CanvasSink.getCanvas`, which has no timeout and spins up a fresh
   decoder per call) pins the loop's `isProcessingFrame` latch forever; an
   uncaught rejection in `drawFrame` killed its rAF chain silently. In both
   cases the picture freezes with no watchdog, no recovery, and no log, while
   the clock and audio advance.

The industry-standard shape for this problem is a clock-driven pull compositor
(MLT's consumer/producer queue, Blender VSE's audio-master + frame-drop policy,
Remotion Player's "the player renders the same frame as the renderer"): one
`composeFrame(t)` function, frame sourcing with deadlines, and a presentation
loop that drops or repeats frames instead of ever blocking on decode. This
repository already has the pieces — `VideoEngine.renderFrame` is that function
for export, and `MasterTimelineClock` is the right master clock.

## Decision

1. **One frame contract.** `composeFrame(project, t)` (today:
   `VideoEngine.renderFrame`) is the single definition of what the timeline
   looks like at time `t`. Every realtime path is either a fast path of this
   contract or must visibly degrade; no path may show a different result from
   export for the same `t`. (Full convergence of the four renderers is staged
   work; this ADR fixes the contract so later changes have a target.)
2. **Frame sourcing is bounded.** Every frame fetch (`CanvasSink.getCanvas`,
   transition decode, image decode) runs under a deadline
   (`DECODE_TIMEOUT_MS`, 1500 ms). On timeout the loop repeats the last good
   frame or degrades the transition — it never blocks indefinitely and never
   silently hard-cuts without a warning.
3. **Transitions blend the same way in every mode.** Both sides are decoded as
   independent sources (dedicated cache entries when clips share a media id),
   and image clips participate via `createImageBitmap`. Hard-cut fallback
   remains as the last resort but is logged once per transition and reason
   (`warnTransitionFallbackOnce`).
4. **Presentation loops are crash-only with a watchdog.** Loop bodies run under
   an exception guard that reschedules instead of dying; a heartbeat marks each
   presented frame. While the clock is playing, 2 s without a presented frame
   tears down and rebuilds the playback pipeline at the live playhead (max
   three automatic restarts per run, then pause).
5. **The clock never renders.** `PlaybackController` reports clock time for
   drift pacing but does not composite frames during playback; presentation
   belongs to the preview renderer. (The per-tick `renderFrameAtTime` call was
   removed; the method remains for scrub.)

## Consequences

- The "transition visible when paused but not during playback" class of bug is
  closed at its cause (dual renderers with silent hard-cut fallbacks) rather
  than case by case; remaining divergence points at the shared warning log.
- A wedged hardware decoder now costs at most one repeated frame and a console
  warning, and a hard-wedged loop recovers by itself instead of freezing the
  session.
- Playback costs less: one fewer full composite per clock tick.
- Staged follow-up, per this contract: converge `drawFrame`,
  `processMultiTrackFrame`, `renderFrameDirectly` and the export renderer onto
  one pull-model compositor with per-source `getFrame(t, deadline)` and an
  explicit drop-frame policy, and retire the `isProcessingFrame` latch in favor
  of deadline-driven scheduling. The frame cache duplication between
  `packages/core/src/video/frame-cache.ts` (currently zero consumers) and
  `apps/web/src/bridges/render-bridge.ts` should be resolved in the same pass.
