import { spawn } from "node:child_process";
import path from "node:path";
import { expect, test, vi } from "vitest";
import type { ReviewContext, ReviewNode } from "@reelterminal/core/review/types";
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
    for (const args of [["tools"], ["tools", "review"], ["tools", "review.image-repair"], ["describe", "edit.apply", "--op", "clip.trim", "--op", "clip.split"]]) {
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
    const createNode = async (name: string) => {
      await launched.page.getByTestId("review-new-task").click();
      await launched.page.getByLabel(/Task name|任务名称/).fill(name);
      await launched.page.getByTestId("review-create-node").click();
      await launched.page.getByTestId("review-node-title").waitFor();
    };
    await createNode("Bootstrap task A");
    const reviewContext = value(await agent.callCommand<ReviewContext>("review.context"));
    const nodes = value(await agent.callCommand<{ nodes: ReviewNode[] }>("review.nodes.list", { target: reviewContext.target })).nodes;
    const node = nodes.find(candidate => candidate.name === "Bootstrap task A")!;
    const reviewTarget = { ...reviewContext.target, nodeId: node.id };
    await launched.page.getByRole("button", { name: "Copy connection instructions", exact: true }).click();
    await vi.waitFor(async () => {
      const text = await launched.page.evaluate(() => navigator.clipboard.readText());
      expect(text).toContain(`--target rt1.`);
      expect(decodeAgentTarget(text.split("--target ")[1])).toEqual(reviewTarget);
    });
    const copied = await launched.page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toMatch(/^Run now: node '.+dist[\\/]reelctl[\\/]index\.js' start --target rt1\.[A-Za-z0-9_-]+$/);
    const reviewRef = copied.split("--target ")[1];
    expect(decodeAgentTarget(reviewRef)).toEqual(reviewTarget);
    const baselineNodes = await agent.callCommand("review.nodes.list", { target: reviewContext.target });
    const reviewStart = await cli(launched.endpointFile, ["start", "--target", reviewRef]);
    expect(reviewStart.result).toMatchObject({ ok: true, value: { target: reviewTarget, access: "read-only", revision: 0, name: node.name } });
    expect(Object.keys(reviewStart.result.value).sort()).toEqual(["access", "binding", "connected", "name", "next", "revision", "target"]);
    sizes["start review"] = reviewStart.bytes;
    expect(reviewStart.bytes).toBeLessThan(1800);
    expect(await agent.callCommand("review.nodes.list", { target: reviewContext.target })).toEqual(baselineNodes);
    expect(await agent.callCommand("project.get_state", videoIdentity)).toEqual(beforeReview);
    await createNode("Bootstrap task B");
    const bound = await cli(launched.endpointFile, ["start", "--target", reviewRef]);
    expect(bound.result.value.target).toEqual(reviewTarget);
    expect(bound.result.value.name).toBe("Bootstrap task A");
    expect(await launched.page.getByTestId("review-node-title").textContent()).toBe("Bootstrap task B");
    await launched.page.getByTestId("human-board-tab").click();
    await launched.page.getByTestId("human-board-home").waitFor();
    expect((await cli(launched.endpointFile, ["start", "--target", videoRef])).result.value.target).toEqual(videoTarget);
    expect((await cli(launched.endpointFile, ["start", "--target", reviewRef])).result.value.target).toEqual(reviewTarget);
    expect(await launched.page.getByTestId("human-board-tab").getAttribute("class")).toContain("bg-accent");
    await evidence.screenshot("background-target-on-private-board");
    const fullEdit = await cli(launched.endpointFile, ["schema", "edit.apply"]);
    sizes["schema edit.apply"] = fullEdit.bytes;
    sizes["describe edit.apply --op clip.split"] = (await cli(absentEndpoint, ["describe", "edit.apply", "--op", "clip.split"])).bytes;
    const session = await cli(launched.endpointFile, ["call", "session.describe", "--kind", "review"]);
    expect(session.result.ok).toBe(true);
    sizes["call session.describe review"] = session.bytes;
    expect(sizes["describe edit.apply --op clip.trim --op clip.split"]).toBeLessThan(sizes["schema edit.apply"] / 3);
    expect(sizes["start review"]).toBeLessThan(sizes["call session.describe review"]);
    await agent.close();
    launched = await launched.relaunch();
    agent = await connectExternalAgent(launched.endpointFile);
    evidence.bindPage(launched.page);
    await vi.waitFor(async () => expect((await agent.callCommand("review.context")).ok).toBe(true), { timeout: 10_000 });
    for (const ref of [videoRef, reviewRef]) {
      const stale = await cli(launched.endpointFile, ["start", "--target", ref]);
      expect(stale.code).toBe(3);
      expect(stale.result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    }
    evidence.record("responseBytes", sizes);
    evidence.record("registryCounts", { domains: 4, capabilities: CAPABILITY_DEFINITIONS.length, commands: FACADE_VERBS.length, editOperations: EDIT_OP_TYPES.length });
    evidence.record("contracts", { localDiscoveryWithoutEndpoint: true, fixedVideoAndReviewTargets: true, readOnly: true, privateBoardStaysSelected: true, staleRuntimeRejected: true });
  } finally {
    evidence.flush();
    await agent.close();
    await launched.close();
  }
});
