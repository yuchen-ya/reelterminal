import { tmpdir } from "node:os";
import { join } from "node:path";

// Reproducible default audio environment for this package's tests: point
// audio-environment discovery at an absent isolated path instead of the
// developer's real ~/.reelterminal/audio-environment.json, whose local
// python/ffmpeg/vadModel entries override env-var fixtures and make
// capability probes spawn machine-local interpreters (readAudioEnvironment
// returns {} for a missing file, i.e. the true default environment).
// Tests that exercise real config files stub their own path, as
// audio-environment.test.ts and qwen-environment.test.ts already do.
process.env.REELTERMINAL_AUDIO_CONFIG ??= join(
  tmpdir(),
  "reelterminal-agent-facade-audio-environment.absent.json",
);
