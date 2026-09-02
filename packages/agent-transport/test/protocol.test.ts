/**
 * Protocol tests (ADR 0003 deliverable 5, slice 2b): spawn the REAL
 * `agent-video serve` binary and drive the MCP handshake end to end.
 *
 *  - initialize (serverInfo carries the transport's own facts)
 *  - tools/list: exactly the 16 tools of the facade contract, inputSchemas deep-equal the
 *    facade emission EMITTED_VERB_JSON_SCHEMAS verbatim (Decision 4)
 *  - tools/call round-trips: session_describe contract `facade-slice-3`
 *    + 16 verbs; project_create/edit_apply happy path with exact revision
 *    arithmetic; CONFLICT and NOT_FOUND surface as tool-result
 *    `isError:true` with the facade's error codes — never protocol errors
 *    (Decision 5); unknown tool IS a protocol error (-32602)
 */
import { afterAll, describe, expect, it } from "vitest";
import { copyFile } from "node:fs/promises";
import { EMITTED_VERB_JSON_SCHEMAS } from "@openreel/agent-facade";
import { writeTinyVp9Mp4 } from "@openreel/runtime-chromium/media/tiny-vp9-mp4";
import { chromiumAvailable, initialize, makeRoots, startServe, type McpClient } from "./helpers";

let client: McpClient | null = null;
let roots: Awaited<ReturnType<typeof makeRoots>> | null = null;
const runtimeAvailable = chromiumAvailable();

async function getClient(): Promise<McpClient> {
  if (!client) {
    roots = await makeRoots();
    client = startServe([
      "--media-root", roots.mediaRoot,
      "--artifact-root", roots.artifactRoot,
      "--project-root", roots.projectRoot,
      "--log-level", "error",
    ]);
    await initialize(client);
  }
  return client;
}

