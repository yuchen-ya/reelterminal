/**
 * Legacy safety (D) — the live endpoint exposes EXACTLY the 15 facade tools
 * (ADR 0004 Decisions 4 + 9): no internal-registry tool (e.g. the legacy
 * desktop MCP's execute_action) leaks onto the external surface, and an
 * unknown tool name is a JSON-RPC protocol error, never a domain result.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

const EXPECTED_TOOLS = [
  "session_describe",
  "capabilities_get",
  "project_create",
  "project_open",
  "project_save",
  "project_get_state",
  "media_import",
  "timeline_get",
  "editor_get_context",
  "edit_apply",
  "preview_render_frame",
  "export_start",
  "job_status",
  "job_cancel",
  "verify_artifact",
] as const;

describe("legacy safety: tools/list is exactly the 15 facade tools", () => {
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

  test("tools/list returns exactly the 15 facade tools with schemas", async () => {
    const { tools } = await agent.client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([...EXPECTED_TOOLS].sort());
    // No internal-registry tool leaks onto the external surface.
    expect(names).not.toContain("execute_action");
    for (const tool of tools) {
      expect(tool.inputSchema?.type).toBe("object");
      expect(typeof tool.description).toBe("string");
    }
    evidence.record("tools_list", {
      count: names.length,
      names,
      hasExecuteAction: names.includes("execute_action"),
    });
  });

  test("an unknown tool name is a protocol error, not a domain result", async () => {
    await expect(agent.callTool("execute_action", { action: "x" })).rejects.toThrow(
      /Unknown tool/i,
    );
    evidence.record("unknown_tool_rejected", { tool: "execute_action" });
  });
});
