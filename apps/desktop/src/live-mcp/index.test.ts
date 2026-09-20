import { afterEach, describe, expect, it, vi } from "vitest";
import os from "node:os";
import path from "node:path";
import { FACADE_TOOL_NAMES } from "@reelterminal/agent-facade";
import {
  createSerializedLineWriter,
  endpointFilePath,
  forwardLine,
  startLiveHeartbeat,
  startProgressWatch,
  validateLiveEndpointUrl,
  type ProgressNotification,
} from "./index";

describe("live MCP endpoint selection", () => {
  afterEach(() => {
    delete process.env.REELTERMINAL_LIVE_ENDPOINT_FILE;
    delete process.env.OPENREEL_LIVE_ENDPOINT_FILE;
  });

  it("defaults to the canonical live endpoint descriptor", () => {
    delete process.env.REELTERMINAL_LIVE_ENDPOINT_FILE;
    delete process.env.OPENREEL_LIVE_ENDPOINT_FILE;
    expect(endpointFilePath()).toBe(
      path.join(os.homedir(), ".reelterminal", "live-endpoint.json"),
    );
  });

  it("supports an isolated descriptor override", () => {
    const descriptor = path.join(os.tmpdir(), "openreel-live-endpoint.json");
    process.env.OPENREEL_LIVE_ENDPOINT_FILE = descriptor;
    expect(endpointFilePath()).toBe(descriptor);
  });

  it("prefers the new override name when both are set", () => {
    const newFile = path.join(os.tmpdir(), "reelterminal-live-endpoint.json");
    const oldFile = path.join(os.tmpdir(), "openreel-live-endpoint.json");
    process.env.REELTERMINAL_LIVE_ENDPOINT_FILE = newFile;
    process.env.OPENREEL_LIVE_ENDPOINT_FILE = oldFile;
    expect(endpointFilePath()).toBe(newFile);
  });
});

describe("live endpoint URL boundary", () => {
  it("accepts only local plain-HTTP endpoints", () => {
    expect(validateLiveEndpointUrl("http://127.0.0.1:3210/mcp").hostname).toBe(
      "127.0.0.1",
    );
    expect(validateLiveEndpointUrl("http://localhost:3210/mcp").hostname).toBe(
      "localhost",
    );
  });

  it.each([
    "https://127.0.0.1:3210/mcp",
    "http://example.com:3210/mcp",
    "http://user:secret@127.0.0.1:3210/mcp",
    "not a URL",
  ])("rejects an unsafe descriptor URL: %s", (url) => {
    expect(() => validateLiveEndpointUrl(url)).toThrow();
  });
});

describe("forwardLine", () => {
  it("forwards live MCP requests", async () => {
    const post = vi.fn().mockResolvedValue({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
    const result = await forwardLine('{"jsonrpc":"2.0","id":1,"method":"tools/list"}', post);
    expect(post).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(JSON.parse(result!)).toEqual({ jsonrpc: "2.0", id: 1, result: { tools: [] } });
  });

  it("rejects legacy or unsupported methods without forwarding", async () => {
    const post = vi.fn();
    const result = await forwardLine(
      '{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"execute_action"}}',
      post,
    );
    expect(JSON.parse(result!)).toMatchObject({ id: 9, error: { code: -32602 } });
    expect(post).not.toHaveBeenCalled();
  });

  it.each([
    "project_rename",
    "project_changes",
    "media_analyze_start",
    "timeline_query",
    "edit_validate",
    "history_get",
    "history_control",
  ] as const)("forwards the live facade tool %s", async (name) => {
    expect(FACADE_TOOL_NAMES).toContain(name);
    const upstream = {
      jsonrpc: "2.0",
      id: 24,
      result: { structuredContent: { ok: true, value: { tool: name } } },
    };
    const post = vi.fn().mockResolvedValue(upstream);
    const request = {
      jsonrpc: "2.0",
      id: 24,
      method: "tools/call",
      params: { name, arguments: {} },
    };

    const result = await forwardLine(JSON.stringify(request), post);

    expect(post).toHaveBeenCalledWith(request);
    expect(JSON.parse(result!)).toEqual(upstream);
  });

  it("turns upstream failures into concise JSON-RPC errors", async () => {
    const post = vi.fn().mockRejectedValue(new Error("connection refused"));
    const result = await forwardLine('{"jsonrpc":"2.0","id":2,"method":"ping"}', post);
    expect(JSON.parse(result!)).toEqual({
      jsonrpc: "2.0",
      id: 2,
      error: { code: -32000, message: "connection refused" },
    });
  });

  it("does not emit a response for notifications", async () => {
    const post = vi.fn().mockResolvedValue(null);
    expect(await forwardLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', post)).toBeNull();
  });

  it("starts opt-in progress only after a successful export response", async () => {
    const post = vi.fn().mockResolvedValue({
      jsonrpc: "2.0",
      id: 4,
      result: {
        structuredContent: {
          ok: true,
          value: { jobId: "job-export" },
        },
      },
    });
    const started = vi.fn();
    const response = await forwardLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 4,
        method: "tools/call",
        params: { name: "export_start", arguments: {}, _meta: { progressToken: "原样-token" } },
      }),
      post,
      { onExportStarted: started },
    );

    expect(started).toHaveBeenCalledWith("job-export", "原样-token");
    expect(JSON.parse(response!)).toMatchObject({ id: 4, result: { structuredContent: { ok: true } } });
  });

  it("does not start a watcher when export_start has no progress token", async () => {
    const post = vi.fn().mockResolvedValue({
      jsonrpc: "2.0",
      id: 5,
      result: { structuredContent: { ok: true, value: { jobId: "job-quiet" } } },
    });
    const started = vi.fn();
    await forwardLine(
      '{"jsonrpc":"2.0","id":5,"method":"tools/call","params":{"name":"export_start","arguments":{}}}',
      post,
      { onExportStarted: started },
    );
    expect(started).not.toHaveBeenCalled();
  });

  it("keeps the successful tools/call response when status polling fails", async () => {
    const post = vi
      .fn()
      .mockResolvedValueOnce({
        jsonrpc: "2.0",
        id: 6,
        result: { structuredContent: { ok: true, value: { jobId: "job-poll-fails" } } },
      })
      .mockRejectedValueOnce(new Error("job_status unavailable"));
    let watch: ReturnType<typeof startProgressWatch> | undefined;
    const response = await forwardLine(
      '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"export_start","arguments":{},"_meta":{"progressToken":"poll-token"}}}',
      post,
      {
        onExportStarted: (jobId, progressToken) => {
          watch = startProgressWatch({
            jobId,
            progressToken,
            readStatus: async () => {
              await post({ method: "tools/call", params: { name: "job_status" } });
              return null;
            },
            notify: async () => undefined,
          });
        },
      },
    );
    await watch?.done;
    expect(JSON.parse(response!)).toMatchObject({ id: 6, result: { structuredContent: { ok: true } } });
  });
});

