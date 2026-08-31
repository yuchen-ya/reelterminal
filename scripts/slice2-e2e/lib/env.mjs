/**
 * Environment contract of Appendix D (setup script work, never agent work):
 * a fresh mediaRoots dir holding a synthesized, visually distinctive
 * input.mp4 (ffmpeg testsrc2 + moving drawtext timecode, so consecutive
 * frames visibly differ), fresh EMPTY artifactRoot and projectRoots dirs,
 * and a scratch dir for workflow files / probe copies. Paths cross to the
 * CLI only via flags/env.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PROJECT_SETTINGS = { width: 1920, height: 1080, frameRate: 30 };
/** Appendix D scenario 1: 5 s x 30 fps = 150 frames. */
export const CLIP_DURATION_SEC = 5;
export const EXPECTED_FRAMES = 150;

export class E2EEnvironment {
  constructor({ keep = false, root = undefined } = {}) {
    this.keep = keep;
    this.root = root;
  }

  async setup() {
    const base = this.root ?? path.join(tmpdir(), "slice2-e2e");
    await mkdir(base, { recursive: true });
    this.envDir = await mkdtemp(path.join(base, "env-"));
    this.mediaRoot = path.join(this.envDir, "media");
    this.artifactRoot = path.join(this.envDir, "artifacts");
    this.projectRoot = path.join(this.envDir, "projects");
    this.scratchDir = path.join(this.envDir, "scratch");
    for (const dir of [this.mediaRoot, this.artifactRoot, this.projectRoot, this.scratchDir]) {
      await mkdir(dir, { recursive: true });
    }
    this.inputMp4 = await this.synthesizeInput();
    return this;
  }

  /**
   * >= 5 s of 1920x1080@30 testsrc2 (a moving, visually distinctive pattern
   * with a built-in animated readout) plus a burn-in moving timecode when the
   * local ffmpeg build ships drawtext, so consecutive frames visibly differ.
   */
  async synthesizeInput() {
    const inputMp4 = path.join(this.mediaRoot, "input.mp4");
    const hasDrawtext = await this.ffmpegHasFilter("drawtext");
    const fontCandidates = [
      "/System/Library/Fonts/Helvetica.ttc",
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ];
    const font = fontCandidates.find((candidate) => existsSync(candidate));
    const source = "testsrc2=size=1920x1080:rate=30:duration=6";
    const filter = hasDrawtext && font
      ? `${source},drawtext=fontfile='${font}':text='slice2-e2e %{pts\\:hms}':fontsize=96:fontcolor=white:x=(w-text_w)/2:y=80`
      : source;
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", filter,
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      inputMp4,
    ], { timeout: 120_000 });
    return inputMp4;
  }

  async ffmpegHasFilter(name) {
    try {
      const { stdout } = await execFileAsync("ffmpeg", ["-hide_banner", "-filters"], { timeout: 30_000 });
      return stdout.includes(` ${name} `);
    } catch {
      return false;
    }
  }

  async cleanup() {
    if (this.keep) return this.envDir;
    await rm(this.envDir, { recursive: true, force: true });
    return undefined;
  }

  /** Serve/run CLI config, passed ONLY via flags or env by the callers. */
  cliEnv() {
    return {
      OPENREEL_AVE_MEDIA_ROOTS: this.mediaRoot,
      OPENREEL_AVE_ARTIFACT_ROOT: this.artifactRoot,
      OPENREEL_AVE_PROJECT_ROOTS: this.projectRoot,
    };
  }

  cliFlags() {
    return [
      "--media-root", this.mediaRoot,
      "--artifact-root", this.artifactRoot,
      "--project-root", this.projectRoot,
    ];
  }
}

export async function ffprobeVersion(bin) {
  try {
    const { stdout } = await execFileAsync(bin, ["-version"], { timeout: 15_000 });
    return stdout.split("\n")[0];
  } catch {
    return null;
  }
}

export async function listFilesRecursive(dir) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => null);
  if (entries === null) return out;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listFilesRecursive(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}
