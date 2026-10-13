import { readFile, rm } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PerformanceRunOptions } from "./driver";

vi.mock("./identity", () => ({
  captureBuildIdentity: async () => ({
    source_head: "b".repeat(40),
    dirty: true,
    source_digest: "a".repeat(64),
    dirty_diff_digest: "a".repeat(64),
    lockfile_digest: "a".repeat(64),
    main_bundle_sha256: "a".repeat(64),
    preload_bundle_sha256: "a".repeat(64),
    renderer_manifest_sha256: "a".repeat(64),
    worker_manifest_sha256: "a".repeat(64),
    executable_sha256: "a".repeat(64),
    app_version: "1.1.1",
    build_type: "production",
    build_verified: true,
    build_reason: "verified",
  }),
}));

import { ARTIFACTS_DIR } from "../paths";
import { runExportPerformanceScenario } from "./export-scenario";

const resultPaths: string[] = [];

afterEach(async () => {
  await Promise.all(resultPaths.splice(0).map((filePath) => rm(filePath, { force: true })));
});

describe("E01 deterministic export performance scenario", () => {
  it("uses explicit samples and verifies real input and status write boundaries", async () => {
    const options: PerformanceRunOptions = {
      suite: "quick",
      scenarios: ["E01"],
      seed: "e01-regression",
      samples: 2,
      repeats: 1,
      cache: "warm",
      coldLaunches: 1,
      fontMiB: 32,
      nodeCount: 10,
      clipCount: 500,
      trackCount: 20,
      editRounds: 1,
      durationSeconds: 3,
      actionIntervalMs: 10,
      operationTimeoutMs: 5_000,
      runTimeoutSeconds: 30,
    };

    const resultPath = await runExportPerformanceScenario(options, 0);
    resultPaths.push(resultPath);
    expect(resultPath).toContain(ARTIFACTS_DIR);
    const result = JSON.parse(await readFile(resultPath, "utf8")) as {
      status: string;
      run: { scenario_id: string; expected_operations: number };
      operations: readonly unknown[];
      correctness: Record<string, boolean | null>;
      structural: Record<string, number>;
      export_performance: {
        status: string;
        phase_status: Record<string, string>;
        events: readonly { kind: string; phase: string }[];
      };
    };

    expect(result.status).toBe("complete");
    expect(result.run).toMatchObject({ scenario_id: "E01", expected_operations: 2 });
    expect(result.operations).toHaveLength(2);
    expect(result.correctness).toMatchObject({
      fixed_input_immutable_verified: true,
      progress_status_persisted_verified: true,
      successful_export_verified: true,
      failed_export_cleanup_verified: true,
      cancellation_cleanup_verified: true,
    });
    expect(result.structural.immutable_input_document_writes).toBe(result.structural.immutable_input_documents);
    expect(result.structural.immutable_input_rewrites).toBe(0);
    expect(result.structural.attempted_export_samples).toBe(2);
    expect(result.structural.unattempted_export_samples).toBe(0);
    expect(result.structural.durable_status_writes).toBeGreaterThan(0);
    expect(result.export_performance).toMatchObject({
      status: "complete",
      phase_status: { encode: "unavailable", audio: "unavailable" },
    });
    expect(result.export_performance.events.some((event) => event.kind === "span_end" && event.phase === "status.persist")).toBe(true);
  });
});
