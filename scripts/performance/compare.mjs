#!/usr/bin/env node
import {
  compareResultDocuments,
  parseExactFlags,
  readResultFile,
} from "./result-contract.mjs";

try {
  const flags = parseExactFlags(process.argv.slice(2), ["--baseline", "--candidate", "--policy"]);
  if (flags["--policy"] !== "report-only") throw new Error("--policy must be report-only");

  const [baselineRead, candidateRead] = await Promise.all([
    readResultFile(flags["--baseline"]),
    readResultFile(flags["--candidate"]),
  ]);
  let comparison;
  if (candidateRead.error) {
    comparison = { status: "report_only", reason: "invalid_candidate", errors: [candidateRead.error], regressions: [] };
  } else if (baselineRead.error === "file_not_found") {
    comparison = compareResultDocuments(null, candidateRead.document, flags["--policy"]);
  } else if (baselineRead.error) {
    comparison = { status: "report_only", reason: "invalid_baseline", errors: [baselineRead.error], regressions: [] };
  } else {
    comparison = compareResultDocuments(baselineRead.document, candidateRead.document, flags["--policy"]);
  }
  process.stdout.write(`${JSON.stringify(comparison, null, 2)}\n`);
  process.stderr.write(`Performance comparison: ${comparison.status} (${comparison.reason}); ${comparison.regressions.length} reported deltas.\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
