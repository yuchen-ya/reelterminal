/**
 * The live endpoint exposes the complete generated facade catalog: no
 * internal-registry tool (e.g. the desktop's execute_action) leaks onto
 * the external surface, and an unknown tool name is a CLI invocation
 * error, never a domain result.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FACADE_VERBS } from "@reelterminal/agent-facade";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/cli-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

describe("CLI schema is exactly the facade command registry", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;
  let target: { projectId: string; workspaceId: string };

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("tools-list", launched.page);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
    const context = await agent.callCommand<{ identity: typeof target }>("editor.get_context");
    expect(context.ok).toBe(true);
    target = { projectId: context.value!.identity.projectId, workspaceId: context.value!.identity.workspaceId };
  }, 300_000);

  afterAll(async () => {
    evidence.flush();
    await agent?.close();
    await launched?.close();
  });

  test("CLI schema returns the complete generated facade catalog with schemas", async () => {
    const commands = await agent.listCommands();
    const tools = [];
    for (const command of commands) tools.push(await agent.schema(command.name));
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...FACADE_VERBS].sort());
    // No internal-registry tool leaks onto the external surface.
    expect(names).not.toContain("execute_action");
    for (const tool of tools) {
      expect(tool.inputSchema?.type).toBe("object");
      expect(typeof tool.description).toBe("string");
    }
    // Live save creates a guarded immutable workspace node and must not
    // advertise the headless filesystem `path` argument.
    const projectSave = tools.find((t) => t.name === "project.save");
    expect(
      (projectSave?.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    ).not.toContain("path");
    expect((projectSave?.inputSchema as { required?: string[] })?.required).toEqual(
      expect.arrayContaining(["projectId", "workspaceId", "expectedRevision", "idempotencyKey"]),
    );
    evidence.record("tools_list", {
      count: names.length,
      names,
      hasExecuteAction: names.includes("execute_action"),
    });
  });

  test("the seven post-slice tools traverse the shipped CLI and live facade", async () => {
    const initial = await agent.callCommand<{ revision: number; project: { name: string } }>(
      "project.get_state",
      target,
    );
    expect(initial.ok).toBe(true);
    const baseRevision = initial.value!.revision;

    const renamed = await agent.callCommand<{
      revision: number;
      previousName: string;
      name: string;
    }>("project.rename", {
      ...target,
      name: "Live Registry E2E",
      expectedRevision: baseRevision,
      idempotencyKey: "tools-list-rename",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.value).toMatchObject({
      previousName: initial.value!.project.name,
      name: "Live Registry E2E",
    });

    const changes = await agent.callCommand<{ changes: unknown[] }>(
      "project.changes",
      { ...target, sinceRevision: baseRevision },
    );
    expect(changes.ok).toBe(true);
    expect(changes.value!.changes.length).toBeGreaterThan(0);

    // technicalQuality is the one honestly available analysis type. A
    // missing media id is a facade domain result, proving the call traversed
    // the CLI instead of failing command discovery.
    const analysis = await agent.callCommand("media.analyze_start", {
      ...target,
      mediaId: "missing-media",
      analysisTypes: ["technicalQuality"],
    });
    expect(analysis.ok).toBe(false);
    expect(analysis.error?.code).toBe("NOT_FOUND");

    const query = await agent.callCommand<{ items: unknown[] }>("timeline.query", target);
    expect(query.ok).toBe(true);
    expect(query.value!.items).toEqual([]);

    const validated = await agent.callCommand<{ valid: boolean }>("edit.validate", {
      ...target,
      ops: [{ op: "track.add", trackType: "video", trackId: "dry-run-track" }],
      expectedRevision: renamed.value!.revision,
    });
    expect(validated.ok).toBe(true);
    expect(validated.value!.valid).toBe(true);

    const stateAfterValidate = await agent.callCommand<{
      revision: number;
      project: { timeline: { tracks: Array<{ id: string }> } };
    }>("project.get_state", target);
    expect(stateAfterValidate.value!.revision).toBe(renamed.value!.revision);
    expect(stateAfterValidate.value!.project.timeline.tracks).not.toContainEqual(
      expect.objectContaining({ id: "dry-run-track" }),
    );

    const history = await agent.callCommand<{ canUndo: boolean }>("history.get", target);
    expect(history.ok).toBe(true);
    expect(history.value!.canUndo).toBe(true);

    const undone = await agent.callCommand<{
      revision: number;
      replayed: boolean;
    }>("history.control", {
      ...target,
      action: "undo",
      expectedRevision: renamed.value!.revision,
      idempotencyKey: "tools-list-undo",
    });
    expect(undone.ok).toBe(true);
    expect(undone.value!.replayed).toBe(false);

    const replayed = await agent.callCommand<{ revision: number; replayed: boolean }>(
      "history.control",
      {
        ...target,
        action: "undo",
        expectedRevision: renamed.value!.revision,
        idempotencyKey: "tools-list-undo",
      },
    );
    expect(replayed.ok).toBe(true);
    expect(replayed.value).toMatchObject({
      revision: undone.value!.revision,
      replayed: true,
    });

    evidence.record("post_slice_tool_routing", {
      tools: [
        "project.rename",
        "project.changes",
        "media.analyze_start",
        "timeline.query",
        "edit.validate",
        "history.get",
        "history.control",
      ],
      baseRevision,
      renamedRevision: renamed.value!.revision,
      undoRevision: undone.value!.revision,
      analysisDomainError: analysis.error?.code,
    });
  });

  test("an unknown command is a CLI invocation error", async () => {
    await expect(agent.callCommand("execute_action", { action: "x" })).rejects.toThrow(
      /canonical dotted command.*toolName is not an alias/i,
    );
    evidence.record("unknown_tool_rejected", { tool: "execute_action" });
  });
});
