/**
 * Tests for the agent-task channel core: media-root advertisement,
 * media-root-contained output scanning (real temp directories — containment
 * resolves through realpath, so synthetic paths fail closed), and facade
 * import forwarding.
 */
import { mkdtemp, mkdir, rm, writeFile, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createAgentTaskChannelCore,
  type AgentTaskChannelDeps,
} from "./agent-task-channels";

const tempRoots: string[] = [];

afterEach(async () => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
});

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "amt-channels-"));
  tempRoots.push(root);
  return root;
}

function buildCore(
  mediaRoots: () => readonly string[],
  callExternal?: AgentTaskChannelDeps["callExternal"],
): ReturnType<typeof createAgentTaskChannelCore> & {
  importVerbCalls: Array<{ verb: string; params: unknown }>;
} {
  const importVerbCalls: Array<{ verb: string; params: unknown }> = [];
  const core = createAgentTaskChannelCore({
    mediaRoots,
    callExternal:
      callExternal ??
      (async (verb, params) => {
        importVerbCalls.push({ verb, params });
        return {
          ok: true,
          value: { mediaId: "media-1", name: "voice.wav", revision: 3, replayed: false },
        };
      }),
  });
  return { ...core, importVerbCalls };
}

describe("getMediaRoots", () => {
  it("advertises the first root as recommendedRoot", () => {
    const core = buildCore(() => ["C:\\ws", "C:\\Users\\demo\\Music"]);
    expect(core.getMediaRoots()).toEqual({
      recommendedRoot: "C:\\ws",
      mediaRoots: ["C:\\ws", "C:\\Users\\demo\\Music"],
    });
  });

  it("answers null recommendedRoot when no roots are configured", () => {
    const core = buildCore(() => []);
    expect(core.getMediaRoots()).toEqual({ recommendedRoot: null, mediaRoots: [] });
  });
});

describe("scanTaskOutput", () => {
  it("lists only real audio files inside the root, newest first", async () => {
    const workspace = await makeWorkspace();
    const output = path.join(workspace, "jobs", "amt_1", "output");
    await mkdir(output, { recursive: true });
    const oldTime = new Date("2026-01-01T00:00:00Z");
    const newTime = new Date("2026-06-01T00:00:00Z");
    const writeWithTime = async (name: string, content: string, time: Date) => {
      const target = path.join(output, name);
      await writeFile(target, content);
      await utimes(target, time, time);
    };
    await writeWithTime("old.wav", "old", oldTime);
    await writeWithTime("new.mp3", "new", newTime);
    await writeWithTime("notes.txt", "x", newTime);
    await writeWithTime("empty.flac", "", newTime);
    await mkdir(path.join(output, "nested.ogg"), { recursive: true });

    const core = buildCore(() => [workspace]);
    const result = await core.scanTaskOutput(output);
    expect(result.files.map((file) => file.name)).toEqual(["new.mp3", "old.wav"]);
  });

  it("yields nothing for a directory outside the advertised roots", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const output = path.join(outside, "jobs", "amt_1", "output");
    await mkdir(output, { recursive: true });
    await writeFile(path.join(output, "a.wav"), "data");

    const core = buildCore(() => [workspace]);
    const result = await core.scanTaskOutput(output);
    expect(result.files).toEqual([]);
  });

  it("yields nothing when the directory does not exist (fail closed)", async () => {
    const workspace = await makeWorkspace();
    const core = buildCore(() => [workspace]);
    const result = await core.scanTaskOutput(
      path.join(workspace, "missing", "output"),
    );
    expect(result.files).toEqual([]);
  });
});

describe("importTaskArtifact", () => {
  it("forwards media.import with path and idempotency key", async () => {
    const core = buildCore(() => ["C:\\ws"]);
    const reply = await core.importTaskArtifact({
      path: "C:\\ws\\jobs\\amt_1\\output\\voice.wav",
      idempotencyKey: "req_abc12345",
    });
    expect(reply.ok).toBe(true);
    expect(core.importVerbCalls).toEqual([
      {
        verb: "media.import",
        params: {
          path: "C:\\ws\\jobs\\amt_1\\output\\voice.wav",
          idempotencyKey: "req_abc12345",
        },
      },
    ]);
  });

  it("passes a disabled-host envelope through untouched", async () => {
    const core = buildCore(() => ["C:\\ws"], async () => ({
      ok: false as const,
      error: {
        code: "UNSUPPORTED",
        message: "live collaboration is disabled",
      },
    }));
    const reply = await core.importTaskArtifact({
      path: "C:\\ws\\a.wav",
      idempotencyKey: "req_abc12345",
    });
    expect(reply).toEqual({
      ok: false,
      error: { code: "UNSUPPORTED", message: "live collaboration is disabled" },
    });
  });

  it("carries an optional display name to the facade", async () => {
    const core = buildCore(() => ["C:\\ws"]);
    await core.importTaskArtifact({
      path: "C:\\ws\\a.wav",
      name: "我的配音",
      idempotencyKey: "req_abc12345",
    });
    expect(core.importVerbCalls[0]?.params).toMatchObject({ name: "我的配音" });
  });
});
