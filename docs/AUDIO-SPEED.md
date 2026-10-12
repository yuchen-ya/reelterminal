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
  a late older preparation cannot overwrite the newer one.
  Preparations for removed clips are pruned while retained clips can reuse PCM.

The realtime graph exposes `prepareClip(schedule)`. Prepare audible curve clips
before starting the audio clock. `AudioEngine.renderAudio` performs preparation
itself. `startScheduler` accepts an error callback and stops scheduling when a
clip cannot be rendered, instead of continuing with incorrect base-speed audio.

## Explicit capability limits

`pitchCorrection` defaults to true in canonical speed configuration. This build
has no validated pitch-preserving time-stretch DSP. Any audible change from 1x
with pitch correction true **or omitted** fails with
`AUDIO_PITCH_CORRECTION_UNAVAILABLE`. Disable Pitch Correction to use varispeed,
or keep the effective speed at 1x. A constant 1x curve can retain this flag even
if its unused base speed differs from 1. The flag is not silently treated as
false. This replaces the previous misleading behavior that persisted the flag
but ignored it during rendering.

Freeze frames currently define a held **video frame**, not a sound policy.
Audible frozen clips fail with `AUDIO_FREEZE_UNDEFINED`. No DC sample hold,
invented loop or automatic audio silence is substituted. Mute the clip/track,
use media with no audio stream, or remove the freeze to render. Adding silence,
continued source audio, or a loop during a freeze needs a product decision and
matching preview/offline implementation.

Attempting to schedule an unprepared or edited curve fails with
`AUDIO_CURVE_NOT_PREPARED`. The editor displays the playback error and pauses;
offline rendering rejects the unsupported range. Storing/editing a video speed
configuration remains valid even when its audio rendering is unsupported.
Capabilities report these distinctions under
`professionalEditing.speedRamping.details.audioPlayback`.

Muted, hidden, non-solo and zero-volume clips with no positive volume automation
do not block other audible material because of unsupported sound options.
Switching project tracks drops stale solo routing before scheduling.

## Validation boundary

Regression tests include constant and curved speed, source trims, reverse,
start/middle/end positions, chunk continuity, cache revisions, preparation
cancellation, scheduling failures, and anti-alias suppression at 2x and 20x.
Isolated Chromium tests decode synthetic WAV and inspect real
`OfflineAudioContext` PCM against an analytical signal/mapping, including
preview/offline agreement. These verify timing and signal calculations;
they do not certify subjective voice quality, preserved formants, every audio
effect chain, hardware playback, or completed movie exports.

This work does not change TTS generation or previously processed audio files.
It is not evidence that a narration whose clips are all 1x was caused by this
speed-engine defect.
