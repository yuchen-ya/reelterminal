import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  migrateIntoDataRoot,
  type MigrationOptions,
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

  it("does not treat a same-sized pre-existing target as a verified copy", async () => {
    const appFrom = await makeDir("legacy-app");
    await seedStore(appFrom, { "IndexedDB/data.db": "profile" });
    const workspaceFrom = await makeDir("legacy-workspace");
    await seedStore(workspaceFrom, { "jobs/1/brief.md": "task" });
    const appTo = path.join(sandbox, "root", "app-data");
    const workspaceTo = path.join(sandbox, "root", "agent-workspace");
    const sources: MigrationSource[] = [
      { kind: "appData", from: appFrom, to: appTo },
      { kind: "workspace", from: workspaceFrom, to: workspaceTo },
    ];

    const first = await migrateIntoDataRoot(sources, { preserveSources: true });

    expect(first.ok).toBe(true);
    expect(first.items.map((item) => item.status)).toEqual([
      "copied-backup-left",
      "copied-backup-left",
    ]);
    expect(existsSync(path.join(appFrom, "IndexedDB", "data.db"))).toBe(true);
    expect(existsSync(path.join(workspaceFrom, "jobs", "1", "brief.md"))).toBe(true);

    // Matching file counts and byte totals cannot prove that a target is the
    // current source copy. Keep this same-sized, different target untouched.
    await writeFile(path.join(appTo, "IndexedDB", "data.db"), "changed", "utf8");

    const retry = await migrateIntoDataRoot(sources, {
      preserveSources: true,
      copy: async () => {
        throw new Error("a populated destination should be reused without recopying");
      },
    });

    expect(retry.ok).toBe(false);
    expect(retry.items.map((item) => item.status)).toEqual([
      "skipped-target-exists",
    ]);
    expect(await readFile(path.join(appTo, "IndexedDB", "data.db"), "utf8")).toBe(
      "changed",
    );
    expect(existsSync(path.join(workspaceTo, "jobs", "1", "brief.md"))).toBe(true);
    expect(existsSync(path.join(appFrom, "IndexedDB", "data.db"))).toBe(true);
    expect(existsSync(path.join(workspaceFrom, "jobs", "1", "brief.md"))).toBe(true);
  });

  it("stops the batch after a failed appData copy, before copying workspace", async () => {
    const appFrom = await makeDir("legacy-app");
    await seedStore(appFrom, { "IndexedDB/data.db": "profile" });
    const workspaceFrom = await makeDir("legacy-workspace");
    await seedStore(workspaceFrom, { "jobs/1/brief.md": "task" });
    const appTo = path.join(sandbox, "root", "app-data");
    const workspaceTo = path.join(sandbox, "root", "agent-workspace");
    const sources: MigrationSource[] = [
      { kind: "appData", from: appFrom, to: appTo },
      { kind: "workspace", from: workspaceFrom, to: workspaceTo },
    ];

    const report = await migrateIntoDataRoot(sources, {
      preserveSources: true,
      copy: async (from, to, options) => {
        if (from === appFrom) {
          throw Object.assign(new Error("profile is locked"), { code: "EIO" });
        }
        await cp(from, to, options);
      },
    });

    expect(report.ok).toBe(false);
    expect(report.items).toHaveLength(1);
    expect(report.items[0]).toMatchObject({ kind: "appData", status: "failed" });
    expect(existsSync(path.join(appFrom, "IndexedDB", "data.db"))).toBe(true);
    expect(existsSync(path.join(workspaceFrom, "jobs", "1", "brief.md"))).toBe(true);
    expect(existsSync(workspaceTo)).toBe(false);
  });

  it.each(["mkdir", "lstat", "readdir", "stat"] as const)(
    "rolls back an earlier appData copy when workspace %s fails, then retries",
    async (operation) => {
      const appFrom = await makeDir("legacy-app");
      await seedStore(appFrom, { "IndexedDB/data.db": "profile" });
      const workspaceFrom = await makeDir("legacy-workspace");
      await seedStore(workspaceFrom, { "jobs/1/brief.md": "task" });
      const root = await makeDir("root");
      const appTo = path.join(root, "app-data");
      const workspaceTo = path.join(root, "agent-workspace");
      const sources: MigrationSource[] = [
        { kind: "appData", from: appFrom, to: appTo },
        { kind: "workspace", from: workspaceFrom, to: workspaceTo },
      ];
      if (operation === "readdir") await mkdir(workspaceTo);

      let appDataCopied = false;
      const denied = Object.assign(new Error(`${operation} denied`), {
        code: "EACCES",
      });
      const fileSystem: NonNullable<MigrationOptions["fileSystem"]> = {
        mkdir: (async (directory: string, options: { recursive: true }) => {
          if (
            operation === "mkdir" &&
            appDataCopied &&
            directory === root
          ) {
            throw denied;
          }
          return mkdir(directory, options);
        }) as unknown as typeof mkdir,
        lstat: (async (target: string) => {
          if (operation === "lstat" && target === workspaceTo) throw denied;
          return lstat(target);
        }) as unknown as typeof lstat,
        // Both target inspection and tree verification only need the entry
        // count or Dirent methods, so always return Dirents in this test shim.
        readdir: (async (directory: string) => {
          if (operation === "readdir" && directory === workspaceTo) throw denied;
          return readdir(directory, { withFileTypes: true });
        }) as unknown as typeof readdir,
        stat: (async (target: string) => {
          if (operation === "stat" && target === workspaceFrom) throw denied;
          return stat(target);
        }) as unknown as typeof stat,
      };

      const failed = await migrateIntoDataRoot(sources, {
        preserveSources: true,
        fileSystem,
        copy: async (from, to, options) => {
          await cp(from, to, options);
          if (from === appFrom) appDataCopied = true;
        },
      });

      expect(failed.ok).toBe(false);
      expect(failed.items.at(-1)).toMatchObject({
        kind: "workspace",
        status: "failed",
      });
      expect(existsSync(appTo)).toBe(false);
      expect(existsSync(path.join(appFrom, "IndexedDB", "data.db"))).toBe(true);
      expect(existsSync(path.join(workspaceFrom, "jobs", "1", "brief.md"))).toBe(true);

      const retried = await migrateIntoDataRoot(sources, { preserveSources: true });

      expect(retried.ok).toBe(true);
      expect(await readFile(path.join(appTo, "IndexedDB", "data.db"), "utf8")).toBe(
        "profile",
      );
      expect(await readFile(path.join(workspaceTo, "jobs", "1", "brief.md"), "utf8")).toBe(
        "task",
      );
    },
  );

  it("removes copied targets when committing the completion marker fails", async () => {
    const from = await makeDir("legacy");
    await seedStore(from, { "profile.db": "profile" });
    const to = path.join(sandbox, "root", "app-data");

    const report = await migrateIntoDataRoot([source(from, to)], {
      preserveSources: true,
      onBatchComplete: () => {
        throw new Error("marker is not writable");
      },
    });

    expect(report.ok).toBe(false);
    expect(report.error).toContain("marker is not writable");
    expect(existsSync(to)).toBe(false);
    expect(existsSync(path.join(from, "profile.db"))).toBe(true);
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

  it("copies several stores while retaining both sources for batch adoption", async () => {
    const appFrom = await makeDir("legacy-app");
    await seedStore(appFrom, { "db": "a" });
    const wsFrom = await makeDir("legacy-ws");
    await seedStore(wsFrom, { "jobs/1/brief.md": "b" });
    const appTo = path.join(sandbox, "root", "app-data");
    const wsTo = path.join(sandbox, "root", "agent-workspace");

    const report = await migrateIntoDataRoot([
      source(appFrom, appTo),
      { kind: "workspace", from: wsFrom, to: wsTo },
    ], { preserveSources: true });

    expect(report.ok).toBe(true);
    expect(report.items.map((item) => item.status)).toEqual([
      "copied-backup-left",
      "copied-backup-left",
    ]);
    expect(existsSync(path.join(appTo, "db"))).toBe(true);
    expect(existsSync(path.join(wsTo, "jobs", "1", "brief.md"))).toBe(true);
    expect(existsSync(path.join(appFrom, "db"))).toBe(true);
    expect(existsSync(path.join(wsFrom, "jobs", "1", "brief.md"))).toBe(true);
  });
});
