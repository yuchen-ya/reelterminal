#!/usr/bin/env node
import {
  parseExactFlags,
  readResultFile,
  validateResultDocument,
} from "./result-contract.mjs";

try {
  const flags = parseExactFlags(process.argv.slice(2), ["--file"]);
  const { document, error } = await readResultFile(flags["--file"]);
  const result = error
    ? { valid: false, errors: [`${error}: ${flags["--file"]}`] }
    : validateResultDocument(document);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.valid) process.exitCode = 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}
