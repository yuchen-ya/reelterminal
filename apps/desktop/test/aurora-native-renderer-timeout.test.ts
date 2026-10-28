import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { Mesh, RayTraceOptions } from "../../../packages/core/src/creation/index";
import {
  renderMeshWithNativeAuroraRenderer,
  resetNativeAuroraRendererClientForTests,
  setNativeAuroraRenderTimeoutForTests,
  setNativeAuroraRendererSpawnForTests,
} from "../src/aurora-host/native-renderer";
import { runAuroraPreviewSession } from "../src/aurora-host/preview-session";
import {
  createAuroraFixtureAsset,
  createAuroraFixtureScene,
} from "./aurora-fixture";

const RENDER_TIMEOUT_MS = 600;

// Fake "native renderer" driven by a mode file so a single script can hang,
// answer promptly, or answer slowly. Spawned through the module's test seam
// because Windows cannot exec an arbitrary script as the renderer binary.
const FAKE_RENDERER_SCRIPT = `
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const dir = process.env.FAKE_AURORA_DIR;
const modeFile = path.join(dir, "mode.txt");
const mode = existsSync(modeFile) ? readFileSync(modeFile, "utf8").trim() : "ok";
const logFile = path.join(dir, "events.log");
const log = (line) => {
  try { appendFileSync(logFile, line + "\\n"); } catch {}
};
const args = process.argv.slice(2);

function buildResponse(width, height) {
  const rgba = Buffer.alloc(width * height * 4, 255);
  const out = Buffer.alloc(36 + rgba.length);
  Buffer.from([0x4f, 0x52, 0x41, 0x52, 0x53, 0x31, 0x00, 0x00]).copy(out, 0);
  out.writeInt32LE(width, 8);
  out.writeInt32LE(height, 12);
  out.writeInt32LE(width * height, 16);
  out.writeInt32LE(0, 20);
  out.writeDoubleLE(1.5, 24);
  out.writeInt32LE(rgba.length, 32);
  rgba.copy(out, 36);
  return out;
}

if (args[0] === "serve") {
  log("serve-start mode=" + mode);
  if (mode === "hang") {
    process.stdin.resume();
    setInterval(() => {}, 1000000);
  } else {
    let buf = Buffer.alloc(0);
    process.stdin.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (buf.length < 4 + len) break;
        const payload = buf.subarray(4, 4 + len);
        buf = buf.subarray(4 + len);
        const width = payload.readInt32LE(8);
        const height = payload.readInt32LE(12);
        log("request " + width + "x" + height);
        const respond = () => {
          const out = buildResponse(width, height);
          const framed = Buffer.alloc(4 + out.length);
          framed.writeUInt32LE(out.length, 0);
          out.copy(framed, 4);
          process.stdout.write(framed);
          log("responded " + width + "x" + height);
        };
        if (mode === "slow") setTimeout(respond, 450);
        else respond();
      }
    });
  }
} else if (args[0] === "render") {
  log("render-start mode=" + mode);
  if (mode === "hang") {
    setInterval(() => {}, 1000000);
  } else {
    const req = readFileSync(args[1]);
    writeFileSync(args[2], buildResponse(req.readInt32LE(8), req.readInt32LE(12)));
    log("render-done");
  }
}
`;

const fixtureMesh: Mesh = {
  positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
  normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
  uvs: new Float32Array(6),
  indices: new Uint32Array([0, 1, 2]),
};

const fixtureOptions: RayTraceOptions = {
  width: 4,
  height: 4,
  camera: { position: { x: 0, y: 0, z: 5 }, target: { x: 0, y: 0, z: 0 } },
};

let fixtureDir: string;

async function setFakeMode(mode: "hang" | "ok" | "slow"): Promise<void> {
  await writeFile(path.join(fixtureDir, "mode.txt"), mode);
}

