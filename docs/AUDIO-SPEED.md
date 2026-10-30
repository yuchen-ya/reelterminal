# Audio speed rendering

Preview and offline audio rendering use the canonical `SpeedEngine` source-time
mapping. Clip `inPoint`/`outPoint` and speed keyframe times are source seconds;
clip offsets, duration, fades and volume automation are playback seconds.
Keyframes replace base speed, including a base speed that differs from every
keyframe. Reverse reflects the moving source offset across the trimmed span.

## Supported audio

- Constant speed and reverse consume the correct source span, including seek,
  pause/resume and partial offline render ranges. A completed source is not
  rescheduled within the same playback pass.
- With `pitchCorrection` enabled (the default `true` or omitted), constant speed
  (including constant-valued speed keyframes) preserves pitch using Signalsmith
  Stretch WASM. Browser preview prepares stretched PCM in a Web Worker to keep
  the UI responsive; Node/offline rendering uses the same WASM directly, and
  both preview and export consume the same prepared PCM. Set
  `pitchCorrection: false` explicitly to use native varispeed.
- With `pitchCorrection: false`, speed curves use shared, asynchronously prepared
  PCM in preview and offline rendering. A windowed-sinc resampler applies a
  rate-dependent low-pass filter before accelerated resampling. This is
  **varispeed**: pitch changes with speed.
- Preparation uses the `SpeedEngine` integral and inverse directly. The result
  plays at 1x; the scheduler must not apply the original speed a second time.
  Prepared duration includes exactly the moving playback interval, with the
  final buffer frame rounded up and playback stopped at the clip boundary.
- Cache identity includes source buffer, clip identity, trim, reverse, keyframes
  and pitch/freeze configuration. An edit invalidates the prior configuration;
  a late older preparation cannot overwrite the newer one, and a failed
  preparation or WASM/worker initialization releases its cache entry so a later
  call can retry. Preparations for removed clips are pruned while retained clips
  can reuse PCM.

The realtime graph exposes `prepareClip(schedule)`. Prepare audible curve clips
and non-1x pitch-preserving clips before starting the audio clock.
`AudioEngine.renderAudio` performs preparation itself. `startScheduler` accepts
an error callback and stops scheduling when a clip cannot be rendered, instead
of continuing with incorrect base-speed audio.

## Explicit capability limits

`pitchCorrection` defaults to true in canonical speed configuration. Constant
speeds (including keyframes whose speeds are all equal) support pitch
preservation via Signalsmith Stretch WASM. Varying speed curves with pitch
correction true **or omitted** fail with `AUDIO_PITCH_CORRECTION_UNAVAILABLE`:
use constant speed, or explicitly set `pitchCorrection: false` to use varispeed
for a curve. The flag is never silently treated as false.

Freeze frames currently define a held **video frame**, not a sound policy.
Audible frozen clips fail with `AUDIO_FREEZE_UNDEFINED`. No DC sample hold,
invented loop or automatic audio silence is substituted. Mute the clip/track,
use media with no audio stream, or remove the freeze to render. Adding silence,
continued source audio, or a loop during a freeze needs a product decision and
matching preview/offline implementation.

Attempting to schedule an unprepared or edited clip fails with
`AUDIO_CURVE_NOT_PREPARED` (for speed curves) or `AUDIO_SPEED_NOT_PREPARED` (for
pitch-preserving constant speed). The editor displays the playback error and
pauses; offline rendering rejects the unsupported range. Storing/editing a video
speed configuration remains valid even when its audio rendering is unsupported.
Capabilities report these distinctions under
`professionalEditing.speedRamping.details.audioPlayback`.

Muted, hidden, non-solo and zero-volume clips with no positive volume automation
do not block other audible material because of unsupported sound options.
Switching project tracks drops stale solo routing before scheduling.

## Validation boundary

Regression tests include constant pitch-preserving and varispeed playback, curved
speed, source trims, reverse, start/middle/end positions, chunk continuity,
cache revisions, preparation cancellation, failed-cache retry, scheduling
failures, and anti-alias suppression at 2x and 20x. Isolated Chromium tests
decode synthetic WAV and inspect real `OfflineAudioContext` PCM against an
analytical signal/mapping, including preview/offline agreement. These verify
timing and signal calculations; they do not certify subjective voice quality,
preserved formants, every audio effect chain, hardware playback, or completed
movie exports.

This work does not change TTS generation or previously processed audio files.
It is not evidence that a narration whose clips are all 1x was caused by this
speed-engine defect.
