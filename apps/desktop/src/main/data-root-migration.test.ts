import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  migrateIntoDataRoot,
  type MigrationSource,
} from "./data-root-migration";

let sandbox: string;

async function makeDir(...segments: string[]): Promise<string> {
  const dir = path.join(sandbox, ...segments);
  await mkdir(dir, { recursive: true });
  return dir;
}

async function seedStore(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [name, body] of Object.entries(files)) {
    const full = path.join(root, name);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, body, "utf8");
  }
}

function source(from: string, to: string): MigrationSource {
  return { kind: "appData", from, to };
}

describe("migrateIntoDataRoot", () => {
  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "rt-data-root-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("moves a store with the fast rename path and leaves nothing behind", async () => {
    const from = await makeDir("legacy", "app-data");
    await seedStore(from, { "IndexedDB/data.db": "payload", "settings.json": "{}" });
    const to = path.join(sandbox, "root", "app-data");

    const report = await migrateIntoDataRoot([source(from, to)]);

    expect(report.ok).toBe(true);
    expect(report.items[0]).toMatchObject({
      kind: "appData",
      from,
      to,
      status: "moved",
    });
    expect(existsSync(from)).toBe(false);
    expect(existsSync(path.join(to, "IndexedDB", "data.db"))).toBe(true);
  });

  it("treats a missing source as a no-op (fresh installs)", async () => {
    const to = path.join(sandbox, "root", "app-data");
    const report = await migrateIntoDataRoot([
      source(path.join(sandbox, "never-existed"), to),
    ]);
    expect(report.ok).toBe(true);
    expect(report.items[0].status).toBe("skipped-missing");
    expect(existsSync(to)).toBe(false);
  });

  it("never merges into a non-empty target and keeps the source intact", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "old.db": "old" });
    const to = await makeDir("root", "app-data");
    await seedStore(to, { "new.db": "new" });

    const report = await migrateIntoDataRoot([source(from, to)]);

    expect(report.items[0].status).toBe("skipped-target-exists");
    expect(existsSync(path.join(from, "old.db"))).toBe(true);
    expect(existsSync(path.join(to, "new.db"))).toBe(true);
    expect(existsSync(path.join(to, "old.db"))).toBe(false);
  });

  it("replaces an empty placeholder target directory", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "data.db": "x" });
    const to = await makeDir("root", "app-data");

    const report = await migrateIntoDataRoot([source(from, to)]);

    expect(report.items[0].status).toBe("moved");
    expect(existsSync(path.join(to, "data.db"))).toBe(true);
  });

  it("drops stale '.migrating' staging from an interrupted copy before retrying", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "data.db": "x" });
    const to = path.join(sandbox, "root", "app-data");
    const staging = `${to}.migrating`;
    await mkdir(staging, { recursive: true });
    await writeFile(path.join(staging, "partial.bin"), "half-written");

    const report = await migrateIntoDataRoot([source(from, to)]);

    expect(report.items[0].status).toBe("moved");
    expect(existsSync(staging)).toBe(false);
    expect(existsSync(path.join(to, "data.db"))).toBe(true);
  });

  it("falls back to a verified copy that keeps the source as backup", async () => {
    const from = await makeDir("legacy", "workspace");
    await seedStore(from, { "jobs/a/video.mp4": "12345", "shared/logo.png": "png" });
    const to = path.join(sandbox, "root", "agent-workspace");
    const moveError = Object.assign(new Error("cross-device link"), {
      code: "EXDEV",
    });

    const report = await migrateIntoDataRoot([source(from, to)], {
      // First move attempt (the fast path) fails; the final staging reveal
      // uses the real rename below through the default — so throw only once.
      move: (() => {
        let thrown = false;
        return async () => {
          if (!thrown) {
            thrown = true;
            throw moveError;
          }
        };
      })(),
    });

    expect(report.items[0].status).toBe("copied-backup-left");
    // Backup kept at the source, verbatim.
    expect(existsSync(path.join(from, "jobs", "a", "video.mp4"))).toBe(true);
    // Verified content landed at the target, with no staging left over.
    expect(existsSync(path.join(to, "jobs", "a", "video.mp4"))).toBe(true);
    expect(existsSync(`${to}.migrating`)).toBe(false);
  });

  it("reports a failure without touching either side on hard move errors", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "data.db": "x" });
    const to = path.join(sandbox, "root", "app-data");

    const report = await migrateIntoDataRoot([source(from, to)], {
      move: async () => {
        throw Object.assign(new Error("disk on fire"), { code: "EIO" });
      },
    });

    expect(report.ok).toBe(false);
    expect(report.items[0]).toMatchObject({ status: "failed" });
    expect(report.items[0].error).toContain("disk on fire");
    expect(existsSync(path.join(from, "data.db"))).toBe(true);
    expect(existsSync(to)).toBe(false);
  });

  it("is idempotent: a second run over a completed migration is a no-op", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "data.db": "x" });
    const to = path.join(sandbox, "root", "app-data");

    await migrateIntoDataRoot([source(from, to)]);
    const second = await migrateIntoDataRoot([source(from, to)]);

    expect(second.ok).toBe(true);
    expect(second.items[0].status).toBe("skipped-missing");
  });

  it("migrates several stores independently", async () => {
    const appFrom = await makeDir("legacy-app");
    await seedStore(appFrom, { "db": "a" });
    const wsFrom = await makeDir("legacy-ws");
    await seedStore(wsFrom, { "jobs/1/brief.md": "b" });
    const appTo = path.join(sandbox, "root", "app-data");
    const wsTo = path.join(sandbox, "root", "agent-workspace");

    const report = await migrateIntoDataRoot([
      source(appFrom, appTo),
      { kind: "workspace", from: wsFrom, to: wsTo },
    ]);

    expect(report.ok).toBe(true);
    expect(report.items.map((item) => item.status)).toEqual(["moved", "moved"]);
    expect(existsSync(path.join(appTo, "db"))).toBe(true);
    expect(existsSync(path.join(wsTo, "jobs", "1", "brief.md"))).toBe(true);
  });
});
