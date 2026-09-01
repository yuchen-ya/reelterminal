import { describe, it, expect, afterEach, vi } from "vitest";
import { EMITTED_VERB_JSON_SCHEMAS } from "@openreel/agent-facade/jsonschema";
import {
  facadeAnthropicTools,
  facadeOpenAITools,
  facadeChatExecutor,
  facadeGating,
  toolNameForVerb,
  verbForToolName,
  LIVE_COLLAB_SYSTEM_PROMPT,
} from "./facade-chat";

const mockFacadeCall = (
  impl: (verb: string, params: unknown) => Promise<unknown>,
) => {
  const call = vi.fn(impl);
  (window as { openreel?: unknown }).openreel = {
    platform: "desktop",
    facade: { call },
  };
  return call;
};

describe("facade-chat adapter (ADR 0004 Decision 8)", () => {
  afterEach(() => {
    delete (window as { openreel?: unknown }).openreel;
    vi.restoreAllMocks();
  });

  it("exposes every facade verb as an MCP-spelled tool", () => {
    const verbs = Object.keys(EMITTED_VERB_JSON_SCHEMAS);
    expect(verbs).toContain("editor.get_context");

    const anthropic = facadeAnthropicTools();
    expect(anthropic).toHaveLength(verbs.length);
    for (const tool of anthropic) {
      expect(tool.name).not.toContain(".");
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input_schema).toBeTruthy();
    }
    expect(anthropic.map((t) => t.name)).toContain("edit_apply");
    expect(anthropic.map((t) => t.name)).toContain("editor_get_context");

    const openai = facadeOpenAITools();
    expect(openai).toHaveLength(verbs.length);
    expect(openai[0].type).toBe("function");
    expect(openai[0].function.parameters).toBeTruthy();
  });

  it("maps tool names to verbs losslessly (dots vs underscores)", () => {
    expect(toolNameForVerb("project.get_state")).toBe("project_get_state");
    expect(verbForToolName("project_get_state")).toBe("project.get_state");
    expect(verbForToolName("edit_apply")).toBe("edit.apply");
    expect(verbForToolName("no_such_tool")).toBeNull();
  });

  it("executor maps edit_apply to the facade verb and summarizes", async () => {
    const call = mockFacadeCall(async (verb, params) => {
      expect(verb).toBe("edit.apply");
      expect(params).toEqual({ ops: [], expectedContextRevision: 12 });
      return {
        ok: true,
        data: {
          revision: 7,
          applied: [
            { op: "text.create", createdIds: ["text-1"] },
            { op: "track.add", createdIds: ["track-9"] },
          ],
          replayed: false,
        },
      };
    });

    const result = await facadeChatExecutor(
      "edit_apply",
      { ops: [], expectedContextRevision: 12 },
      {} as never,
    );
    expect(call).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Applied text.create, track.add (revision 7)",
    );
    expect(result.summary).not.toContain("{");
    const data = result.data as { revision?: number; affectedIds?: string[] };
    expect(data.revision).toBe(7);
    expect(data.affectedIds).toEqual(["text-1", "track-9"]);
  });

  it("executor summarizes editor_get_context with both revisions", async () => {
    mockFacadeCall(async () => ({
      ok: true,
      data: {
        mode: "live",
        projectRevision: 7,
        contextAvailable: true,
        contextRevision: 12,
        playheadSeconds: 3.5,
        selectedClipIds: [],
        selectedTextIds: ["text-1"],
        timeRange: null,
        canvasPoint: { x: 0.5, y: 0.5 },
        identity: { projectId: "p", projectName: "P", windowId: "main" },
      },
    }));

    const result = await facadeChatExecutor("editor_get_context", {}, {} as never);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Read live context (project rev 7, context rev 12)");
    expect((result.data as { revision?: number }).revision).toBe(7);
  });

  it("executor accepts the in-process FacadeResult { ok, value } shape too", async () => {
    mockFacadeCall(async () => ({
      ok: true,
      value: { revision: 3, tracks: [] },
    }));
    const result = await facadeChatExecutor("timeline_get", {}, {} as never);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Read timeline (0 tracks)");
  });

  it("executor converts facade errors without leaking raw JSON", async () => {
    mockFacadeCall(async () => ({
      ok: false,
      error: {
        code: "CONFLICT",
        message: "Project revision mismatch",
        details: { currentRevision: 9 },
      },
    }));
    const result = await facadeChatExecutor("edit_apply", { ops: [] }, {} as never);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Project revision mismatch");
    expect(result.error).toEqual({
      code: "CONFLICT",
      message: "Project revision mismatch",
    });
  });

  it("executor reports unknown tools and a missing bridge honestly", async () => {
    mockFacadeCall(async () => ({ ok: true, data: {} }));
    const unknown = await facadeChatExecutor("nope", {}, {} as never);
    expect(unknown.ok).toBe(false);
    expect(unknown.error?.code).toBe("UNKNOWN_TOOL");

    delete (window as { openreel?: unknown }).openreel;
    const noBridge = await facadeChatExecutor("timeline_get", {}, {} as never);
    expect(noBridge.ok).toBe(false);
    expect(noBridge.error?.code).toBe("HOST_UNAVAILABLE");
  });

  it("gating marks read-only verbs and export as expensive, nothing destructive", () => {
    expect(facadeGating.isReadOnly("editor_get_context")).toBe(true);
    expect(facadeGating.isReadOnly("timeline_get")).toBe(true);
    expect(facadeGating.isReadOnly("project_get_state")).toBe(true);
    expect(facadeGating.isReadOnly("edit_apply")).toBe(false);
    expect(facadeGating.isExpensive("export_start")).toBe(true);
    expect(facadeGating.isExpensive("edit_apply")).toBe(false);
    expect(facadeGating.isDestructive("edit_apply")).toBe(false);
    expect(facadeGating.isDestructive("job_cancel")).toBe(false);
  });

  it("system prompt encodes the live-collaboration rules", () => {
    expect(LIVE_COLLAB_SYSTEM_PROMPT).toContain("editor_get_context");
    expect(LIVE_COLLAB_SYSTEM_PROMPT).toContain("expectedContextRevision");
    expect(LIVE_COLLAB_SYSTEM_PROMPT).toContain("CONFLICT");
    expect(LIVE_COLLAB_SYSTEM_PROMPT.length).toBeLessThan(4000);
  });
});
