export const PERFORMANCE_SCENARIOS = Object.freeze(["T01", "T02", "T03", "H01", "H02", "P01", "A01", "R01", "R02", "E01"]);
export const QUICK_SCENARIOS = Object.freeze(["T01", "T02", "H01", "H02", "P01"]);
const HISTORY_SCENARIOS = new Set(["H01", "H02"]);
const VALUE_FLAGS = new Set([
  "--suite",
  "--scenario",
  "--seed",
  "--samples",
  "--repeats",
  "--cache",
  "--cold-launches",
  "--font-mib",
  "--node-count",
  "--operation-timeout-ms",
  "--run-timeout-seconds",
  "--clip-count", "--track-count", "--edit-rounds", "--duration-seconds", "--action-interval-ms",
]);
const BOOLEAN_FLAGS = new Set(["--serial", "--report-only", "--saturate-history"]);

function removePnpmSeparator(argv) {
  const separatorIndex = argv.indexOf("--");
  if (separatorIndex === -1) return argv;
  if (argv.lastIndexOf("--") !== separatorIndex) {
    throw new TypeError("only one standalone `--` separator is allowed");
  }
  return argv.filter((_, index) => index !== separatorIndex);
}

function parseFlags(argv) {
  const values = new Map();
  const scenarios = [];
  const booleans = new Set();
  const args = removePnpmSeparator(argv);

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (typeof argument !== "string" || !argument.startsWith("--")) {
      throw new TypeError(`unexpected argument: ${String(argument)}`);
    }

    const equalIndex = argument.indexOf("=");
    const flag = equalIndex === -1 ? argument : argument.slice(0, equalIndex);
    const inlineValue = equalIndex === -1 ? undefined : argument.slice(equalIndex + 1);

    if (BOOLEAN_FLAGS.has(flag)) {
      if (inlineValue !== undefined) throw new TypeError(`${flag} does not take a value`);
      if (booleans.has(flag)) throw new TypeError(`${flag} may only be specified once`);
      booleans.add(flag);
      continue;
    }
    if (!VALUE_FLAGS.has(flag)) throw new TypeError(`unknown option: ${flag}`);

    let value = inlineValue;
    if (value === undefined) {
      const next = args[index + 1];
      if (next === undefined || next === "--" || next.startsWith("--")) {
        throw new TypeError(`${flag} requires a value`);
      }
      value = next;
      index += 1;
    }

    if (flag === "--scenario") {
      scenarios.push(value);
      continue;
    }
    if (values.has(flag)) throw new TypeError(`${flag} may only be specified once`);
    values.set(flag, value);
  }

  return { values, scenarios, booleans };
}

