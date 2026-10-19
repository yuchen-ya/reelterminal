import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const safeAccounts = new Set(["runner", "runneradmin", "demo", "test", "tester", "user", "username", "alice", "bob", "redacted", "example", "me"]);
const secrets = /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|Bearer\s+[A-Za-z0-9._~+/-]{20,}/;
const homes = /(?:[A-Z]:[\\/]+Users[\\/]+|\/Users\/|\/home\/)([^\\/\s"'<>`]+)/gi;
const masked = /^(?:Bearer\s+)?(?:<redacted>|\[redacted\]|redacted)$/i;

function unsafeText(text) {
  if (secrets.test(text)) return "credential_pattern";
  for (const match of text.matchAll(homes)) {
    if (!safeAccounts.has(match[1].toLowerCase())) return "personal_home_path";
  }
  if (/[A-Z]:[\\/]+(?:1my_projects|audio-eval)(?:[\\/]|$)/i.test(text)) return "machine_local_path";
  return null;
}

function inspectValue(value, findings, file) {
  if (typeof value === "string") {
    const reason = unsafeText(value);
    if (reason) findings.push({ file, reason });
  } else if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      if (/^(?:token|access_token|refresh_token|apiKey|api_key|authorization)$/i.test(key) &&
          typeof item === "string" && item.length >= 12 && !masked.test(item)) {
        findings.push({ file, reason: "credential_field" });
      }
      inspectValue(item, findings, file);
    }
  }
}

/** Read only the JSON/Markdown/PNG evidence selected by the upload steps. */
export async function inspectArtifacts(directory, { maxBytes = 64 * 1024 * 1024 } = {}) {
  const root = path.resolve(directory);
  const findings = [];
  let files = 0;
  let totalBytes = 0;
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const file = path.relative(root, absolute).split(path.sep).join("/");
      if (entry.isSymbolicLink()) { findings.push({ file, reason: "symlink" }); continue; }
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (/^(?:\.env(?:\..*)?|live-endpoint\.json|audio(?:-environment)?\.json)$/i.test(entry.name)) {
        findings.push({ file, reason: "private_configuration_file" });
        continue;
      }
      if (!entry.isFile() || !/\.(?:json|md|png)$/i.test(entry.name)) continue;
      const size = (await lstat(absolute)).size;
      files += 1;
      totalBytes += size;
      if (totalBytes > maxBytes) { findings.push({ file, reason: "size_budget" }); continue; }
      if (/\.png$/i.test(entry.name)) continue;
      const text = await readFile(absolute, "utf8");
      if (/\.json$/i.test(entry.name)) {
        try { inspectValue(JSON.parse(text), findings, file); }
        catch { findings.push({ file, reason: "invalid_json" }); }
      } else inspectValue(text, findings, file);
    }
  }
  try { await walk(root); }
  catch (error) {
    if (error.code === "ENOENT") findings.push({ file: ".", reason: "directory_missing" });
    else throw error;
  }
  if (!files) findings.push({ file: ".", reason: "evidence_missing" });
  return { status: findings.length ? "failed" : "passed", files, total_bytes: totalBytes, findings };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error("Usage: node scripts/security/check-ci-artifacts.mjs DIRECTORY");
  const report = await inspectArtifacts(process.argv[2]);
  const source_head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  // Report relative evidence names and reason codes; never print rejected data.
  console.log(JSON.stringify({ source_head, ...report }));
  if (report.status !== "passed") process.exitCode = 1;
}
