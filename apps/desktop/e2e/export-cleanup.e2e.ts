import { execFileSync } from "node:child_process";
import { existsSync, statSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, vi } from "vitest";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value } from "./harness/cli-client";
import {
  createProjectViaUI,
  createTextClipViaUI,
  enableAgentSessionViaUI,
  openRecentProjectViaUI,
} from "./harness/ui";
import { ARTIFACTS_DIR, DESKTOP_DIR } from "./harness/paths";

test("human export, review handoff, explicit cleanup and retained media survive reopen", async () => {
  let launched = await launchApp();
  let agent: Awaited<ReturnType<typeof connectExternalAgent>> | undefined;
  try {
    const { page, app, runDir } = launched;
    await createProjectViaUI(page);
    await enableAgentSessionViaUI(page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH ?? path.join(DESKTOP_DIR, "resources/bin", `${process.platform}-${process.arch}`, process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    const source = path.join(runDir, "cleanup-source.mp4");
    execFileSync(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=24:duration=2.4", "-c:v", "libx264", "-pix_fmt", "yuv420p", source], { timeout: 30_000, windowsHide: true });
    await page
      .locator('input[type="file"][aria-label="Import media"]')
      .setInputFiles(source);
    await page
      .locator("[data-live-media-id]")
      .first()
      .getByRole("button", { name: "Add to timeline", exact: true })
      .click();
    await page.getByRole("button", { name: "Match Video", exact: true }).click();
    const context = value(
      await agent.callCommand<{
        identity: { projectId: string; workspaceId: string };
        projectRevision: number;
      }>("editor.get_context"),
    );
    const target = {
      projectId: context.identity.projectId,
      workspaceId: context.identity.workspaceId,
    };
    const root = value(
      await agent.callCommand<{ node: { id: string }; revision: number }>(
        "node.save",
        {
          ...target,
          expectedRevision: context.projectRevision,
          idempotencyKey: "cleanup-root",
          name: "保留的正式节点",
        },
      ),
    );
    await createTextClipViaUI(page);
    const branchContext = value(await agent.callCommand<{ projectRevision: number }>("editor.get_context"));
    const saved = value(
      await agent.callCommand<{ node: { id: string }; revision: number }>(
        "node.save",
        {
          ...target,
        expectedRevision: branchContext.projectRevision,
          idempotencyKey: "cleanup-node-one",
          name: "整理验收节点",
        },
      ),
    );
    expect(saved.node.id).not.toBe(root.node.id);
    value(
      await agent.callCommand("node.restore", {
        ...target,
        nodeId: root.node.id,
        expectedRevision: saved.revision,
        idempotencyKey: "cleanup-return-root",
      }),
    );

    const output = path.join(runDir, "cleanup-delivery.mp4");
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) await dismiss.click();
    await app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, output);
    await page.getByRole("button", { name: "Export", exact: true }).click();
    await page.getByRole("radio", { name: "Custom", exact: true }).click();
    await page
      .getByRole("button", { name: "Start Export", exact: true })
      .click();
    await page.getByTestId("export-cleanup-page").waitFor();
    await page.getByTestId("export-fixed-progress").waitFor();
    await page.getByRole("button", { name: "返回编辑", exact: true }).click();
    await page.getByTestId("agent-access-status").waitFor();
    await vi.waitFor(
      () => expect(existsSync(output) && statSync(output).size > 0).toBe(true),
      { timeout: 120_000 },
    );
    await page
      .getByRole("button", { name: "Export", exact: true })
      .waitFor({ timeout: 120_000 });
    await page.getByRole("button", { name: "导出与整理", exact: true }).click();
    await page.getByText("导出完成", { exact: false }).first().waitFor();
    execFileSync(
      ffmpeg,
      ["-v", "error", "-xerror", "-i", output, "-f", "null", "-"],
      { timeout: 60_000, windowsHide: true },
    );

    await page.getByRole("checkbox", { name: "选择节点 整理验收节点" }).check();
    await page.getByLabel("整理动作").selectOption("recycle-nodes");
    const clipboardHostRoundTrip = await app.evaluate(async ({ clipboard }) => {
      const previous = await clipboard.readText();
      try {
        await clipboard.writeText("reelterminal-e2e-clipboard-probe");
        return (await clipboard.readText()) === "reelterminal-e2e-clipboard-probe";
      } finally { await clipboard.writeText(previous); }
    });
    const clipboardCapture = await page.evaluateHandle(() => {
      const capture = { submitted: "", original: navigator.clipboard.writeText };
      navigator.clipboard.writeText = async (text) => {
        capture.submitted = text;
        await capture.original.call(navigator.clipboard, text);
      };
      return capture;
    });
    await page
      .getByRole("button", { name: "复制提示词给 Agent", exact: true })
      .click();
    await page.getByText("已复制审查提示词。", { exact: true }).waitFor();
    const prompt = await clipboardCapture.evaluate((capture) => {
      navigator.clipboard.writeText = capture.original;
      return capture.submitted;
    });
    await clipboardCapture.dispose();
    if (clipboardHostRoundTrip) {
      await vi.waitFor(async () => expect((await app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, "\n")).toBe(prompt));
    }
    expect(prompt).toContain(target.projectId);
    expect(prompt).toContain(target.workspaceId);
    expect(prompt).toContain(saved.node.id);
    expect(prompt).toContain("确认");
    expect(prompt).not.toMatch(/Bearer |live-endpoint\.json/);
    await page
      .getByRole("button", { name: "发布清理任务到看板", exact: true })
      .click();
    await page
      .getByText("清理审查任务已发布到需求看板；尚未授权删除。", {
        exact: true,
      })
      .waitFor();
    const requirements = value(
      await agent.callCommand<any>("requirements.list", target),
    );
    expect(JSON.stringify(requirements)).toMatch(/cleanup|清理/i);
    const reviewTask = requirements.requirements.find((item: any) => item.cleanupHandoff);
    expect(reviewTask.cleanupHandoff.phase).toBe("pending_review");

    await page
      .getByRole("button", { name: "现在整理 · 生成审查计划", exact: true })
      .click();
    await page.getByTestId("cleanup-confirmation").waitFor();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    expect(
      value(
        await agent.callCommand<{ nodes: { id: string }[] }>(
          "node.list",
          { projectId: target.projectId },
        ),
      ).nodes.some((node) => node.id === saved.node.id),
    ).toBe(true);
    await page
      .getByRole("button", { name: "现在整理 · 生成审查计划", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认执行此计划", exact: true })
      .click();
    await vi.waitFor(async () =>
      expect(
        value(
          await agent!.callCommand<{ nodes: { id: string }[] }>(
            "node.list",
            { projectId: target.projectId },
          ),
        ).nodes.some((node) => node.id === saved.node.id),
      ).toBe(false),
    );
    const completedBoard = value(await agent.callCommand<any>("requirements.list", target));
    expect(completedBoard.requirements.find((item: any) => item.id === reviewTask.id)?.cleanupHandoff.phase).toBe("completed");

    const plan = value(
      await agent.callCommand<any>("media.cleanup.plan", {
        ...target,
        action: "purge-deleted-nodes",
        nodeIds: [saved.node.id],
      }),
    );
    const denied = await agent.callCommand("media.cleanup.execute", {
      ...target,
      planId: plan.planId,
    });
    expect(denied.ok).toBe(false);
    const { target: planTarget, ...confirmedScope } = plan.confirmation;
    const result = value(
      await agent.callCommand<any>("media.cleanup.execute", {
        ...planTarget,
        ...confirmedScope,
        confirmed: true,
      }),
    );
    expect(result.failed).toHaveLength(0);
    expect(existsSync(source)).toBe(true);
    expect(existsSync(output)).toBe(true);
    const before = value(
      await agent.callCommand<any>("project.get_state", target),
    );
    expect(before.project.mediaLibrary.items).toHaveLength(1);
    const interrupted = value(await agent.callCommand<any>("export.start", {
      ...target, expectedRevision: before.revision,
      settings: { width: 640, height: 360, frameRate: 30, videoBitrateKbps: 800 },
      idempotencyKey: "cleanup-cancelled-export",
    }));
    value(await agent.callCommand("job.cancel", { jobId: interrupted.jobId }));
    await vi.waitFor(async () => {
      const status = value(await agent!.callCommand<any>("job.status", { jobId: interrupted.jobId }));
      expect(["error", "cancelled"]).toContain(status.state);
    }, { timeout: 120_000, interval: 500 });
    const failedJobPlan = value(await agent.callCommand<any>("media.cleanup.plan", {
      ...target, action: "purge-failed-jobs", jobIds: [interrupted.jobId],
    }));
    expect(failedJobPlan.status).toBe("ready");
    expect(failedJobPlan.confirmation.jobFiles).toHaveLength(2);
    expect(failedJobPlan.reclaimableBytes).toBeGreaterThan(0);
    const { target: failedTarget, ...failedScope } = failedJobPlan.confirmation;
    const failedCleanup = value(await agent.callCommand<any>("media.cleanup.execute", {
      ...failedTarget, ...failedScope, confirmed: true,
    }));
    expect(failedCleanup.deletedJobIds).toEqual([interrupted.jobId]);
    expect(failedCleanup.reclaimedBytes).toBe(failedJobPlan.reclaimableBytes);
    expect(failedJobPlan.confirmation.jobFiles.every((file: { path: string }) => !existsSync(file.path))).toBe(true);
    // Fail the real producer's final rename and its own cleanup, leaving an
    // actual encoded attempt in this isolated profile for the cleanup path.
    await app.evaluate(async (_electron, isolatedRoot) => {
      const filesystem = (process as any).getBuiltinModule("fs/promises");
      const originalRename = filesystem.rename;
      const originalRm = filesystem.rm;
      const ownsPart = (file: unknown) => String(file).startsWith(isolatedRoot) && String(file).endsWith("output.mp4.part");
      filesystem.rename = async (from, to) => {
        if (ownsPart(from)) throw new Error("Injected export publish failure");
        return originalRename(from, to);
      };
      filesystem.rm = async (file, options) => {
        if (ownsPart(file)) throw new Error("Injected export cleanup failure");
        return originalRm(file, options);
      };
      (globalThis as any).__cleanupRestoreFileOperations = () => {
        filesystem.rename = originalRename;
        filesystem.rm = originalRm;
      };
    }, runDir);
    let residualJobId: string;
    try {
      const failed = value(await agent.callCommand<any>("export.start", {
        ...target, expectedRevision: before.revision,
        settings: { width: 320, height: 180, frameRate: 24, videoBitrateKbps: 800 },
        idempotencyKey: "cleanup-real-residual",
      }));
      residualJobId = failed.jobId;
      await vi.waitFor(async () => {
        const status = value(await agent!.callCommand<any>("job.status", { jobId: failed.jobId }));
        expect(status.state).toBe("error");
        expect(status.artifactFiles.some((file: { fileId: string }) => file.fileId === "export-output-part")).toBe(true);
      }, { timeout: 120_000, interval: 300 });
    } finally {
      await app.evaluate(() => (globalThis as any).__cleanupRestoreFileOperations());
    }
    const residualReview = value(await agent.callCommand<any>("media.cleanup.review", target));
    const residualFile = residualReview.workFiles.files.find((file: any) => file.jobId === residualJobId && file.fileId === "export-output-part");
    expect(residualFile?.sizeBytes).toBeGreaterThan(0);
    expect(residualFile?.retainedReason).toBeUndefined();
    expect(existsSync(residualFile.path)).toBe(true);
    const recordsWhileArtifactsExist = value(await agent.callCommand<any>("media.cleanup.plan", { ...target, action: "purge-failed-jobs", jobIds: [residualJobId] }));
    expect(recordsWhileArtifactsExist.status).toBe("review-required");
    await page.getByRole("button", { name: "重新审查", exact: true }).click();
    await page.getByText("source / work / project / output 文件审查", { exact: true }).click();
    await page.getByRole("checkbox", { name: `选择过程文件 ${residualFile.selectionId}`, exact: true }).check();
    await page.getByLabel("整理动作").selectOption("purge-work-files");
    await page.getByRole("button", { name: "现在整理 · 生成审查计划", exact: true }).click();
    await page.getByTestId("cleanup-confirmation").getByText(residualFile.path, { exact: true }).waitFor();
    await page.getByRole("button", { name: "确认执行此计划", exact: true }).click();
    await vi.waitFor(() => expect(existsSync(residualFile.path)).toBe(false));
    const workResult = page.getByRole("status").filter({ has: page.getByRole("heading", { name: "整理结果", exact: true }) });
    await vi.waitFor(async () => {
      const resultText = await workResult.textContent();
      expect(resultText).toContain("1 个过程文件");
      expect(resultText).toContain(`实际释放 ${(residualFile.sizeBytes / 1024).toFixed(1)} KiB`);
      expect(resultText).toContain(`已删除 ${residualFile.path}`);
    });
    const remainingResidual = value(await agent.callCommand<any>("media.cleanup.review", target));
    expect(remainingResidual.workFiles.files.some((file: any) => file.jobId === residualJobId)).toBe(false);
    expect(existsSync(source) && existsSync(output)).toBe(true);
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await page.screenshot({ path: path.join(ARTIFACTS_DIR, "export-cleanup-confirmed.png") });
    await agent.close();
    agent = undefined;
    launched = await launched.relaunch();
    await openRecentProjectViaUI(launched.page, before.project.name);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    agent = await connectExternalAgent(launched.endpointFile);
    const after = value(
      await agent.callCommand<any>("project.get_state", target),
    );
    expect(after.project.mediaLibrary.items[0].id).toBe(
      before.project.mediaLibrary.items[0].id,
    );
    expect(
      after.project.timeline.tracks.flatMap((track: any) => track.clips).length,
    ).toBeGreaterThan(0);
    expect(existsSync(output)).toBe(true);
    const reexport = path.join(runDir, "cleanup-retained-reexport.mp4");
    for (const dismiss of await launched.page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) await dismiss.click();
    await launched.app.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, reexport);
    await launched.page
      .getByRole("button", { name: "Export", exact: true })
      .click();
    await launched.page
      .getByRole("radio", { name: "Custom", exact: true })
      .click();
    await launched.page
      .getByRole("button", { name: "Start Export", exact: true })
      .click();
    await vi.waitFor(
      () =>
        expect(existsSync(reexport) && statSync(reexport).size > 0).toBe(true),
      { timeout: 120_000 },
    );
    await launched.page
      .getByText("导出完成", { exact: false })
      .first()
      .waitFor({ timeout: 120_000 });
    execFileSync(
      ffmpeg,
      ["-v", "error", "-xerror", "-i", reexport, "-f", "null", "-"],
      { timeout: 60_000, windowsHide: true },
    );
    const frameAt = (filePath: string, time: number) => execFileSync(ffmpeg, [
      "-v", "error", "-ss", String(time), "-i", filePath, "-frames:v", "1", "-vf", "scale=32:18,format=rgb24", "-f", "rawvideo", "pipe:1",
    ], { timeout: 30_000, windowsHide: true });
    const errorBetween = (left: Buffer, right: Buffer) => left.reduce((total, value, index) => total + Math.abs(value - right[index]), 0) / left.length;
    const samples = [0.2, 1.2, 2.2].map((time) => {
      const sourcePixels = frameAt(source, time);
      const originalPixels = frameAt(output, time);
      const retainedPixels = frameAt(reexport, time);
      expect(originalPixels.length).toBe(32 * 18 * 3);
      expect(retainedPixels.length).toBe(originalPixels.length);
      expect(Math.max(...originalPixels) - Math.min(...originalPixels)).toBeGreaterThan(50);
      const retainedError = errorBetween(retainedPixels, originalPixels);
      const sourceError = errorBetween(sourcePixels, originalPixels);
      expect(retainedError).toBeLessThan(1);
      expect(sourceError).toBeLessThan(20);
      return { time, retainedError, sourceError };
    });
    const temporalDifference = errorBetween(frameAt(output, 0.2), frameAt(output, 2.2));
    expect(temporalDifference).toBeGreaterThan(3);
    await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "export-cleanup-reopened.png") });
    writeFileSync(path.join(ARTIFACTS_DIR, "export-cleanup-acceptance.json"), JSON.stringify({
      target, cancelledExportJobId: interrupted.jobId,
      nodePurge: result, failedTaskCleanup: failedCleanup,
      firstExportBytes: statSync(output).size, retainedReexportBytes: statSync(reexport).size,
      bothExportsFullyDecoded: true, originalPreserved: existsSync(source),
      representativeFrames: samples, temporalDifference,
      clipboardHostRoundTrip, copiedPromptValidated: true,
      realProducerResidual: { jobId: residualJobId, path: residualFile.path, reclaimedBytes: residualFile.sizeBytes, removed: !existsSync(residualFile.path) },
      retainedMediaId: after.project.mediaLibrary.items[0].id,
    }, null, 2));
  } catch (error) {
    mkdirSync(ARTIFACTS_DIR, { recursive: true });
    await launched.page.screenshot({ path: path.join(ARTIFACTS_DIR, "export-cleanup-failed.png") }).catch(() => undefined);
    throw error;
  } finally {
    await agent?.close();
    await launched.close();
  }
}, 600_000);
