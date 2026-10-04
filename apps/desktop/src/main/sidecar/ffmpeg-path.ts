import path from "node:path";
import { app } from "electron";
import { existsSync } from "node:fs";

export function ffmpegRelativePath(platform: NodeJS.Platform, arch: string): string {
  const dir = `${platform}-${arch}`;
  const bin = platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  return `${dir}/${bin}`;
}

export function resolveFfmpegPath(): string {
  const configured = process.env.REELTERMINAL_FFMPEG_PATH;
  if (configured) return configured;
  if (app.isPackaged) return "ffmpeg";
  const rel = ffmpegRelativePath(process.platform, process.arch);
  const base = path.join(__dirname, "../../resources/bin");
  const local = path.join(base, rel);
  // Distributed packages use a user-provided binary. A local development
  // fetch remains available without putting GPL sidecars in release assets.
  return existsSync(local) ? local : "ffmpeg";
}
