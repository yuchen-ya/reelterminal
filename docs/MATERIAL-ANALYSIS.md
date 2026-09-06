# Material inspection and audio anchors

This increment adds read-only source evidence and local measurements. It does not claim automatic action understanding or Agent listening. No external models, uploads or paid dependencies are used.

## Available endpoints

- `media_import_preflight {path}`: root/regular-file/stat/size check. Live import is still limited to 268435456 bytes because the GUI media slice constructs an ArrayBuffer/File. Node metadata probing already streams with mediabunny. Raising the constant would amplify memory copies; replacing this with a file-backed GUI media source needs a separate persistence/decoder migration. Preflight does not certify codec decodability.
- `media_inspect {mediaId,startSec,endSec,timesSec?,sampleCount?,roi?,width?,expectedRevision?}`: source coordinates, up to 12 timestamps. `timesSec` and `sampleCount` are exclusive. Explicit times must be inside `[startSec,endSec)`. Supply candidate-centered times for dense inspection. `roi:{x,y,width,height}` lies wholly within the normalized source image. Each frame has its full-view artifact and optional region artifact. Chromium crops from source-sized rendering bounded to 4096 pixels on the longest side, then fits the ROI in the output cell; other providers must explicitly advertise region support. Source file stat fingerprint and timeline clip mappings accompany results. Fingerprints are size/mtime versions, not content hashes.
- `media_analyze_start {mediaId,analysisTypes:["audioSummary"],startSec,endSec,expectedRevision?,idempotencyKey?}`: existing asynchronous job interface. Poll `job_status`, cancel `job_cancel`. Source range ≤120 seconds; default is the whole source and fails if too long, rather than silently truncating. At most two analysis jobs per session and four local audio subprocesses per process. Each process has a 60-second deadline and 16MiB combined output budget. Progress reports measurement phases. All inputs remain local and subprocesses use argument arrays without a shell.

`audioSummary` requires FFmpeg with loudnorm and ffprobe on PATH. Capabilities probes their actual availability. It reports original audio stream channel/sample-rate facts, range-relative duration and absolute source times, integrated LUFS, true peak dBTP and loudness range using FFmpeg loudnorm **input** measurements. Silence is measured at −60dBFS for ≥200ms. Null loudness denotes nonfinite/unmeasurable output, including silence.

Waveform levels are bounded to 150 and 600 bins with RMS and peak per bin, using an 8kHz stereo analysis mix and 10ms windows. These peaks are not the original-stream true peak. Energy-rise onsets use a 2.5× preceding-100ms RMS threshold, minimum level/rise and 80ms refractory window. At least five onsets and ≥70% regular adjacent intervals are required for a BPM candidate. Confidence expresses interval consistency, not calibrated perceptual probability. Tempo half/double ambiguity remains. No beat grid or downbeats are fabricated. Events and silence intervals each cap at 256; counts and truncation are explicit. No short-term LUFS curve is implemented yet.

Results are bounded JSON summaries in the existing job result; this increment does not generate large audio artifacts. Analysis snapshots do not change the revision, timeline, selection or playhead. No volume normalization, gain recommendation, ducking or volume automation is claimed.

## Worked API sequence (illustrative source ids)

1. Call capabilities and import preflight; import a file within the declared limit. Run an overview `media_inspect {mediaId:"game",startSec:0,endSec:60,sampleCount:12}`. Record uncertain candidates; absence of an event in this overview is not negative proof.
2. Inspect a candidate: `media_inspect {mediaId:"game",startSec:23.6,endSec:24.4,timesSec:[23.8,23.95,24.05,24.2],roi:{x:0.7,y:0,width:0.3,height:0.25}}`. Inspect both full view and detail. State any unresolved action ownership; no damage/HUD change is automatically a kill.
3. Run `media_analyze_start {mediaId:"music",analysisTypes:["audioSummary"],startSec:0,endSec:60}`; poll its job. Choose an onset only after interpreting its uncertainty and role in the music.
4. Suppose a visual event is estimated at source 24.05s, its clip starts at timeline 8s, inPoint=22s, speed=1.25. It maps to 9.64s. A music onset at source 12.50s in a clip starting at 0s, inPoint=2s, speed=1 maps to 10.50s. Move the video clip start by +0.86s to 8.86s, preserving its action context. Use canonical `edit_validate` then `edit_apply` with `clip.move` and `marker.add` (consult the live schema for trackId/marker fields). For a reversed clip use `(outPoint-source)/speed`. Check the mapped event remains in the visible duration.
5. At 30fps nearest-frame rounding is at most 16.7ms; keep it separate from the example visual estimate (say ±100ms source /1.25) and the detector's 10ms analysis resolution. Resolution is not proven perceptual accuracy. Reinspect timeline frames using `visual_inspect`, then use explicit `editor_control` seek/play/pause for GUI playback. This changes ephemeral playback state. The inspection overlay dismisses during playback. Track solo/mute through canonical `track.update` is an undoable edit, not a read-only audio audition; restore its prior state explicitly.

Current MCP image embedding is bounded (12 images, byte budget). ROI requests embed full/detail pairs, so larger requests can retain additional evidence only as artifact references. Such references do not imply the Agent consumed them. The panel displays the source range and limits; images can be examined individually through their artifacts. It does not yet offer candidate navigation, a private loop player, or A/B audio audition.

## Remaining priorities

1. Private bounded source AV preview with independent loop/seek/frame stepping and explicit host audio/video consumption negotiation; timeline mixed-audio inspection.
2. A public event-alignment operation with independently tracked localization uncertainty; present formulas are returned by source inspection and editing uses existing canonical ops. Nonlinear speed ramps/freeze frames return a null mapping formula.
3. Streaming GUI imports, persisted original/proxy linkage and precise segment offsets; then larger-file import.
4. Native short-term LUFS and better onset/tempo provider (tempo changes and half/double alternatives); semantic event provider only with confidence plus timestamped evidence.
5. Canonical volume automation only after undo, GUI audio preview and export share the same evaluator.

## Executed fixture evidence

`packages/runtime-chromium/src/source-detail.test.ts` generates a 2-second video with a brief white corner detail around 1.000–1.050s and a separate 48kHz mono audio impulse around 1.500s. The uniform overview misses the detail; explicit inspection and ROI confirm it with real decoded pixels. The test analyzes the audio through `media.analyze_start`, takes its measured onset, trims video to 0.2–1.8s, applies speed=2, chooses source 1.020s inside the event frame, and computes clip start `onset − (1.020−0.2)/2` (about 1.090s). It validates/applies the move and marker through the facade and verifies that the rendered timeline frame at the audio anchor contains the detail.

This test exposed and fixed missing canonical SpeedEngine hydration in the Chromium runtime. GUI snapshot restoration and isolated render/export hydration now share `SpeedEngine.loadClips`, including trim-derived source span and stale-state clearing. The automated loop is source evidence → audio measurement → canonical edit → actual rendered-frame verification. GUI bridge/undo and overlay behavior are separately regression-tested; no human listening or running-desktop playback is claimed.

Source inspection remains bounded synchronous rendering (up to 12 times, paired crops); conversion of inspection requests to cancellable queued jobs is still pending. Audio analysis uses the existing cancellable asynchronous jobs today.
