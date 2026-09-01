/**
 * Evidence recorder — every spec writes one machine-readable JSON document
 * per test (requests, revisions, conflict codes, pixel stats, security
 * probes) plus PNG screenshots, mirroring the runtime-chromium .artifacts
 * pattern. The directory is uploaded in CI with if-no-files-found:error.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright-core";
import { ARTIFACTS_DIR } from "./paths";

export interface EvidenceRecord {
  /** Free-form named values; appended in test order. */
  record(key: string, value: unknown): void;
  /** Persist a full-page screenshot as a PNG artifact; returns its path. */
  screenshot(name: string): Promise<string>;
  /** Rebind screenshots to a new page after an app relaunch. */
  bindPage(page: Page): void;
  /** Write an already-decoded PNG buffer as an artifact; returns its path. */
  writePng(name: string, png: Buffer): string;
  /** Flush the JSON document to .artifacts/<testName>.json. */
  flush(extra?: Record<string, unknown>): string;
  readonly dir: string;
}

export function createEvidence(testName: string, page?: Page): EvidenceRecord {
  const dir = ARTIFACTS_DIR;
  mkdirSync(dir, { recursive: true });
  const data: Record<string, unknown> = { test: testName };
  const safe = (name: string): string => name.replace(/[^a-z0-9._-]+/gi, "-");
  let boundPage = page;

  return {
    dir,
    record(key, value) {
      data[key] = value;
    },
    async screenshot(name) {
      const file = path.join(dir, `${safe(testName)}--${safe(name)}.png`);
      if (!boundPage) throw new Error("evidence: no page bound for screenshots");
      await boundPage.screenshot({ path: file, fullPage: false });
      return file;
    },
    bindPage(next) {
      boundPage = next;
    },
    writePng(name, png) {
      const file = path.join(dir, `${safe(testName)}--${safe(name)}.png`);
      writeFileSync(file, png);
      return file;
    },
    flush(extra) {
      const file = path.join(dir, `${safe(testName)}.json`);
      writeFileSync(
        file,
        JSON.stringify({ ...data, ...(extra ?? {}), artifactsDir: dir }, null, 2),
      );
      return file;
    },
  };
}
