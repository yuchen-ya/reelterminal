import { describe, expect, it } from "vitest";
import {
  fixtureManifestSha256,
  validateResultDocument,
} from "../../../../../scripts/performance/result-contract.mjs";
import {
  combineColdPerformanceResults,
  createPerformanceResult,
  summarizeOperations,
  type RawPerformanceOperation,
} from "./result";

function operation(
  index: number,
  overrides: Partial<RawPerformanceOperation> = {},
): RawPerformanceOperation {
  return {
    operation_id: `op-${index}`,
    metric: "history_content_verified_ms",
    outcome: "ok",
    duration_ms: index + 1,
    target_verified: true,
    ...overrides,
  };
}

const fixtureManifest = {
  schema: "reelterminal.performance-fixture/v1",
  scenarioId: "H02",
  version: 1,
  seed: "42",
  parameters: { fontPayloadMiB: 32 },
  expectedSemantics: ["history content is verified"],
  assets: [{ assetId: "target", kind: "synthetic-image", mediaType: "image/svg+xml", byteLength: 128, sha256: "a".repeat(64) }],
  requiredCapabilities: ["synthetic-image-media"],
  expectedOperations: 2,
  timeBudgetMs: 60_000,
} as const;

function coldResult(
  index: number,
  durationMs: number,
  overrides: {
    cacheState?: string;
    freeBytes?: number;
    validityComplete?: boolean;
    outcome?: RawPerformanceOperation["outcome"];
    correctness?: Readonly<Record<string, boolean | null>>;
  } = {},
) {
  const build = {
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
  };
  const environment = {
    electron: "44.5.1",
    chrome: "140.0",
    os: { platform: "win32", release: "11.0", arch: "x64" },
    runner_class: "local",
    cpu: { model: "Example CPU", logical_cores: 8 },
    memory: { total_bytes: 32_000_000_000, free_bytes: overrides.freeBytes ?? 16_000_000_000 },
    gpu: { info_status: "available", devices: [], feature_status: { webgpu: "disabled" } },
    visible: true,
    focused: true,
    window_css_px: { width: 1280, height: 800 },
    window_content_dip_px: { width: 1280, height: 800 },
    device_scale_factor: 1,
    refresh_hz_estimate: 60,
    devtools_open: false,
    decode_backend: null,
    parallel_decoder_available: null,
    capabilities: { webgpu: false, wasm: true, shared_array_buffer: true, hardware_concurrency: 8, device_memory_gb: 16 },
    power_state: "unknown",
    load_state: "unknown",
    occlusion_state: "unknown",
  };
  return {
    ...createPerformanceResult({
      run: {
        run_id: `h02-cold-${index}`,
        scenario_id: "H02",
        scenario_version: 1,
        seed: "42",
        fixture_manifest: fixtureManifest,
        fixture_manifest_sha256: fixtureManifestSha256(fixtureManifest),
        expected_operations: 1,
        mode: "light",
        cache_state: overrides.cacheState ?? "fresh_profile_process_cold",
        sampling: { input_every_n: 1, frame_every_n: 1 },
        budgets: { capture_seconds: 60, events_capacity: 16_384 },
        repeat: 0,
        cold_launch_index: index,
      },
      build,
      environment,
      samples: [{
        operation_id: `node-open-${index}`,
        metric: "history_cold_entry_content_verified_ms",
        outcome: overrides.outcome ?? "ok",
        duration_ms: overrides.outcome && overrides.outcome !== "ok" ? null : durationMs,
        waited_ms: overrides.outcome && overrides.outcome !== "ok" ? durationMs : undefined,
        target_verified: overrides.outcome ? overrides.outcome === "ok" : true,
      }],
      correctness: overrides.correctness ?? { target_frame_verified: true },
      validity: {
        complete: overrides.validityComplete ?? true,
        reason_codes: overrides.validityComplete === false ? ["capture_incomplete"] : [],
        probe_calibrated: false,
      },
    }),
    action_windows: [{ index, frameIntervalsMs: [16.7] }],
  };
}

