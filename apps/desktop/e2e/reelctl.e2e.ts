import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { DESKTOP_DIR } from "./harness/paths";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createProjectViaUI, createTextClipViaUI, enableAgentSessionViaUI, timelineTextClip } from "./harness/ui";

interface Context {
  projectRevision: number;
  contextRevision: number;
  selectedTextIds: string[];
  identity: { projectId: string; projectEpoch: string };
}

describe("reelctl against a real desktop project", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  const cli = (args: string[]) => new Promise<{ code: number | null; result: any; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(DESKTOP_DIR, "dist/reelctl/index.js"), ...args], {
      env: { ...process.env, REELTERMINAL_LIVE_ENDPOINT_FILE: launched.endpointFile },
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", reject);
    child.on("close", (code) => {
      try { resolve({ code, result: JSON.parse(stdout), stderr }); } catch { reject(new Error(`CLI failed to return JSON (${code}): ${stderr}`)); }
    });
  });
  beforeAll(async () => {
    launched = await launchApp();
    await createProjectViaUI(launched.page);
    await createTextClipViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
  });
  afterAll(async () => { await agent?.close(); await launched?.close(); });

  test("separate CLI processes and MCP read the same live project", async () => {
    const status = await cli(["status"]);
    const context = await cli(["context", "--compact"]);
    const mcp = await agent.callTool<Context>("editor_get_context");
    expect(status.code).toBe(0);
    expect(context.code).toBe(0);
    expect(context.result.value.identity.projectId).toBe(status.result.value.projectId);
    expect(context.result.value.identity.projectEpoch).toBe(status.result.value.projectEpoch);
    expect(mcp.value?.identity).toEqual(context.result.value.identity);
  });

  test("CLI applies one shared undo unit and MCP replays its idempotency key", async () => {
    const context = (await cli(["context"])).result.value as Context;
    expect(context.selectedTextIds).toHaveLength(1);
    const args = {
      ops: [{ op: "text.update", overlayId: context.selectedTextIds[0], text: "CLI and MCP share one project" }],
      expectedRevision: context.projectRevision,
      expectedContextRevision: context.contextRevision,
      idempotencyKey: "cli-mcp-one-commit",
    };
    const file = path.join(launched.runDir, "edit.json");
    writeFileSync(file, JSON.stringify({
      arguments: args,
      expectedProjectId: context.identity.projectId,
      expectedProjectEpoch: context.identity.projectEpoch,
    }));
    const applied = await cli(["edit", "apply", "--file", file]);
    expect(applied.code).toBe(0);
    expect(applied.result.ok).toBe(true);
    await timelineTextClip(launched.page, "CLI and MCP share one project").waitFor();
    const replay = await agent.callTool<{ revision: number }>("edit_apply", args);
    expect(replay.ok).toBe(true);
    expect(replay.value?.revision).toBe(applied.result.value.revision);
    const next = (await cli(["context"])).result.value as Context;
    expect(next.projectRevision).toBe(applied.result.value.revision);
    const undone = await cli(["history", "undo", "--expected-revision", String(next.projectRevision),
      "--project-id", next.identity.projectId, "--project-epoch", next.identity.projectEpoch]);
    expect(undone.code, JSON.stringify({ result: undone.result, stderr: undone.stderr }).replace(/\b[a-f0-9]{64}\b/gi, "[redacted]")).toBe(0);
    await timelineTextClip(launched.page, "New Title").waitFor();
  });

  test("stale revision fails without changing the GUI", async () => {
    const context = (await cli(["context"])).result.value as Context;
    const file = path.join(launched.runDir, "stale-edit.json");
    writeFileSync(file, JSON.stringify({
      arguments: { expectedRevision: 0, ops: [{ op: "track.add", trackType: "video" }] },
      expectedProjectId: context.identity.projectId,
      expectedProjectEpoch: context.identity.projectEpoch,
    }));
    const stale = await cli(["edit", "apply", "--file", file]);
    expect(stale.code).toBe(3);
    expect(stale.result).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect((await cli(["context"])).result.value.projectRevision).toBe(context.projectRevision);
  });
});