describe("live MCP progress forwarding", () => {
  it("echoes the token, stays monotonic, deduplicates, and stops at done", async () => {
    const notifications: ProgressNotification[] = [];
    const statuses = [
      { state: "queued" as const, progress: null },
      { state: "running" as const, progress: { percent: 0.15, phase: "rendering" } },
      { state: "running" as const, progress: { percent: 0.15, phase: "rendering" } },
      // A provider regression must not make the external Agent see progress go backwards.
      { state: "running" as const, progress: { percent: 0.1, phase: "rendering" } },
      { state: "done" as const, progress: { percent: 1, phase: "complete" } },
    ];
    const watch = startProgressWatch({
      jobId: "job-1",
      progressToken: 99,
      pollMs: 10,
      readStatus: async () => statuses.shift() ?? { state: "done" as const, progress: null },
      notify: async (notification) => {
        notifications.push(notification);
      },
    });

    await watch.done;
    expect(notifications).toEqual([
      { progressToken: 99, progress: 0, total: 1, message: "queued" },
      { progressToken: 99, progress: 0.15, total: 1, message: "rendering" },
      { progressToken: 99, progress: 1, total: 1, message: "complete" },
    ]);
  });

  it.each(["error", "cancelled"] as const)("cleans up on %s without throwing into tools/call", async (state) => {
    let reads = 0;
    const watch = startProgressWatch({
      jobId: "job-terminal",
      progressToken: "terminal-token",
      pollMs: 10,
      readStatus: async () => {
        reads += 1;
        return { state, progress: null };
      },
      notify: async () => {
        throw new Error("notification sink unavailable");
      },
    });
    await expect(watch.done).resolves.toBeUndefined();
    expect(reads).toBe(1);
  });

  it("stops an in-flight connector watcher when the connector closes", async () => {
    let reads = 0;
    const watch = startProgressWatch({
      jobId: "job-close",
      progressToken: "close-token",
      pollMs: 10,
      readStatus: async () => {
        reads += 1;
        return { state: "running" as const, progress: { percent: 0.2, phase: "rendering" } };
      },
      notify: async () => undefined,
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    watch.stop();
    await watch.done;
    expect(reads).toBe(1);
  });

  it("serializes concurrent tool responses and notifications into complete lines", async () => {
    const writes: string[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const write = createSerializedLineWriter(async (line) => {
      if (line === "response-1") await first;
      writes.push(line);
    });
    const firstWrite = write("response-1");
    const secondWrite = write("progress-1");
    releaseFirst();
    await Promise.all([firstWrite, secondWrite]);
    expect(writes).toEqual(["response-1", "progress-1"]);
  });
});

describe("live MCP activity heartbeat", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pings privately on the shipped cadence and stops with the connector", async () => {
    vi.useFakeTimers();
    const post = vi.fn().mockResolvedValue({ jsonrpc: "2.0", result: {} });
    const heartbeat = startLiveHeartbeat(post, 25);

    await vi.advanceTimersByTimeAsync(75);
    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenLastCalledWith({
      jsonrpc: "2.0",
      id: "openreel-heartbeat-3",
      method: "ping",
    });

    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(post).toHaveBeenCalledTimes(3);
  });
});
