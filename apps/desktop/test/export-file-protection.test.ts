import { vi } from "vitest";
import path from "node:path";

vi.mock("electron", () => ({ app: { isPackaged: false } }));

vi.mock("../src/main/sidecar/ffmpeg-path", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/main/sidecar/ffmpeg-path")>();
  const bin = path.resolve(
    __dirname,
    "../resources/bin",
    actual.ffmpegRelativePath(process.platform, process.arch),
  );
  return { ...actual, resolveFfmpegPath: () => bin };
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { watch, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { ExportJob, type ExportArgs } from "../src/main/sidecar/export-job";
import { ffmpegRelativePath } from "../src/main/sidecar/ffmpeg-path";

const ffmpegBin = path.resolve(
  __dirname,
  "../resources/bin",
  ffmpegRelativePath(process.platform, process.arch),
);

const HAS_FFMPEG = existsSync(ffmpegBin);
if (process.env.EXPECT_FFMPEG === "1" && !HAS_FFMPEG) {
  throw new Error(`The vendored ffmpeg binary is required for this regression test: ${ffmpegBin}`);
}

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => { resolve = accept; });
  return { promise, resolve };
}

function runQuiet(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegBin, ["-hide_banner", "-loglevel", "error", ...args], {
      windowsHide: true,
      stdio: "ignore",
    });
    child.once("error", () => reject(new Error("ffmpeg could not be started")));
    child.once("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited during fixture setup or decode (code ${code})`));
    });
  });
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fullyDecode(target: string): Promise<void> {
  await runQuiet(["-xerror", "-i", target, "-f", "null", "-"]);
}

function makeArgs(outputPath: string, audioWavPath: string, encoder = "libx264"): ExportArgs {
  return {
    width: 96,
    height: 64,
    frameRate: 30,
    codec: "h264",
    encoder,
    mode: "fast",
    quality: 80,
    bitrateKbps: 500,
    outputPath,
    audioWavPath,
    format: "mp4",
  };
}

function frameFor(args: ExportArgs): Uint8Array {
  return new Uint8Array(args.width * args.height * 4).fill(112);
}

function createJob(
  args: ExportArgs,
  onFrame: (frame: number) => void = () => undefined,
) {
  const terminal = deferred<"done" | "error">();
  const job = new ExportJob(
    args,
    onFrame,
    () => terminal.resolve("done"),
    () => terminal.resolve("error"),
  );
  return { job, terminal: terminal.promise };
}

async function startSuccessfulEncode(
  outputPath: string,
  audioWavPath: string,
  frameCount: number,
): Promise<"done" | "error"> {
  const args = makeArgs(outputPath, audioWavPath);
  const { job, terminal } = createJob(args);
  job.start();
  const frame = frameFor(args);
  for (let index = 0; index < frameCount; index++) {
    await job.writeFrame(frame);
  }
  job.endInput();
  return terminal;
}

async function waitForWrittenMp4(
  directory: string,
  target: string,
  previousHash: string | null,
  namesBeforeStart: ReadonlySet<string>,
): Promise<void> {
  const targetName = path.basename(target);
  const wasWritten = async (): Promise<boolean> => {
    try {
      const bytes = await fs.readFile(target);
      if (bytes.length > 0 && (!previousHash || sha256(bytes) !== previousHash)) return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error("could not inspect the output during cancellation");
      }
    }

    for (const name of await fs.readdir(directory)) {
      if (name === targetName || !name.toLowerCase().endsWith(".mp4") || namesBeforeStart.has(name)) continue;
      const stat = await fs.stat(path.join(directory, name));
      if (stat.size > 0) return true;
    }
    return false;
  };

  if (await wasWritten()) return;
  await new Promise<void>((resolve, reject) => {
    let checking = false;
    const watcher = watch(directory, () => {
      if (checking) return;
      checking = true;
      void wasWritten().then((written) => {
        if (written) finish();
      }).catch(() => finish(new Error("could not inspect the output during cancellation"))).finally(() => {
        checking = false;
      });
    });
    const timer = setTimeout(() => finish(new Error("timed out waiting for ffmpeg output bytes")), 15000);
    const finish = (error?: Error): void => {
      clearTimeout(timer);
      watcher.close();
      if (error) reject(error);
      else resolve();
    };
    void wasWritten().then((written) => {
      if (written) finish();
    }).catch(() => finish(new Error("could not inspect the output during cancellation")));
  });
}

let scratchRoot = "";
let audioWavPath = "";
let originalMp4Path = "";
let originalMp4Hash = "";
let originalMp4Bytes = new Uint8Array();

