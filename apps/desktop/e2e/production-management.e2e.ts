import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";

/** Visible Electron + real reelctl; no direct store mutations or mocked native verification. */
test("M3 live: frame evidence, strict GUI adoption/undo, automatic checkpoints and process recovery", async () => {
  let launched = await launchApp({ keepRunDir: true });
  let jobRoot: string | undefined;
  let agent: ExternalAgent | undefined;
  const batchCall = async (name: string, args: Record<string, unknown>) => {
    const result = await agent!.callTool<any>(name, args);
    if (!result.ok) throw new Error(result.error?.message ?? "Batch command failed");
    return result.value;
  };
  const observations: Record<string, unknown> = {};
  const cli = (args: string[], input?: unknown) =>
    new Promise<any>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), ...args],
        {
          env: {
            ...process.env,
            REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile,
          },
          windowsHide: true,
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      child.stderr.on("data", () => {}); // CLI also emits the JSON error on stdout.
      child.on("error", reject);
      child.on("close", () => {
        try {
          const result = JSON.parse(stdout);
          if (!result.ok) reject(new Error(result.error.message));
          else resolve(result.value);
        } catch (error) {
          reject(error);
        }
      });
      child.stdin.end(input === undefined ? undefined : JSON.stringify(input));
    });
  const call = async (command: string, args: Record<string, unknown> = {}) => {
    const context = await cli(["context"]);
    return cli(["call", command, "--stdin"], {
      arguments: args,
      expectedProjectId: context.identity.projectId,
      expectedProjectEpoch: context.identity.projectEpoch,
    });
  };
  const state = () => call("project.get_state");
  const edit = async (ops: unknown[]) => {
    const current = await state();
    return call("edit.apply", { ops, expectedRevision: current.revision });
  };
  const enable = async () => {
    await launched.page.getByTestId("agent-access-status").waitFor();
    const toggle = launched.page.getByTestId("agent-access-toggle");
    await vi.waitFor(async () => expect(await toggle.isEnabled()).toBe(true), {
      timeout: 30_000,
    });
    if ((await toggle.getAttribute("aria-pressed")) !== "true")
      await toggle.click();
    await launched.waitForEndpointFile();
  };
  try {
    await launched.page.getByLabel(/^Horizontal /).click();
    const tour = launched.page.getByRole("button", {
      name: "Skip tour",
      exact: true,
    });
    await tour.last().waitFor({ timeout: 20_000 });
    await tour.last().click();
    await enable();
    // The client consumes endpoint credentials internally; never read or log them here.
    const capabilities = await cli(["call", "capabilities.get"]);
    jobRoot = path.join(
      capabilities.mediaImport.recommendedRoot,
      "jobs",
      `2026-10-04-m3-live-${Date.now()}`,
    );
    for (const dir of [
      "source",
      "generated",
      "work",
      "project",
      "evidence",
      "output",
    ])
      mkdirSync(path.join(jobRoot, dir), { recursive: true });
    writeFileSync(
      path.join(jobRoot, "brief.md"),
      "M3 live acceptance in an isolated visible Electron profile: automatic batch persistence, strict candidate adoption and undo, selected-frame evidence, save/relaunch/recovery. Synthetic media only.\n",
    );
    console.info(`M3 evidence: ${jobRoot}`);
    const source = path.join(jobRoot, "source", "red-blue.mp4");
    const candidate = path.join(jobRoot, "generated", "candidate.mp4");
    const short = path.join(jobRoot, "generated", "short.mp4");
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH ?? "ffmpeg";
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=red:s=320x180:r=30:d=1",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=320x180:r=30:d=1",
        "-filter_complex",
        "[0:v][1:v]concat=n=2:v=1:a=0",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        source,
      ],
      { windowsHide: true },
    );
    copyFileSync(source, candidate);
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        source,
        "-frames:v",
        "59",
        "-c:v",
        "libx264",
        short,
      ],
      { windowsHide: true },
    );

    // Import and add the source through actual GUI file input and media card.
    await launched.page
      .locator('input[type="file"][aria-label="Import media"]')
      .setInputFiles(source);
    const sourceCard = launched.page.locator("[data-live-media-id]").first();
    await sourceCard.waitFor();
    await sourceCard.dblclick({ position: { x: 15, y: 15 } });
    await launched.page
      .getByRole("button", { name: "Keep Current", exact: true })
      .click();
    await vi.waitFor(
      async () =>
        expect(
          (await state()).project.timeline.tracks.flatMap(
            (track: any) => track.clips,
          ),
        ).toHaveLength(1),
      { timeout: 20_000 },
    );
    const original = await state();
    const originalClip = original.project.timeline.tracks.flatMap(
      (track: any) => track.clips,
    )[0];
    const importedCandidate = await call("media.import", { path: candidate });
    const importedShort = await call("media.import", { path: short });
    await call("editor.control", { action: "seek", timeSeconds: 1.5 });

    const page = launched.page;
    await page
      .getByRole("button", { name: "Create review task", exact: true })
      .click();
    await page
      .getByLabel("Task title", { exact: true })
      .fill("M3 selected frame review");
    await page.getByLabel("Start frame", { exact: true }).fill("15");
    await page.getByLabel("End frame", { exact: true }).fill("20");
    await page
      .getByRole("button", { name: "Create review task", exact: true })
      .last()
      .click();
    await vi.waitFor(
      async () =>
        expect((await state()).project.requirements?.items).toHaveLength(1),
      { timeout: 90_000 },
    );
    let current = await state();
    const requirement = current.project.requirements.items[0];
    expect(requirement.reviewRange.evidence).toMatchObject({
      timelineFrame: 15,
      timeSec: 0.5,
      projectId: current.project.id,
    });
    const pixel = execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        requirement.reviewRange.evidence.artifactPath,
        "-vf",
        "crop=2:2:(iw-2)/2:(ih-2)/2",
        "-pix_fmt",
        "rgb24",
        "-f",
        "rawvideo",
        "pipe:1",
      ],
      { windowsHide: true },
    );
    expect(pixel[0]).toBeGreaterThan(200);
    expect(pixel[2]).toBeLessThan(50); // Requested frame is red; playhead at 1.5s was blue.
    console.info("Selected-frame evidence verified");
    observations.evidence = requirement.reviewRange.evidence;
    copyFileSync(
      requirement.reviewRange.evidence.artifactPath,
      path.join(jobRoot, "evidence", "selected-frame.png"),
    );
    await edit([
      {
        op: "requirement.update",
        requirementId: requirement.id,
        resultMediaIds: [importedShort.mediaId],
        status: "review",
      },
    ]);
    await page
      .getByRole("button")
      .filter({ hasText: "M3 selected frame review" })
      .click();
    await page
      .getByRole("button", {
        name: "Adopt full-source candidate (undoable)",
        exact: true,
      })
      .click();
    await page.getByText(/must preserve decoded frame count/).waitFor();
    current = await state();
    expect(
      current.project.timeline.tracks.flatMap((track: any) => track.clips)[0]
        .mediaId,
    ).toBe(originalClip.mediaId);
    expect(current.project.requirements.items[0].status).toBe("review");
    await page.screenshot({
      path: path.join(jobRoot, "evidence", "strict-rejection.png"),
    });
    observations.rejectedShortCandidate = true;
    await edit([
      {
        op: "requirement.update",
        requirementId: requirement.id,
        resultMediaIds: [importedCandidate.mediaId],
      },
    ]);
    await page
      .getByRole("button", { name: "Compare candidate", exact: true })
      .click();
    current = await state();
    expect(current.project.referenceComparison.referenceMediaId).toBe(
      importedCandidate.mediaId,
    );
    await page.getByTestId("requirement-board-entry").click();
    await page
      .getByRole("button")
      .filter({ hasText: "M3 selected frame review" })
      .click();
    await page
      .getByRole("button", {
        name: "Adopt full-source candidate (undoable)",
        exact: true,
      })
      .click();
    await vi.waitFor(
      async () =>
        expect((await state()).project.requirements.items[0].status).toBe(
          "done",
        ),
      { timeout: 30_000 },
    );
    current = await state();
    expect(
      current.project.timeline.tracks.flatMap((track: any) => track.clips)[0],
    ).toMatchObject({
      mediaId: importedCandidate.mediaId,
      duration: originalClip.duration,
      inPoint: originalClip.inPoint,
      outPoint: originalClip.outPoint,
    });
    await page.screenshot({
      path: path.join(jobRoot, "evidence", "adopted.png"),
    });
    await page.keyboard.press("Escape");
    await page.keyboard.press("Control+z");
    await vi.waitFor(
      async () =>
        expect(
          (await state()).project.timeline.tracks.flatMap(
            (track: any) => track.clips,
          )[0].mediaId,
        ).toBe(originalClip.mediaId),
      { timeout: 30_000 },
    );
    expect((await state()).project.requirements.items[0].status).toBe("review");
    observations.strictAdoptionAndUndo = true;
    console.info("Strict GUI rejection, adoption and undo verified");

    // Long local analysis leaves enough time to cancel and interrupt a real process.
    const longSource = path.join(jobRoot, "source", "long-analysis.mp4");
    execFileSync(
      ffmpeg,
      [
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=black:s=1280x720:r=30:d=180",
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        longSource,
      ],
      { windowsHide: true, timeout: 120_000 },
    );
    const longMedia = await call("media.import", { path: longSource });
    await call("project.save");
    current = await state();
    agent = await connectExternalAgent(launched.endpointFile);
    const batch = await batchCall("batch_start", {
      batchId: "m3-live",
      mediaIds: [originalClip.mediaId, longMedia.mediaId],
      analysisTypes: ["technicalQuality", "blackFrames", "duplicateFrames"],
      expectedRevision: current.revision,
    });
    const manifestPath = path.join(
      launched.userDataDir,
      "live-artifacts",
      "production-batches",
      "m3-live.json",
    );
    const readBatch = () => JSON.parse(readFileSync(manifestPath, "utf8"));
    await batchCall("job_cancel", { jobId: batch.items[1].jobId });
    await vi.waitFor(
      () =>
        expect(
          readBatch().items.map((item: any) => item.status?.state),
        ).toEqual(["done", "cancelled"]),
      { timeout: 60_000 },
    );
    // No batch.get: disk state above must have arrived from job transitions.
    observations.automaticCheckpoint = readBatch().items.map((item: any) => ({
      jobId: item.jobId,
      state: item.status.state,
    }));
    const retry = await batchCall("batch_resume", { batchId: "m3-live" });
    expect(retry.items[0].jobId).toBe(batch.items[0].jobId);
    expect(retry.items[1].jobId).not.toBe(batch.items[1].jobId);
    expect(["queued", "running"]).toContain(retry.items[1].status.state);
    const runDir = launched.runDir;
    await launched.app.evaluate(({ app }) => app.exit(0));
    await agent.close();
    agent = undefined;
    launched = await launchApp({ runDir, keepRunDir: true });
    await launched.page.getByLabel("Open Horizontal", { exact: true }).click();
    await enable();
    current = await state();
    agent = await connectExternalAgent(launched.endpointFile);
    const resumed = await batchCall("batch_resume", {
      batchId: "m3-live",
      expectedRevision: current.revision,
    });
    expect(resumed.items[0].jobId).toBe(batch.items[0].jobId);
    expect(resumed.items[1].jobId).not.toBe(retry.items[1].jobId);
    await vi.waitFor(
      () =>
        expect(
          readBatch().items.every((item: any) => item.status?.state === "done"),
        ).toBe(true),
      { timeout: 120_000 },
    );
    observations.recovery = readBatch().items.map((item: any) => ({
      jobId: item.jobId,
      state: item.status.state,
    }));
    expect(
      current.project.requirements.items[0].reviewRange.evidence.timelineFrame,
    ).toBe(15);
    await launched.page.getByTestId("requirement-board-entry").click();
    await launched.page
      .getByRole("button")
      .filter({ hasText: "M3 selected frame review" })
      .click();
    await launched.page.screenshot({
      path: path.join(jobRoot, "evidence", "reopened.png"),
    });
    writeFileSync(
      path.join(jobRoot, "project", "manifest.json"),
      JSON.stringify(
        { status: "passed", visibleElectron: true, ...observations },
        null,
        2,
      ),
    );
    console.info(`M3 live acceptance passed: ${jobRoot}`);
  } catch (error) {
    if (jobRoot) {
      await launched.page
        .screenshot({ path: path.join(jobRoot, "evidence", "failure.png") })
        .catch(() => undefined);
      writeFileSync(
        path.join(jobRoot, "project", "manifest.json"),
        JSON.stringify(
          {
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
            ...observations,
          },
          null,
          2,
        ),
      );
    }
    throw error;
  } finally {
    await agent?.close();
    await launched.close({ keepRunDir: true, gracefulTimeoutMs: 2_000 });
  }
});
