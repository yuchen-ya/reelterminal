import { execFileSync } from "node:child_process";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("10fps source frames do not limit 30fps overlay updates", async () => {
  const launched = await launchApp();
  let agent: ExternalAgent | undefined;
  try {
    const { page, runDir } = launched;
    await createProjectViaUI(page);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const call = async <T,>(name: string, args = {}) => value(await agent!.callCommand<T>(name, args));
    const { identity } = await call<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context");
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const state = () => call<{ revision: number; project: { settings: { frameRate: number } } }>("project.get_state", target);
    expect((await state()).project.settings.frameRate).toBe(30);

    const source = path.join(runDir, "ten-fps.mp4");
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
    const filter = Array.from({ length: 6 }, (_, bit) =>
      `drawbox=x=${24 + bit * 45}:y=18:w=12:h=12:color=white:t=fill:enable='bitand(n,${2 ** bit})'`,
    ).join(",");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "color=black:s=320x180:r=10:d=4",
      "-vf", filter, "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { windowsHide: true });
    const { mediaId } = await call<{ mediaId: string }>("media.import", {
      ...target, path: source, expectedRevision: (await state()).revision,
    });
    const colors = ["#ff0000", "#00ff00", "#0000ff"];
    await call("edit.apply", {
      ...target, expectedRevision: (await state()).revision,
      ops: [
        { op: "track.add", trackType: "video", trackId: "ten-fps-video" },
        { op: "clip.add", mediaId, trackId: "ten-fps-video", startTime: 0, duration: 4 },
        { op: "track.add", trackType: "text", trackId: "project-frame-overlay" },
        ...Array.from({ length: 90 }, (_, frame) => ({
          op: "text.create", trackId: "project-frame-overlay", text: "MMMM",
          startTime: frame / 30, duration: 1 / 30,
          position: { x: 0.5, y: 0.5 },
          style: { fontSize: 200, color: colors[frame % 3], fontWeight: "bold" },
        })),
      ],
    });

    const read = async () => page.getByTestId("preview-canvas").evaluate(element => {
      const canvas = element as HTMLCanvasElement;
      const ctx = canvas.getContext("2d")!;
      const pixel = (x: number, y: number) => ctx.getImageData(
        Math.floor(x * canvas.width / 320), Math.floor(y * canvas.height / 180), 1, 1,
      ).data;
      let sourceFrame = 0;
      for (let bit = 0; bit < 6; bit++) {
        if (pixel(30 + bit * 45, 24)[0] > 128) sourceFrame += 2 ** bit;
      }
      const counts = [0, 0, 0];
      for (let y = 65; y <= 115; y += 3) {
        for (let x = 100; x <= 220; x += 3) {
          const p = pixel(x, y);
          for (let channel = 0; channel < 3; channel++) {
            if (p[channel] > 150 && p[(channel + 1) % 3] < 80 && p[(channel + 2) % 3] < 80) counts[channel]++;
          }
        }
      }
      return { sourceFrame, overlay: Math.max(...counts) > 10 ? counts.indexOf(Math.max(...counts)) : -1 };
    });
    const seek = (timeSeconds: number) => call("editor.control", { ...target, action: "seek", timeSeconds });
    // All three project frames reuse source frame 2, while their overlays
    // visibly advance at 30fps. These exact seeks also establish the fixture.
    for (let overlay = 0; overlay < 3; overlay++) {
      await seek((6 + overlay) / 30);
      await vi.waitFor(async () => expect(await read()).toEqual({ sourceFrame: 2, overlay }), { timeout: 10000 });
    }

    await seek(0);
    await page.getByRole("button", { name: "Play", exact: true }).click();
    const statesBySource = new Map<number, Set<number>>();
    await vi.waitFor(async () => {
      const sample = await read();
      if (sample.sourceFrame > 0 && sample.sourceFrame < 25 && sample.overlay >= 0) {
        const states = statesBySource.get(sample.sourceFrame) ?? new Set<number>();
        states.add(sample.overlay);
        statesBySource.set(sample.sourceFrame, states);
      }
      // The previous native path emitted just one overlay state per source
      // frame. A repeated source number must now carry multiple full frames.
      expect([...statesBySource.values()].some(states => states.size >= 2)).toBe(true);
    }, { timeout: 3000, interval: 10 });
    await page.getByRole("button", { name: "Pause", exact: true }).click();
  } finally {
    await agent?.close();
    await launched.close();
  }
}, 60000);
