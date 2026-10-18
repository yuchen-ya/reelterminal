import { readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const AUDIO_ENVIRONMENT_FIELDS = ["python", "separationPython", "senseVoiceModelDir", "speakerModelDir", "demucsCache", "vadModel", "ffmpeg", "ffprobe"] as const;
export type AudioEnvironmentConfig = Partial<Record<typeof AUDIO_ENVIRONMENT_FIELDS[number], string>>;
export function audioEnvironmentPath() {
  return process.env.REELTERMINAL_AUDIO_CONFIG ?? join(homedir(), ".reelterminal", "audio-environment.json");
}
export function validateAudioEnvironment(value: unknown): AudioEnvironmentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Audio environment must be an object");
  for (const [key, path] of Object.entries(value)) {
    if (!(AUDIO_ENVIRONMENT_FIELDS as readonly string[]).includes(key)) throw new Error(`Unknown audio environment field: ${key}`);
    if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) throw new Error(`${key} must be an absolute path`);
  }
  return value as AudioEnvironmentConfig;
}
export function readAudioEnvironment(): AudioEnvironmentConfig {
  let text: string;
  try { text = readFileSync(audioEnvironmentPath(), "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  return validateAudioEnvironment(JSON.parse(text));
}
/** Whole configuration replacement, atomic across app/CLI readers. */
export function writeAudioEnvironment(value: unknown): AudioEnvironmentConfig {
  const config = validateAudioEnvironment(value);
  const destination = audioEnvironmentPath();
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  renameSync(temporary, destination);
  return config;
}