function parseInteger(value, flag, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!/^\d+$/.test(value)) throw new TypeError(`${flag} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new RangeError(`${flag} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseScenarios(values, suite) {
  if (values.length === 0) return suite === "soak" ? ["R02"] : [...QUICK_SCENARIOS];
  const requested = values.flatMap((value) => value.split(",").map((scenario) => scenario.trim()));
  if (requested.some((scenario) => scenario.length === 0)) {
    throw new TypeError("--scenario contains an empty scenario ID");
  }
  if (requested.includes("ALL")) {
    if (requested.length !== 1) throw new TypeError("ALL must be the only --scenario value");
    return suite === "soak" ? ["R01", "R02"] : PERFORMANCE_SCENARIOS.filter((id) => id !== "R02");
  }
  const unknown = requested.filter((scenario) => !PERFORMANCE_SCENARIOS.includes(scenario));
  if (unknown.length > 0) throw new TypeError(`unknown scenario ID: ${unknown[0]}`);
  if (new Set(requested).size !== requested.length) {
    throw new TypeError("scenario IDs must not be repeated");
  }
  return requested;
}

/** Parse strict runner flags into the normalized object passed to the E2E child. */
export function parseRunOptions(argv) {
  const { values, scenarios: scenarioValues, booleans } = parseFlags(argv);
  const suite = values.get("--suite");
  if (suite !== "quick" && suite !== "benchmark" && suite !== "soak") {
    throw new TypeError("--suite is required and must be quick, benchmark, or soak");
  }

  const scenarios = parseScenarios(scenarioValues, suite);
  if (booleans.has("--saturate-history") && !scenarios.includes("R02")) throw new TypeError("--saturate-history requires R02");
  if (scenarios.includes("R02") && suite !== "soak") throw new TypeError("R02 requires the opt-in soak suite");
  if (suite === "soak" && scenarios.some((id) => id !== "R01" && id !== "R02")) throw new TypeError("soak supports only R01 and R02");
  for (const [flag, required] of [["--clip-count", "T03"], ["--track-count", "T03"], ["--edit-rounds", "R01"], ["--duration-seconds", "R02"], ["--action-interval-ms", "R02"]]) {
    if (values.has(flag) && !scenarios.includes(required)) throw new TypeError(`${flag} requires scenario ${required}`);
  }
  if (values.has("--font-mib") && !scenarios.some((scenario) => scenario === "T02" || scenario === "H02")) {
    throw new TypeError("--font-mib requires scenario T02 or H02");
  }
  if (values.has("--node-count") && !scenarios.includes("H01")) {
    throw new TypeError("--node-count requires scenario H01");
  }
  const cache = values.get("--cache") ?? "warm";
  if (!new Set(["warm", "fresh-profile", "reused-profile"]).has(cache)) {
    throw new TypeError("--cache must be warm, fresh-profile, or reused-profile");
  }

  const isCold = cache !== "warm";
  const explicitSamples = values.has("--samples");
  if (explicitSamples && scenarios.every((id) => id === "R01" || id === "R02")) {
    throw new TypeError("resource runs use --edit-rounds or --duration-seconds instead of --samples");
  }
  const explicitColdLaunches = values.has("--cold-launches");
  if (isCold) {
    const unsupportedScenarios = scenarios.filter((scenario) => !HISTORY_SCENARIOS.has(scenario));
    if (unsupportedScenarios.length > 0) {
      throw new TypeError("cold profile runs are supported only for H01 and H02; select history scenarios explicitly");
    }
    if (explicitSamples) {
      throw new TypeError("--samples cannot be combined with a cold profile run; use --cold-launches");
    }
  } else if (explicitColdLaunches) {
    throw new TypeError("--cold-launches requires --cache fresh-profile or --cache reused-profile");
  }

  const suiteDefaults = suite === "soak" ? { samples: 100, repeats: 1 } : suite === "quick"
    ? { samples: 25, repeats: 2 }
    : { samples: 100, repeats: 3 };
  const coldLaunches = isCold
    ? parseInteger(values.get("--cold-launches") ?? "5", "--cold-launches", { max: 10 })
    : 0;
  const samples = isCold
    ? coldLaunches
    : parseInteger(values.get("--samples") ?? String(suiteDefaults.samples), "--samples", { max: 10_000 });
  if (scenarios.includes("A01") && samples > 100) throw new RangeError("A01 supports at most 100 paired frame samples per mode");
  if (scenarios.includes("E01") && samples > 100) throw new RangeError("E01 supports at most 100 export samples");
  const repeats = parseInteger(values.get("--repeats") ?? String(suiteDefaults.repeats), "--repeats", { max: 20 });
  const seed = values.get("--seed") ?? "42";
  if (seed.trim().length === 0 || seed.length > 128 || /[\u0000-\u001f\u007f]/.test(seed)) {
    throw new TypeError("--seed must be 1–128 printable characters");
  }
  const fontMiB = parseInteger(values.get("--font-mib") ?? "32", "--font-mib", { min: 32, max: 64 });
  if (fontMiB !== 32 && fontMiB !== 64) throw new RangeError("--font-mib must be 32 or 64");
  const nodeCount = parseInteger(values.get("--node-count") ?? "100", "--node-count", { max: 1_000 });
  if (![10, 100, 1_000].includes(nodeCount)) {
    throw new RangeError("--node-count must be 10, 100, or 1000");
  }
  const clipCount = parseInteger(values.get("--clip-count") ?? "500", "--clip-count", { max: 2000 });
  if (![500, 2000].includes(clipCount)) throw new RangeError("--clip-count must be 500 or 2000");
  const trackCount = parseInteger(values.get("--track-count") ?? "20", "--track-count", { max: 50 });
  if (![20, 50].includes(trackCount)) throw new RangeError("--track-count must be 20 or 50");
  const durationSeconds = parseInteger(values.get("--duration-seconds") ?? "1800", "--duration-seconds", { max: 3600 });
  const runSeconds = parseInteger(values.get("--run-timeout-seconds") ?? (suite === "soak" ? String(durationSeconds + 120) : "600"), "--run-timeout-seconds", { max: 7200 });
  if (scenarios.includes("R02") && runSeconds < durationSeconds + 60) throw new RangeError("R02 run timeout must reserve at least 60 seconds for idle samples and cleanup");

  return {
    suite,
    saturateHistory: booleans.has("--saturate-history"),
    scenarios,
    seed,
    samples,
    repeats,
    cache,
    coldLaunches,
    fontMiB,
    nodeCount,
    clipCount, trackCount,
    editRounds: parseInteger(values.get("--edit-rounds") ?? "500", "--edit-rounds", { max: 5000 }),
    durationSeconds,
    actionIntervalMs: parseInteger(values.get("--action-interval-ms") ?? "1000", "--action-interval-ms", { min: 100, max: 60000 }),
    operationTimeoutMs: parseInteger(
      values.get("--operation-timeout-ms") ?? "30000",
      "--operation-timeout-ms",
      { max: 120_000 },
    ),
    runTimeoutSeconds: runSeconds,
  };
}

export function runTimeoutMs(options) {
  const launchCount = options.cache === "warm" ? 1 : options.coldLaunches;
  const totalSeconds = options.scenarios.length * options.repeats * launchCount * (options.runTimeoutSeconds + 120);
  return totalSeconds * 1_000;
}

export const PERFORMANCE_RUN_USAGE =
  "Usage: node ../../scripts/performance/run.mjs --suite quick|benchmark|soak [--scenario ID[,ID]|ALL] [--seed VALUE] [--samples N] [--repeats N] [--cache warm|fresh-profile|reused-profile] [--cold-launches N] [--font-mib 32|64] [--node-count 10|100|1000] [--clip-count 500|2000] [--track-count 20|50] [--edit-rounds 1..5000] [--duration-seconds 1..3600] [--action-interval-ms 100..60000] [--saturate-history] [--operation-timeout-ms N] [--run-timeout-seconds N] [--serial] [--report-only]";
