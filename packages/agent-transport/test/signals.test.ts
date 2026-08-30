/**
 * Signal ownership + stdout purity tests (ADR 0003 Decisions 6/7) against
 * the REAL binary:
 *  - first SIGTERM ⇒ bounded disposal stderr logs, exit 143
 *  - second signal ⇒ immediate hard exit (no disposal promises)
 *  - stdin EOF (client disconnect) ⇒ bounded disposal, exit 0
 *  - stdout purity guard: every subcommand's stdout carries ONLY
 *    protocol-conformant bytes
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initialize, makeRoots, spawnCli, startServe, type McpClient, type Roots } from "./helpers";

let roots!: Roots;

beforeAll(async () => {
  roots = await makeRoots();
});

afterAll(async () => {
  await roots.cleanup();
});

function serveArgs(): string[] {
  return [
    "--media-root", roots.mediaRoot,
    "--artifact-root", roots.artifactRoot,
    "--project-root", roots.projectRoot,
    "--log-level", "debug",
  ];
}

function parseJsonLines(stdout: string): { ok: unknown[]; bad: string[] } {
  const ok: unknown[] = [];
  const bad: string[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      ok.push(JSON.parse(line));
    } catch {
      bad.push(line);
    }
  }
  return { ok, bad };
}

describe("Decision 7: signal ownership", () => {
  it("first SIGTERM runs the bounded disposal and exits 143", async () => {
    const handle = spawnCli(["serve", ...serveArgs()]);
    // give the server a moment to connect and log "listening"
    await new Promise((r) => setTimeout(r, 1500));
    handle.child.kill("SIGTERM");
    const code = await Promise.race([
      handle.exitCode,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
    ]);
    expect(code).toBe(143);
    const logs = parseJsonLines(handle.stderr).ok as any[];
    expect(logs.some((l) => l.scope === "signal" && /first signal/i.test(l.msg))).toBe(true);
    expect(logs.some((l) => /bounded disposal begins/.test(l.msg))).toBe(true);
    expect(logs.some((l) => /bounded disposal complete/.test(l.msg))).toBe(true);
    // exit code by signal, never by crash
    expect(logs.some((l) => l.exitCode === 143)).toBe(true);
  }, 180_000);

  it("a second signal exits immediately with no further disposal promises", async () => {
    const handle = spawnCli(["serve", ...serveArgs()]);
    await new Promise((r) => setTimeout(r, 1500));
    handle.child.kill("SIGTERM");
    // second signal immediately after the first — well within the disposal bound
    await new Promise((r) => setTimeout(r, 150));
    handle.child.kill("SIGTERM");
    const code = await Promise.race([
      handle.exitCode,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 60_000)),
    ]);
    expect(code).toBe(143);
    const logs = parseJsonLines(handle.stderr).ok as any[];
    expect(logs.some((l) => /second signal — immediate hard exit/.test(l.msg))).toBe(true);
  }, 120_000);

  it("SIGINT exits 130 and SIGHUP exits 129 through the same bounded disposal", async () => {
    for (const [signal, code] of [["SIGINT", 130], ["SIGHUP", 129]] as const) {
      const handle = spawnCli(["serve", ...serveArgs()]);
      await new Promise((r) => setTimeout(r, 1200));
      handle.child.kill(signal);
      const got = await Promise.race([
        handle.exitCode,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
      ]);
      expect(got).toBe(code);
    }
  }, 300_000);

  it("stdin EOF (client disconnect) runs the bounded disposal and exits 0", async () => {
    const handle = spawnCli(["serve", ...serveArgs()]);
    await new Promise((r) => setTimeout(r, 1500));
    handle.endStdin();
    const code = await Promise.race([
      handle.exitCode,
      new Promise((resolve) => setTimeout(() => resolve("timeout"), 120_000)),
    ]);
    expect(code).toBe(0);
    const logs = parseJsonLines(handle.stderr).ok as any[];
    expect(logs.some((l) => /stdin EOF/.test(l.msg))).toBe(true);
    expect(logs.some((l) => /bounded disposal complete/.test(l.msg))).toBe(true);
  }, 180_000);
});

describe("Decision 6: stdout purity guard (CI)", () => {
  it("serve: every stdout byte belongs to a JSON-RPC message; logs live on stderr", async () => {
    const client: McpClient = startServe(serveArgs());
    await initialize(client);
    client.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await client.read();
    client.send({
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "project_create", arguments: { name: "Purity", idempotencyKey: "p1" } },
    });
    await client.read();
    client.send({
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: { name: "capabilities_get", arguments: {} },
    });
    await client.read();
    client.handle.endStdin();
    await client.handle.exitCode;
    const { ok, bad } = parseJsonLines(client.handle.stdout);
    expect(bad).toEqual([]);
    // every message is a JSON-RPC frame (response or notification), never a log
    for (const message of ok) {
      expect((message as any).jsonrpc).toBe("2.0");
    }
    // stderr carries single-line JSON logs
    for (const line of client.handle.stderr.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 240_000);

  it("run: stdout carries only step JSON lines with the documented shape", async () => {
    const workflow = path.join(roots.projectRoot, "purity.jsonl");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      workflow,
      [
        JSON.stringify({ id: "create", verb: "project.create", params: { name: "Purity", idempotencyKey: "purity-1" } }),
        JSON.stringify({ id: "timeline", verb: "timeline.get" }),
      ].join("\n") + "\n",
    );
    const handle = spawnCli([
      "run", "--workflow", workflow,
      "--media-root", roots.mediaRoot,
      "--artifact-root", roots.artifactRoot,
      "--project-root", roots.projectRoot,
      "--log-level", "debug",
    ]);
    const exitCode = await handle.exitCode;
    expect(exitCode).toBe(0);
    const { ok, bad } = parseJsonLines(handle.stdout);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(2);
    for (const line of ok as any[]) {
      expect(typeof line.index).toBe("number");
      expect(typeof line.id).toBe("string");
      expect(line.verb ?? line.await).toBeTruthy();
      expect(line.result).toBeDefined();
    }
    for (const line of handle.stderr.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 240_000);

  it("doctor: stdout is exactly one machine-readable JSON document", async () => {
    const handle = spawnCli(["doctor", "--log-level", "error"]);
    const exitCode = await handle.exitCode;
    expect([0, 1, 2]).toContain(exitCode);
    const { ok, bad } = parseJsonLines(handle.stdout);
    expect(bad).toEqual([]);
    expect(ok).toHaveLength(1);
    const report = ok[0] as any;
    expect(report.command).toBe("doctor");
    expect(report.verdict).toBeDefined();
    // stderr logs remain single-line JSON
    for (const line of handle.stderr.split("\n")) {
      if (line.trim().length === 0) continue;
      expect(() => JSON.parse(line)).not.toThrow();
    }
  }, 300_000);
});

import path from "node:path";