describe("performance result aggregation", () => {
  it("uses nearest-rank thresholds for warm p95 and p99", () => {
    const twenty = summarizeOperations(
      Array.from({ length: 20 }, (_, index) => operation(index)),
      "warm_profile",
    )["history_content_verified_ms"];
    expect(twenty.p95).toBe(19);
    expect(twenty.p99).toBeNull();
    expect(twenty.status).toBe("insufficient_samples");

    const hundred = summarizeOperations(
      Array.from({ length: 100 }, (_, index) => operation(index)),
      "warm_profile",
    )["history_content_verified_ms"];
    expect(hundred.p95).toBe(95);
    expect(hundred.p99).toBe(99);
    expect(hundred.status).toBe("ok");
  });

  it("keeps cold-run median, range, and raw durations without p95 or p99", () => {
    const summary = summarizeOperations(
      [operation(0, { duration_ms: 28 }), operation(1, { duration_ms: 12 }), operation(2, { duration_ms: 20 })],
      "fresh_profile_process_cold",
    )["history_content_verified_ms"];
    expect(summary.median_ms).toBe(20);
    expect(summary.min).toBe(12);
    expect(summary.max).toBe(28);
    expect(summary.raw_ms).toEqual([12, 20, 28]);
    expect(summary.p95).toBeNull();
    expect(summary.p99).toBeNull();
  });

  it("counts failed, unverified, and censored requests without reporting tails", () => {
    const summary = summarizeOperations([
      operation(0, { duration_ms: 10 }),
      operation(1, { outcome: "failed", duration_ms: 50 }),
      operation(2, { outcome: "timeout", duration_ms: 100 }),
      operation(3, { target_verified: false }),
    ], "warm_profile")["history_content_verified_ms"];
    expect(summary.n_requested).toBe(4);
    expect(summary.n_completed).toBe(1);
    expect(summary.n_censored).toBe(1);
    expect(summary.n_failed).toBe(2);
    expect(summary.status).toBe("failed");
    expect(summary.p50).toBeNull();
    expect(summary.p95).toBeNull();
    expect(summary.p99).toBeNull();
  });

  it("marks incomplete captures failed and removes their summary tails", () => {
    const result = createPerformanceResult({
      run: { run_id: "r1", scenario_id: "H02", cache_state: "warm_profile" },
      build: { build_verified: true },
      environment: {},
      samples: Array.from({ length: 100 }, (_, index) => operation(index)),
      validity: { complete: false, reason_codes: ["event_drop"] },
    });
    const metric = result.metrics.history_content_verified_ms;
    expect(result.status).toBe("incomplete");
    expect(result.validity.complete).toBe(false);
    expect(metric.status).toBe("failed");
    expect(metric.p50).toBeNull();
    expect(metric.p95).toBeNull();
    expect(metric.p99).toBeNull();
    expect(result.operations).toHaveLength(100);
  });

  it("rejects completed samples when durable revision verification failed", () => {
    const result = createPerformanceResult({
      run: { run_id: "p1", scenario_id: "P01", cache_state: "warm_profile" },
      build: { build_verified: true },
      environment: {},
      samples: Array.from({ length: 100 }, (_, index) => operation(index)),
      correctness: {
        target_frame_verified: true,
        durable_final_revision_verified: false,
      },
    });
    const metric = result.metrics.history_content_verified_ms;
    expect(result.status).toBe("invalid");
    expect(result.validity.complete).toBe(false);
    expect(result.validity.reason_codes).toContain("correctness_verification_failed");
    expect(metric.status).toBe("failed");
    expect(metric.p50).toBeNull();
    expect(metric.p95).toBeNull();
    expect(metric.p99).toBeNull();
  });

  it("preserves an unverified build failure without inventing measurement rows", () => {
    const result = createPerformanceResult({
      run: { run_id: "build-failed", scenario_id: "T01", cache_state: "fresh_profile_process_cold" },
      build: { build_type: null, build_verified: false, build_reason: "stamp_missing" },
      environment: {},
      samples: [],
    });
    expect(result.status).toBe("invalid");
    expect(result.validity.complete).toBe(false);
    expect(result.validity.reason_codes).toContain("unverified_build");
    expect(result.operations).toEqual([]);
    expect(result.metrics).toEqual({});
  });

  it("combines cold launches, preserving run and asset identity while allowing free RAM to vary", () => {
    const children = [10, 20, 30, 40, 50].map((duration, index) =>
      coldResult(index, duration, { freeBytes: 16_000_000_000 - index * 1_000_000_000 }),
    );
    const combined = combineColdPerformanceResults([...children].reverse());
    const metric = combined.metrics.history_cold_entry_content_verified_ms;
    expect(combined.status).toBe("complete");
    expect(combined.run.run_id).toBe("h02-cold-0.cold-summary");
    expect(combined.run.cold_launches).toBe(5);
    expect(combined.run.constituent_run_ids).toEqual(children.map((child) => child.run.run_id));
    expect(combined.run.constituent_runs.map((child) => child.fixture_manifest.assets[0].sha256)).toEqual(
      children.map(() => fixtureManifest.assets[0]!.sha256),
    );
    expect(combined.operations.map((sample) => sample.operation_id)).toEqual(
      children.map((child) => `${child.run.run_id}:${child.operations[0]!.operation_id}`),
    );
    expect(metric.n_requested).toBe(5);
    expect(metric.median_ms).toBe(30);
    expect(metric.min).toBe(10);
    expect(metric.max).toBe(50);
    expect(metric.raw_ms).toEqual([10, 20, 30, 40, 50]);
    expect(metric.p95).toBeNull();
    expect(metric.p99).toBeNull();
    expect(validateResultDocument(combined).valid).toBe(true);
  });

  it("keeps incomplete or invalid cold children out of passing summaries and rejects cache mixing", () => {
    const incomplete = combineColdPerformanceResults([
      coldResult(0, 10),
      coldResult(1, 20, { validityComplete: false }),
    ]);
    expect(incomplete.status).toBe("incomplete");
    expect(incomplete.metrics.history_cold_entry_content_verified_ms.p50).toBeNull();
    expect(validateResultDocument(incomplete).valid).toBe(true);

    const invalid = combineColdPerformanceResults([
      coldResult(0, 10),
      coldResult(1, 20, { correctness: { target_frame_verified: false } }),
    ]);
    expect(invalid.status).toBe("invalid");
    expect(invalid.metrics.history_cold_entry_content_verified_ms.p50).toBeNull();
    expect(validateResultDocument(invalid).valid).toBe(true);

    expect(() => combineColdPerformanceResults([
      coldResult(0, 10),
      coldResult(1, 20, { cacheState: "reused_profile_process_cold" }),
    ])).toThrow(/identity mismatch/);
  });
});
