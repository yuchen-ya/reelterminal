import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolvePythonWorkerPath } from "./python-worker-path";
import { resolveAudioModelsScript } from "./audio-models-runner";
import { resolveOpenCvScript } from "./opencv-runner";

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture(relative: string) {
  const root = await mkdtemp(join(tmpdir(), "worker-layout-"));
  roots.push(root);
  const directory = join(root, relative);
  await mkdir(directory, { recursive: true });
  for (const name of ["audio_models.py", "caption_models.py", "align.py", "track.py", "mask_refine.py", "propagate.py"]) {
    await writeFile(join(directory, name), "# physical worker\n");
  }
  return { root, directory };
}

describe("external Python worker layouts", () => {
  it.each(["packages/agent-facade/src/media", "dist/main", "packages/agent-transport/dist"])("resolves development layout %s", async (layout) => {
    const target = layout.startsWith("packages/") ? "packages/agent-facade/python" : "dist/python";
    const { root, directory } = await fixture(target);
    expect(await resolvePythonWorkerPath("align.py", join(root, layout))).toBe(join(directory, "align.py"));
  });

  it("both runners return physical unpacked paths for all shipped workers", async () => {
    vi.stubEnv("REELTERMINAL_AUDIO_MODELS_SCRIPT_DIR", "");
    vi.stubEnv("REELTERMINAL_OPENCV_SCRIPT_DIR", "");
    const { root, directory } = await fixture("resources/app.asar.unpacked/dist/python");
    const moduleDir = join(root, "resources/app.asar/dist/main");
    expect(await resolveAudioModelsScript(moduleDir)).toBe(join(directory, "audio_models.py"));
    for (const worker of ["align.py", "track.py", "mask_refine.py", "propagate.py"]) {
      expect(await resolveOpenCvScript(worker, moduleDir)).toBe(join(directory, worker));
    }
    expect(await resolvePythonWorkerPath("caption_models.py", moduleDir)).toBe(join(directory, "caption_models.py"));
  });

  it("does not accept a virtual ASAR file when the physical worker is absent", async () => {
    const { root, directory } = await fixture("resources/app.asar/dist/python");
    expect(await resolvePythonWorkerPath("align.py", join(root, "resources/app.asar/dist/main"), directory)).toBeNull();
  });

  it("maps an explicit ASAR override to a physical file and preserves override precedence", async () => {
    const { root, directory } = await fixture("resources/app.asar.unpacked/dist/python");
    expect(await resolvePythonWorkerPath("align.py", join(root, "missing"), directory.replace("app.asar.unpacked", "app.asar"))).toBe(join(directory, "align.py"));
  });
});
