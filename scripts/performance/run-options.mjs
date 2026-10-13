export const PERFORMANCE_SCENARIOS = Object.freeze(["T01", "T02", "H01", "H02", "P01"]);
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
]);
const BOOLEAN_FLAGS = new Set(["--serial", "--report-only"]);

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

function parseScenarios(values) {
  if (values.length === 0) return [...PERFORMANCE_SCENARIOS];
  const requested = values.flatMap((value) => value.split(",").map((scenario) => scenario.trim()));
  if (requested.some((scenario) => scenario.length === 0)) {
    throw new TypeError("--scenario contains an empty scenario ID");
  }
  if (requested.includes("ALL")) {
    if (requested.length !== 1) throw new TypeError("ALL must be the only --scenario value");
    return [...PERFORMANCE_SCENARIOS];
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
  const { values, scenarios: scenarioValues } = parseFlags(argv);
  const suite = values.get("--suite");
  if (suite !== "quick" && suite !== "benchmark") {
    throw new TypeError("--suite is required and must be quick or benchmark");
  }

  const scenarios = parseScenarios(scenarioValues);
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

  const suiteDefaults = suite === "quick"
    ? { samples: 25, repeats: 2 }
    : { samples: 100, repeats: 3 };
  const coldLaunches = isCold
    ? parseInteger(values.get("--cold-launches") ?? "5", "--cold-launches", { max: 10 })
    : 0;
  const samples = isCold
    ? coldLaunches
    : parseInteger(values.get("--samples") ?? String(suiteDefaults.samples), "--samples", { max: 10_000 });
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

  return {
    suite,
    scenarios,
    seed,
    samples,
    repeats,
    cache,
    coldLaunches,
    fontMiB,
    nodeCount,
    operationTimeoutMs: parseInteger(
      values.get("--operation-timeout-ms") ?? "30000",
      "--operation-timeout-ms",
      { max: 120_000 },
    ),
    runTimeoutSeconds: parseInteger(
      values.get("--run-timeout-seconds") ?? "600",
      "--run-timeout-seconds",
      { max: 3_600 },
    ),
  };
}

export function runTimeoutMs(options) {
  const launchCount = options.cache === "warm" ? 1 : options.coldLaunches;
  const totalSeconds = options.scenarios.length * options.repeats * launchCount * (options.runTimeoutSeconds + 120);
  return totalSeconds * 1_000;
}

export const PERFORMANCE_RUN_USAGE =
  "Usage: node ../../scripts/performance/run.mjs --suite quick|benchmark [--scenario T01[,T02]|ALL] [--seed VALUE] [--samples N] [--repeats N] [--cache warm|fresh-profile|reused-profile] [--cold-launches N] [--font-mib 32|64] [--node-count 10|100|1000] [--operation-timeout-ms N] [--run-timeout-seconds N] [--serial] [--report-only]";