async function callTool(name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const c = await getClient();
  const id = Math.floor(Math.random() * 1e9);
  c.send({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
  return (await c.read()) as any;
}

afterAll(async () => {
  if (client) {
    client.handle.endStdin();
    const code = await Promise.race([
      client.handle.exitCode,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
    ]);
    expect(code).toBe(0);
    if (roots) await roots.cleanup();
  }
});

describe("agent-video serve (real binary)", () => {
  it("responds to initialize with serverInfo carrying the transport's own facts", async () => {
    const c = await getClient();
    const init = await initialize(c);
    const info = init.result.serverInfo;
    expect(info.name).toBe("agent-video");
    expect(info.version).toBe("0.1.0");
    expect(typeof info.pid).toBe("number");
    expect(Array.isArray(info.args)).toBe(true);
    expect(info.facadeContract).toBe("facade-slice-3");
    // Decision 5: capabilities carry ONLY the standard protocol
    // advertisement — never the server's own facts.
    const capsJson = JSON.stringify(init.result.capabilities);
    expect(capsJson).not.toContain("pid");
    expect(capsJson).not.toContain("facadeContract");
  });

  it("tools/list exposes exactly the 16 tools in order, with facade inputSchemas verbatim", async () => {
    const c = await getClient();
    c.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    const reply = await c.read();
    const tools = reply.result.tools as { name: string; inputSchema: unknown }[];
    expect(tools.map((t) => t.name)).toEqual([
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
      "visual_inspect",
      "export_start",
      "job_status",
      "job_cancel",
      "verify_artifact",
    ]);
    // Decision 4: inputSchema is the facade emission VERBATIM (CI deep-equal).
    const verbOrder = [
      "session.describe", "capabilities.get", "project.create", "project.open",
      "project.save", "project.get_state", "media.import", "timeline.get",
      "editor.get_context",
      "edit.apply", "preview.render_frame", "visual.inspect", "export.start", "job.status",
      "job.cancel", "verify.artifact",
    ];
    tools.forEach((tool, i) => {
      expect(tool.inputSchema).toEqual((EMITTED_VERB_JSON_SCHEMAS as Record<string, unknown>)[verbOrder[i]]);
    });
  });

  it("session_describe passthrough: contract facade-slice-3, 16 verbs, 9 error codes", async () => {
    const reply = await callTool("session_describe", {});
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBeFalsy();
    const text = reply.result.content[0].text as string;
    const parsed = JSON.parse(text);
    expect(parsed.ok).toBe(true);
    expect(parsed.value.contractVersion).toBe("facade-slice-3");
    expect(parsed.value.verbs).toHaveLength(16);
    expect(parsed.value.errorCodes).toHaveLength(9);
    // structuredContent populated too (SDK 1.30.0 supports it)
    expect(reply.result.structuredContent.value.contractVersion).toBe("facade-slice-3");
  });

  it("project_create + edit_apply happy path with exact revision arithmetic", async () => {
    const created = await callTool("project_create", {
      name: "Protocol smoke",
      settings: { width: 320, height: 180, frameRate: 30 },
      idempotencyKey: "proto-create-1",
    });
    const createdBody = JSON.parse(created.result.content[0].text);
    expect(createdBody.ok).toBe(true);
    expect(createdBody.value.revision).toBe(0);
    expect(createdBody.value.replayed).toBe(false);

    // exact idempotent retry: replayed=true, same revision, no reset
    const replay = await callTool("project_create", {
      name: "Protocol smoke",
      settings: { width: 320, height: 180, frameRate: 30 },
      idempotencyKey: "proto-create-1",
    });
    const replayBody = JSON.parse(replay.result.content[0].text);
    expect(replayBody.ok).toBe(true);
    expect(replayBody.value.replayed).toBe(true);
    expect(replayBody.value.revision).toBe(0);

    const edited = await callTool("edit_apply", {
      ops: [
        { op: "track.add", trackType: "video", trackId: "v1" },
        { op: "track.add", trackType: "text", trackId: "t1" },
        { op: "text.create", text: "Hello", startTime: 0, duration: 5, trackId: "t1" },
      ],
      expectedRevision: 0,
      idempotencyKey: "proto-edit-1",
    });
    const editedBody = JSON.parse(edited.result.content[0].text);
    expect(editedBody.ok).toBe(true);
    expect(editedBody.value.revision).toBe(1);
  });

  it("expectedRevision conflict surfaces as isError tool result with code CONFLICT — never a protocol error", async () => {
    const reply = await callTool("edit_apply", {
      ops: [{ op: "track.add", trackType: "video", trackId: "v2" }],
      expectedRevision: 99,
      idempotencyKey: "proto-edit-2",
    });
    expect(reply.error).toBeUndefined(); // NO JSON-RPC error
    expect(reply.result.isError).toBe(true);
    const body = JSON.parse(reply.result.content[0].text);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe("CONFLICT");
    expect(reply.result.structuredContent.error.code).toBe("CONFLICT");
  });

  it("unknown method is a transport-level JSON-RPC error (-32601), separate channel", async () => {
    const c = await getClient();
    c.send({ jsonrpc: "2.0", id: 42, method: "not/a/method", params: {} });
    const reply = await c.read();
    expect(reply.error).toBeDefined();
    expect(reply.error.code).toBe(-32601);
  });

  it("unknown tool is a transport-level JSON-RPC error (-32602)", async () => {
    const c = await getClient();
    c.send({ jsonrpc: "2.0", id: 43, method: "tools/call", params: { name: "nope", arguments: {} } });
    const reply = await c.read();
    expect(reply.error).toBeDefined();
    expect(reply.error.code).toBe(-32602);
    expect(reply.error.message).toContain("nope");
  });

  it("media.import invalid params pass through as INVALID_PARAMS isError results", async () => {
    // schema-valid params the facade rejects (relative-ish path that cannot
    // be read): the transport must NOT pre-validate — the facade decides.
    const reply = await callTool("media_import", { path: "/definitely/not/there.mp4" });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    const body = JSON.parse(reply.result.content[0].text);
    expect(body.error.code).toBe("INVALID_PARAMS");
  });

  it("job_status on unknown job surfaces NOT_FOUND through the tool result", async () => {
    const reply = await callTool("job_status", { jobId: "job-does-not-exist" });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBe(true);
    expect(JSON.parse(reply.result.content[0].text).error.code).toBe("NOT_FOUND");
  });

  it.skipIf(!runtimeAvailable)("visual_inspect returns a real PNG MCP image block over stdio", async () => {
    await getClient();
    if (!roots) throw new Error("test roots were not initialized");
    const source = writeTinyVp9Mp4(roots.mediaRoot);
    const inputPath = `${roots.mediaRoot}/input.mp4`;
    await copyFile(source, inputPath);
    const imported = await callTool("media_import", { path: inputPath });
    const importedBody = JSON.parse(imported.result.content[0].text);
    expect(importedBody.ok).toBe(true);
    const mediaId = importedBody.value.mediaId as string;
    const edited = await callTool("edit_apply", {
      ops: [{ op: "clip.add", trackId: "v1", mediaId, startTime: 0, duration: 5, clipId: "visual-c1" }],
      expectedRevision: importedBody.value.revision,
    });
    expect(JSON.parse(edited.result.content[0].text).ok).toBe(true);
    const reply = await callTool("visual_inspect", {
      clipId: "visual-c1",
      sampleCount: 1,
      width: 320,
      height: 180,
    });
    expect(reply.error).toBeUndefined();
    expect(reply.result.isError).toBeFalsy();
    expect(reply.result.content.some((block: { type: string }) => block.type === "image")).toBe(true);
    const image = reply.result.content.find((block: { type: string }) => block.type === "image") as {
      data: string;
      mimeType: string;
    };
    expect(image.mimeType).toBe("image/png");
    expect(Buffer.from(image.data, "base64").subarray(0, 4)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47]),
    );
    // The structured result remains available alongside the image block.
    expect(reply.result.structuredContent.value.frames).toHaveLength(1);
  });
});
