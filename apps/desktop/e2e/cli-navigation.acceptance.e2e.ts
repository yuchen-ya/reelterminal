import { openOrCreateBoard, openWorkspaceDirectory } from "./harness/workspace-tabs";
import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test } from "vitest";
import { CAPABILITY_DEFINITIONS } from "@reelterminal/agent-facade/capability-registry";
import { EDIT_OP_TYPES, FACADE_VERBS } from "@reelterminal/agent-facade/types";
import { decodeAgentTarget } from "../src/shared/agent-target";
import { launchApp } from "./harness/launch";
import { REELCTL_PATH } from "./harness/paths";
import { connectExternalAgent, value } from "./harness/cli-client";
import { createEvidence } from "./harness/evidence";
import { createProjectViaUI } from "./harness/ui";

function cli(endpointFile: string, args: string[]) {
  return new Promise<{ code: number | null; result: any; bytes: number }>((resolve, reject) => {
    const child = spawn(process.execPath, [REELCTL_PATH, ...args], {
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: endpointFile },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += String(chunk); });
    child.stderr.on("data", chunk => { stderr += String(chunk); });
    child.once("error", reject);
    child.once("close", code => {
      try { resolve({ code, result: JSON.parse(stdout), bytes: Buffer.byteLength(stdout) }); }
      catch { reject(new Error(`CLI returned non-JSON (${code}): ${stderr}`)); }
    });
  });
}

test("compact navigation stays bound to explicit GUI targets and local discovery needs no endpoint", async () => {
  let launched = await launchApp();
  await launched.waitForEndpointFile();
  const evidence = createEvidence("cli-navigation-acceptance", launched.page);
  let agent = await connectExternalAgent(launched.endpointFile);
  const sizes: Record<string, number> = {};
  try {
    const absentEndpoint = path.join(launched.runDir, "deliberately-absent-endpoint.json");
    for (const args of [["tools"], ["tools", "video"], ["tools", "video.export"], ["describe", "edit.apply", "--op", "clip.trim", "--op", "clip.split"]]) {
      const reply = await cli(absentEndpoint, args);
      expect(reply.code).toBe(0);
      expect(reply.result.ok).toBe(true);
      sizes[args.join(" ")] = reply.bytes;
      if (args[0] === "tools") expect(JSON.stringify(reply.result)).not.toMatch(/inputSchema|outputSchema|"ready":true/);
      else {
        const contract = reply.result.value;
        expect(contract.inputSchema.properties.ops.items.anyOf.map((variant: any) => variant.properties.op.const)).toEqual(["clip.trim", "clip.split"]);
        expect(contract.inputSchema.required).toEqual(expect.arrayContaining(["projectId", "workspaceId", "ops"]));
        expect(contract.inputSchema.properties).toHaveProperty("expectedRevision");
        expect(contract.inputSchema.properties).toHaveProperty("idempotencyKey");
        expect(contract).not.toHaveProperty("outputSchema");
      }
    }
    await createProjectViaUI(launched.page);
    const context = value(await agent.callCommand<{ identity: { projectId: string; workspaceId: string }; projectRevision: number }>("editor.get_context"));
    const videoIdentity = { projectId: context.identity.projectId, workspaceId: context.identity.workspaceId };
    const info = await launched.page.evaluate(target => window.reelterminal!.collabControl!.getStartupInfo(target), { kind: "video" as const, ...videoIdentity });
    const videoRef = info.startCommand!.split("--target ")[1];
    const videoTarget = decodeAgentTarget(videoRef);
    expect(Object.keys(videoTarget).sort()).toEqual(["hostInstanceId", "instanceId", "kind", "projectId", "workspaceId"]);
    const videoStart = await cli(launched.endpointFile, ["start", "--target", videoRef]);
    expect(videoStart.result).toMatchObject({ ok: true, value: { access: "read-only", target: videoTarget, revision: context.projectRevision } });
    sizes["start video"] = videoStart.bytes;
    expect(videoStart.bytes).toBeLessThan(1800);
    const beforeReview = await agent.callCommand("project.get_state", videoIdentity);
    await launched.page.getByRole("tab", { name: /Review Workspace|审阅工作台/i }).click();
    await openWorkspaceDirectory(launched.page);
    expect(await launched.page.getByTestId("folder-task-directory").count()).toBe(1);
    expect(await launched.page.getByTestId("review-new-task").count()).toBe(0);
    const retired = await agent.callCommand("review.context");
    expect(retired).toMatchObject({ ok: false, error: { code: "UNSUPPORTED" } });
    expect(await agent.callCommand("project.get_state", videoIdentity)).toEqual(beforeReview);
    await openOrCreateBoard(launched.page);
    expect((await cli(launched.endpointFile, ["start", "--target", videoRef])).result.value.target).toEqual(videoTarget);
    expect(await launched.page.locator('[data-testid^="board-tab-"]').first().getAttribute("aria-selected")).toBe("true");
    expect(await launched.page.getByTestId("review-start-command").count()).toBe(0);
    await evidence.screenshot("background-target-on-private-board");
    const fullEdit = await cli(launched.endpointFile, ["schema", "edit.apply"]);
    sizes["schema edit.apply"] = fullEdit.bytes;
    sizes["describe edit.apply --op clip.split"] = (await cli(absentEndpoint, ["describe", "edit.apply", "--op", "clip.split"])).bytes;
    const session = await cli(launched.endpointFile, ["call", "session.describe", "--kind", "video"]);
    expect(session.result.ok).toBe(true);
    sizes["call session.describe video"] = session.bytes;
    expect(sizes["describe edit.apply --op clip.trim --op clip.split"]).toBeLessThan(sizes["schema edit.apply"] / 3);
    expect(sizes["start video"]).toBeLessThan(sizes["call session.describe video"]);
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    evidence.bindPage(launched.page);
    await launched.waitForEndpointFile();
    expect((await cli(launched.endpointFile, ["status"])).code).toBe(0);
    for (const ref of [videoRef]) {
      const stale = await cli(launched.endpointFile, ["start", "--target", ref]);
      expect(stale.code).toBe(3);
      expect(stale.result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    }
    evidence.record("responseBytes", sizes);
    evidence.record("registryCounts", { domains: 4, capabilities: CAPABILITY_DEFINITIONS.length, commands: FACADE_VERBS.length, editOperations: EDIT_OP_TYPES.length });
    evidence.record("contracts", { localDiscoveryWithoutEndpoint: true, fixedVideoTarget: true, retiredBatchRejected: true, readOnly: true, privateBoardStaysSelected: true, staleRuntimeRejected: true });
  } finally {
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
