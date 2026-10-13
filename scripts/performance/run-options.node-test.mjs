import assert from "node:assert/strict";
import test from "node:test";
import {
  PERFORMANCE_SCENARIOS,
  parseRunOptions,
  runTimeoutMs,
} from "./run-options.mjs";

test("quick and benchmark suites apply documented defaults and accept pnpm separators", () => {
  const quick = parseRunOptions(["--", "--suite", "quick"]);
  assert.deepEqual(quick.scenarios, PERFORMANCE_SCENARIOS);
  assert.equal(quick.samples, 25);
  assert.equal(quick.repeats, 2);
  assert.equal(quick.cache, "warm");
  assert.equal(quick.coldLaunches, 0);
  assert.equal(quick.fontMiB, 32);
  assert.equal(quick.nodeCount, 100);
  assert.equal(quick.operationTimeoutMs, 30_000);
  assert.equal(quick.runTimeoutSeconds, 600);

  const benchmark = parseRunOptions(["--suite=benchmark"]);
  assert.equal(benchmark.samples, 100);
  assert.equal(benchmark.repeats, 3);
});

test("scenario selection accepts repeatable or comma-separated IDs and ALL", () => {
  assert.deepEqual(
    parseRunOptions(["--suite", "quick", "--scenario", "T01,T02", "--scenario", "P01"]).scenarios,
    ["T01", "T02", "P01"],
  );
  assert.deepEqual(parseRunOptions(["--suite", "quick", "--scenario", "ALL"]).scenarios, PERFORMANCE_SCENARIOS);
  assert.equal(parseRunOptions(["--suite", "quick", "--serial", "--report-only"]).suite, "quick");
});

test("cold profile runs use history scenarios and cold launch count instead of samples", () => {
  const defaultCold = parseRunOptions(["--suite", "quick", "--scenario", "H02", "--cache", "fresh-profile"]);
  assert.equal(defaultCold.samples, 5);
  assert.equal(defaultCold.coldLaunches, 5);

  const options = parseRunOptions([
    "--suite",
    "benchmark",
    "--scenario=H01,H02",
    "--cache",
    "reused-profile",
    "--cold-launches",
    "3",
  ]);
  assert.deepEqual(options.scenarios, ["H01", "H02"]);
  assert.equal(options.samples, 3);
  assert.equal(options.coldLaunches, 3);
  assert.equal(runTimeoutMs(options), 2 * 3 * 3 * (600 + 120) * 1_000);
});

test("rejects unknown, duplicate, missing, malformed, and unsupported cold options", () => {
  const invalidArguments = [
    ["--suite", "quick", "--trace"],
    ["--suite", "quick", "--samples", "5", "--samples", "6"],
    ["--suite", "quick", "--scenario", "T01", "--scenario", "T01"],
    ["--suite", "quick", "--scenario", "T01,BOGUS"],
    ["--suite", "quick", "--scenario", "ALL", "--scenario", "T01"],
    ["--suite", "quick", "--samples"],
    ["--suite", "quick", "--samples", "2.5"],
    ["--suite", "quick", "--samples", "0"],
    ["--suite", "quick", "--cold-launches", "2"],
    ["--suite", "quick", "--cache", "fresh-profile"],
    ["--suite", "quick", "--scenario", "H02", "--cache", "fresh-profile", "--samples", "2"],
    ["--suite", "quick", "--scenario", "T01", "--cache", "fresh-profile"],
    ["--suite", "quick", "--scenario", "H01", "--cache", "fresh-profile", "--cold-launches", "11"],
    ["--suite", "quick", "--font-mib", "48"],
    ["--suite", "quick", "--node-count", "20"],
    ["--suite", "quick", "--scenario", "P01", "--font-mib", "64"],
    ["--suite", "quick", "--scenario", "H02", "--node-count", "10"],
    ["--suite", "quick", "--operation-timeout-ms", "120001"],
    ["--suite", "quick", "--serial", "--serial"],
    ["--suite", "quick", "--", "--", "--report-only"],
    ["--scenario", "T01"],
  ];

  for (const args of invalidArguments) {
    assert.throws(() => parseRunOptions(args), undefined, `expected rejection for ${args.join(" ")}`);
  }
});