beforeAll(async () => {
  scratchRoot = await fs.mkdtemp(path.join(tmpdir(), "reelterminal-export-protection-"));
  audioWavPath = path.join(scratchRoot, "audio.wav");
  originalMp4Path = path.join(scratchRoot, "original.mp4");

  await runQuiet([
    "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
    "-t", "60", "-c:a", "pcm_s16le", audioWavPath,
  ]);
  await runQuiet([
    "-f", "lavfi", "-i", "color=c=red:s=96x64:r=30",
    "-t", "1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", originalMp4Path,
  ]);

  originalMp4Bytes = await fs.readFile(originalMp4Path);
  originalMp4Hash = sha256(originalMp4Bytes);
  await fullyDecode(originalMp4Path);
}, 30000);

afterAll(async () => {
  if (scratchRoot) await fs.rm(scratchRoot, { recursive: true, force: true });
});

describe.skipIf(!HAS_FFMPEG)("native export protects the destination until a complete encode succeeds", () => {
  for (const targetKind of ["existing", "new"] as const) {
    for (const resultKind of ["success", "cancel after write", "encoder initialization failure"] as const) {
      it(`${targetKind} target remains valid or absent after ${resultKind}`, async () => {
        const directory = path.join(scratchRoot, `${targetKind}-${resultKind.replaceAll(" ", "-")}`);
        await fs.mkdir(directory, { recursive: true });
        const target = path.join(directory, "result.mp4");
        const hasOldFile = targetKind === "existing";
        if (hasOldFile) await fs.copyFile(originalMp4Path, target);

        const beforeHash = hasOldFile ? sha256(await fs.readFile(target)) : null;
        const namesBeforeStart = new Set(await fs.readdir(directory));

        if (resultKind === "success") {
          expect(await startSuccessfulEncode(target, audioWavPath, 30)).toBe("done");
          const after = await fs.readFile(target);
          expect(after.length).toBeGreaterThan(0);
          if (beforeHash) expect(sha256(after)).not.toBe(beforeHash);
          await fullyDecode(target);
          return;
        }

        if (resultKind === "encoder initialization failure") {
          const args = makeArgs(target, audioWavPath, "reelterminal_encoder_that_does_not_exist");
          let sawEncodedFrame = false;
          const { job, terminal } = createJob(args, (frame) => {
            if (frame > 0) sawEncodedFrame = true;
          });
          job.start();
          await job.writeFrame(frameFor(args));
          job.endInput();
          expect(await terminal).toBe("error");
          expect(sawEncodedFrame).toBe(false);
        } else {
          const args: ExportArgs = {
            ...makeArgs(target, audioWavPath),
            width: 1920,
            height: 1080,
          };
          const progress = deferred<void>();
          const { job, terminal } = createJob(args, (frame) => {
            if (frame > 0) progress.resolve();
          });
          job.start();
          let cancelRequested = false;
          const feeding = (async () => {
            const frame = frameFor(args);
            for (let index = 0; index < 3600 && !cancelRequested; index++) {
              await job.writeFrame(frame);
            }
            if (!cancelRequested) job.endInput();
          })();

          const firstEvent = await Promise.race([
            progress.promise.then(() => "progress" as const),
            terminal.then((result) => result),
          ]);
          expect(firstEvent).toBe("progress");
          await waitForWrittenMp4(directory, target, beforeHash, namesBeforeStart);
          cancelRequested = true;
          const cancelResult = job.cancel() as unknown;
          if (cancelResult && typeof (cancelResult as Promise<void>).then === "function") {
            await cancelResult;
          } else {
            await terminal;
          }
          await feeding;
          expect(await terminal).not.toBe("done");
        }

        if (hasOldFile) {
          const after = await fs.readFile(target);
          const fullDecode = await fullyDecode(target).then(() => true, () => false);
          expect({ byteLength: after.length, sha256: sha256(after), fullDecode, bytesEqual: Buffer.compare(after, originalMp4Bytes) === 0 }).toEqual({
            byteLength: originalMp4Bytes.length,
            sha256: originalMp4Hash,
            fullDecode: true,
            bytesEqual: true,
          });
        } else {
          await expect(fs.access(target)).rejects.toMatchObject({ code: "ENOENT" });
        }
      }, 90000);
    }
  }

  it("does not let a cancelled concurrent job erase another job's completed output", async () => {
    const directory = path.join(scratchRoot, "same-target-concurrent");
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "result.mp4");
    await fs.copyFile(originalMp4Path, target);
    const previousHash = sha256(await fs.readFile(target));
    const namesBeforeStart = new Set(await fs.readdir(directory));

    const cancelArgs: ExportArgs = {
      ...makeArgs(target, audioWavPath),
      width: 1920,
      height: 1080,
    };
    const progress = deferred<void>();
    const { job: cancelledJob, terminal: cancelledTerminal } = createJob(cancelArgs, (frame) => {
      if (frame > 0) progress.resolve();
    });
    cancelledJob.start();
    let cancelRequested = false;
    const feeding = (async () => {
      const frame = frameFor(cancelArgs);
      for (let index = 0; index < 3600 && !cancelRequested; index++) {
        await cancelledJob.writeFrame(frame);
      }
      if (!cancelRequested) cancelledJob.endInput();
    })();

    const firstEvent = await Promise.race([
      progress.promise.then(() => "progress" as const),
      cancelledTerminal.then((result) => result),
    ]);
    expect(firstEvent).toBe("progress");
    await waitForWrittenMp4(directory, target, previousHash, namesBeforeStart);

    const successArgs = makeArgs(target, audioWavPath);
    const { job: successfulJob, terminal: successfulTerminal } = createJob(successArgs);
    successfulJob.start();
    const successFrame = frameFor(successArgs);
    for (let index = 0; index < 30; index++) {
      await successfulJob.writeFrame(successFrame);
    }
    successfulJob.endInput();
    expect(await successfulTerminal).toBe("done");

    cancelRequested = true;
    await cancelledJob.cancel();
    await feeding;
    expect(await cancelledTerminal).not.toBe("done");

    const completed = await fs.readFile(target);
    expect(completed.length).toBeGreaterThan(0);
    expect(sha256(completed)).not.toBe(previousHash);
    await fullyDecode(target);
  }, 90000);

  it.skipIf(process.platform !== "win32")("preserves an existing target when Windows prevents the final replacement", async () => {
    const directory = path.join(scratchRoot, "locked-target");
    await fs.mkdir(directory, { recursive: true });
    const target = path.join(directory, "result.mp4");
    await fs.copyFile(originalMp4Path, target);
    const old = await fs.readFile(target);
    const oldHash = sha256(old);
    const lock = await lockFileExclusively(target);
    let failureMessage = "";
    try {
      const args = makeArgs(target, audioWavPath);
      const terminal = deferred<"done" | "error">();
      const job = new ExportJob(
        args,
        () => undefined,
        () => terminal.resolve("done"),
        (message) => {
          failureMessage = message;
          terminal.resolve("error");
        },
      );
      job.start();
      const frame = frameFor(args);
      for (let index = 0; index < 30; index++) {
        await job.writeFrame(frame);
      }
      job.endInput();
      expect(await terminal.promise).toBe("error");
      expect(failureMessage.startsWith("Could not commit native export:")).toBe(true);
    } finally {
      await lock.release();
    }

    const after = await fs.readFile(target);
    expect({ byteLength: after.length, sha256: sha256(after), bytesEqual: Buffer.compare(after, old) === 0 }).toEqual({
      byteLength: old.length,
      sha256: oldHash,
      bytesEqual: true,
    });
    await fullyDecode(target);
  }, 90000);
});