function waitForLog(fragment: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const poll = () => {
      const logFile = path.join(fixtureDir, "events.log");
      if (existsSync(logFile) && readFileSync(logFile, "utf8").includes(fragment)) {
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for log fragment: ${fragment}`));
        return;
      }
      setTimeout(poll, 20);
    };
    poll();
  });
}

beforeEach(async () => {
  fixtureDir = await mkdtemp(path.join(os.tmpdir(), "aurora-native-timeout-"));
  const scriptPath = path.join(fixtureDir, "fake-renderer.mjs");
  await writeFile(scriptPath, FAKE_RENDERER_SCRIPT);
  await writeFile(
    path.join(fixtureDir, "creation_aurora_renderer.exe"),
    "fake marker; spawned through the test seam\n",
  );
  await setFakeMode("ok");
  vi.stubEnv("REELTERMINAL_AURORA_RENDERER_PATH", path.join(fixtureDir, "creation_aurora_renderer.exe"));
  setNativeAuroraRendererSpawnForTests((executablePath, args) =>
    spawn(process.execPath, [scriptPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, FAKE_AURORA_DIR: fixtureDir },
    }) as ChildProcessWithoutNullStreams,
  );
  setNativeAuroraRenderTimeoutForTests(RENDER_TIMEOUT_MS);
});

afterEach(async () => {
  resetNativeAuroraRendererClientForTests();
  setNativeAuroraRendererSpawnForTests(null);
  setNativeAuroraRenderTimeoutForTests(null);
  vi.unstubAllEnvs();
  await rm(fixtureDir, { recursive: true, force: true }).catch(() => undefined);
});

describe("Aurora native renderer timeout and cancellation", () => {
  it(
    "times out a hung render with an honest error and recovers on the next request",
    { timeout: 15_000 },
    async () => {
      await setFakeMode("hang");
      const startedAt = Date.now();
      const failure = await renderMeshWithNativeAuroraRenderer(
        fixtureMesh,
        fixtureOptions,
      ).then(
        () => null,
        (error: Error) => error,
      );
      const elapsed = Date.now() - startedAt;

      expect(failure).not.toBeNull();
      // Both the stdio service attempt and the file fallback must be reported;
      // neither may swallow the failure or fake success.
      expect(failure?.message).toContain("failed via stdio service");
      expect(failure?.message).toContain("did not respond within");
      expect(failure?.message).toContain("did not exit within");
      expect(elapsed).toBeGreaterThanOrEqual(RENDER_TIMEOUT_MS * 2 - 100);
      expect(elapsed).toBeLessThan(RENDER_TIMEOUT_MS * 2 + 8000);

      // The shared client queue must keep moving: a later request renders on a
      // freshly spawned child and completes normally.
      await setFakeMode("ok");
      const frame = await renderMeshWithNativeAuroraRenderer(fixtureMesh, fixtureOptions);
      expect(frame?.backend).toBe("native");
      expect(frame?.width).toBe(4);
      expect(frame?.height).toBe(4);
    },
  );

  it(
    "aborting the signal terminates a hung render promptly without the file fallback",
    { timeout: 15_000 },
    async () => {
      await setFakeMode("hang");
      const controller = new AbortController();
      const pending = renderMeshWithNativeAuroraRenderer(
        fixtureMesh,
        fixtureOptions,
        controller.signal,
      );
      const outcome = pending.then(
        () => null,
        (error: Error) => error,
      );
      // Cancel only after the child is actually running; a slow CI spawn can
      // otherwise be aborted before it has created any event evidence.
      await waitForLog("serve-start mode=hang", 5_000);
      const startedAt = Date.now();
      controller.abort();
      const failure = await outcome;
      const elapsed = Date.now() - startedAt;

      expect(failure).not.toBeNull();
      expect(failure?.name).toBe("AbortError");
      // Prompt termination: well before the render timeout could fire, and no
      // file fallback ran (that would take another full timeout window).
      expect(elapsed).toBeLessThan(RENDER_TIMEOUT_MS);
      const events = readFileSync(path.join(fixtureDir, "events.log"), "utf8");
      expect(events).not.toContain("render-start");

      // After the cancelled render the client must accept new work.
      await setFakeMode("ok");
      const frame = await renderMeshWithNativeAuroraRenderer(fixtureMesh, fixtureOptions);
      expect(frame?.backend).toBe("native");
    },
  );

  it(
    "cancelling a queued render does not kill another session's in-flight render",
    { timeout: 15_000 },
    async () => {
      await setFakeMode("slow");
      const inFlight = renderMeshWithNativeAuroraRenderer(fixtureMesh, fixtureOptions);
      await waitForLog("request ", 5_000);

      const controller = new AbortController();
      const queued = renderMeshWithNativeAuroraRenderer(
        fixtureMesh,
        fixtureOptions,
        controller.signal,
      );
      setTimeout(() => controller.abort(), 60);
      const queuedFailure = await queued.then(
        () => null,
        (error: Error) => error,
      );
      expect(queuedFailure?.name).toBe("AbortError");

      // The in-flight render was started before the queued one and must still
      // complete on the same child.
      const frame = await inFlight;
      expect(frame?.backend).toBe("native");
      expect(frame?.width).toBe(4);
    },
  );

  it(
    "a cancelled preview session stops inside a hung pass instead of stalling",
    { timeout: 15_000 },
    async () => {
      await setFakeMode("hang");
      const asset = createAuroraFixtureAsset();
      const scene = createAuroraFixtureScene(asset);
      const controller = new AbortController();
      const events: unknown[] = [];
      const startedAt = Date.now();
      const session = runAuroraPreviewSession(
        {
          scene,
          assets: [asset],
          width: 32,
          height: 32,
          background: "#0f172a",
          quality: "preview",
        },
        (event) => events.push(event),
        controller.signal,
      );
      setTimeout(() => controller.abort(), 150);
      await expect(session).rejects.toThrow(/abort/i);
      expect(Date.now() - startedAt).toBeLessThan(RENDER_TIMEOUT_MS);
      expect(events).toHaveLength(0);
    },
  );
});
