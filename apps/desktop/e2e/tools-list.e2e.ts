/**
 * Legacy safety (D) — the live endpoint exposes EXACTLY the 24 facade tools
 * (ADR 0004 Decisions 4 + 9): no internal-registry tool (e.g. the legacy
 * desktop MCP's execute_action) leaks onto the external surface, and an
 * unknown tool name is a JSON-RPC protocol error, never a domain result.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FACADE_TOOL_NAMES } from "@openreel/agent-facade";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

describe("legacy safety: tools/list is exactly the facade tool registry", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent;
  let evidence: EvidenceRecord;

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("tools-list", launched.page);
    await createProjectViaUI(launched.page);
    await enableAgentSessionViaUI(launched.page, launched.endpointFile);
    await launched.waitForEndpointFile();
    agent = await connectExternalAgent(launched.endpointFile);
  }, 300_000);

  afterAll(async () => {
    evidence.flush();
    await agent?.close();
    await launched?.close();
  });

  test("tools/list returns exactly the 24 facade tools with schemas", async () => {
    const { tools } = await agent.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...FACADE_TOOL_NAMES].sort());
    // No internal-registry tool leaks onto the external surface.
    expect(names).not.toContain("execute_action");
    for (const tool of tools) {
      expect(tool.inputSchema?.type).toBe("object");
      expect(typeof tool.description).toBe("string");
    }
    // Live-honest contract: live project.save takes no params (the GUI owns
    // the save target) and must not advertise the headless `path` argument.
    const projectSave = tools.find((t) => t.name === "project_save");
    expect(
      (projectSave?.inputSchema as { required?: string[] } | undefined)?.required ?? [],
    ).not.toContain("path");
    evidence.record("tools_list", {
      count: names.length,
      names,
      hasExecuteAction: names.includes("execute_action"),
    });
  });

  test("the seven post-slice tools traverse the shipped connector and live facade", async () => {
    const initial = await agent.callTool<{ revision: number; project: { name: string } }>(
      "project_get_state",
    );
    expect(initial.ok).toBe(true);
    const baseRevision = initial.value!.revision;

    const renamed = await agent.callTool<{
      revision: number;
      previousName: string;
      name: string;
    }>("project_rename", {
      name: "Live Registry E2E",
      expectedRevision: baseRevision,
      idempotencyKey: "tools-list-rename",
    });
    expect(renamed.ok).toBe(true);
    expect(renamed.value).toMatchObject({
      previousName: initial.value!.project.name,
      name: "Live Registry E2E",
    });

    const changes = await agent.callTool<{ changes: unknown[] }>(
      "project_changes",
      { sinceRevision: baseRevision },
    );
    expect(changes.ok).toBe(true);
    expect(changes.value!.changes.length).toBeGreaterThan(0);

    // technicalQuality is the one honestly available analysis type. A
    // missing media id is a facade domain result, proving the call traversed
    // the connector instead of failing as a JSON-RPC Unknown live tool.
    const analysis = await agent.callTool("media_analyze_start", {
      mediaId: "missing-media",
      analysisTypes: ["technicalQuality"],
    });
    expect(analysis.ok).toBe(false);
    expect(analysis.error?.code).toBe("NOT_FOUND");

    const query = await agent.callTool<{ items: unknown[] }>("timeline_query");
    expect(query.ok).toBe(true);
    expect(query.value!.items).toEqual([]);

    const validated = await agent.callTool<{ valid: boolean }>("edit_validate", {
      ops: [{ op: "track.add", trackType: "video", trackId: "dry-run-track" }],
      expectedRevision: renamed.value!.revision,
    });
    expect(validated.ok).toBe(true);
    expect(validated.value!.valid).toBe(true);

    const stateAfterValidate = await agent.callTool<{
      revision: number;
      project: { timeline: { tracks: Array<{ id: string }> } };
    }>("project_get_state");
    expect(stateAfterValidate.value!.revision).toBe(renamed.value!.revision);
    expect(stateAfterValidate.value!.project.timeline.tracks).not.toContainEqual(
      expect.objectContaining({ id: "dry-run-track" }),
    );

    const history = await agent.callTool<{ canUndo: boolean }>("history_get");
    expect(history.ok).toBe(true);
    expect(history.value!.canUndo).toBe(true);

    const undone = await agent.callTool<{
      revision: number;
      replayed: boolean;
    }>("history_control", {
      action: "undo",
      expectedRevision: renamed.value!.revision,
      idempotencyKey: "tools-list-undo",
    });
    expect(undone.ok).toBe(true);
    expect(undone.value!.replayed).toBe(false);

    const replayed = await agent.callTool<{ revision: number; replayed: boolean }>(
      "history_control",
      {
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
        "project_rename",
        "project_changes",
        "media_analyze_start",
        "timeline_query",
        "edit_validate",
        "history_get",
        "history_control",
      ],
      baseRevision,
      renamedRevision: renamed.value!.revision,
      undoRevision: undone.value!.revision,
      analysisDomainError: analysis.error?.code,
    });
  });

  test("an unknown tool name is a protocol error, not a domain result", async () => {
    await expect(agent.callTool("execute_action", { action: "x" })).rejects.toThrow(
      /Unknown (?:live )?tool/i,
    );
    evidence.record("unknown_tool_rejected", { tool: "execute_action" });
  });
});