function lockFileExclusively(target: string): Promise<{ release: () => Promise<void> }> {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const quotedTarget = target.replaceAll("'", "''");
  const script = [
    `$stream = [System.IO.File]::Open('${quotedTarget}', [System.IO.FileMode]::Open, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)`,
    "[Console]::Out.WriteLine('locked')",
    "[Console]::In.ReadLine() | Out-Null",
    "$stream.Dispose()",
  ].join("; ");
  const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true,
    stdio: ["pipe", "pipe", "ignore"],
  });

  return new Promise((resolve, reject) => {
    let output = "";
    let ready = false;
    const timer = setTimeout(() => {
      if (!ready) reject(new Error("timed out acquiring the Windows output lock"));
      child.kill();
    }, 10000);
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (ready || !output.includes("locked")) return;
      ready = true;
      clearTimeout(timer);
      resolve({
        release: async () => {
          child.stdin.end("release\n");
          await new Promise<void>((complete, fail) => {
            child.once("error", () => fail(new Error("could not release the Windows output lock")));
            child.once("close", () => complete());
          });
        },
      });
    });
    child.once("error", () => {
      clearTimeout(timer);
      if (!ready) reject(new Error("could not start the Windows file-lock helper"));
    });
    child.once("close", () => {
      clearTimeout(timer);
      if (!ready) reject(new Error("Windows file-lock helper exited before acquiring the lock"));
    });
  });
}
