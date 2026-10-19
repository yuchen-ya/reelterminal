import { readFile } from "node:fs/promises";
import {
  readAudioEnvironment,
  writeAudioEnvironment,
  AUDIO_ENVIRONMENT_FIELDS,
} from "@reelterminal/agent-facade/media/audio-environment-config";
import { checkAudioEnvironment } from "@reelterminal/agent-facade/media/audio-environment";
import { transcribeCaptionFile } from "@reelterminal/agent-facade/media/caption-transcription";
import { parseFlags } from "./commands";
import { LiveCliError } from "./client";

export async function runEnvironment(argv: readonly string[]) {
  const action = argv[0];
  const parsed = parseFlags(argv.slice(1));
  if (action === "get")
    return { config: readAudioEnvironment(), fields: AUDIO_ENVIRONMENT_FIELDS };
  if (action === "set") {
    if (!parsed.file)
      throw new LiveCliError(
        "environment set --file config.json (replaces the full application audio configuration)",
        "args",
        2,
      );
    return {
      config: writeAudioEnvironment(
        JSON.parse(
          (await readFile(parsed.file, "utf8")).replace(/^\uFEFF/, ""),
        ),
      ),
    };
  }
  if (action === "check") return checkAudioEnvironment();
  if (action === "test") {
    if (!parsed.file || typeof parsed.flags.duration !== "number")
      throw new LiveCliError(
        "environment test --file speech.wav --duration 30 [--language auto] [--engine qwen|sensevoice] (up to 120 seconds, CPU recognition and word alignment; no project edits)",
        "args",
        2,
      );
    const engine = parsed.flags.engine ?? "qwen";
    if (engine !== "qwen" && engine !== "sensevoice")
      throw new LiveCliError("--engine must be qwen or sensevoice", "args", 2);
    const started = performance.now();
    const segments = await transcribeCaptionFile(
      parsed.file,
      parsed.flags.duration,
      String(parsed.flags.language ?? "auto"),
      new AbortController().signal,
      engine,
    );
    return {
      ready: segments.some((segment) => segment.text.trim()),
      engine,
      device: "cpu",
      timestampSource: "qwen-forced-aligner",
      elapsedSeconds: (performance.now() - started) / 1000,
      segmentCount: segments.length,
      segments,
      acceptance:
        "Actual local transcription and word alignment; no project edited",
    };
  }
  throw new LiveCliError(
    "environment get|set --file config.json|check|test --file speech.wav --duration 5",
    "args",
    2,
  );
}
