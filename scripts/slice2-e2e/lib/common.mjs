/** Shared constants and assertion helpers for agent transport scenarios. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** The text overlay band (default transform centers text at 0.5, 0.5). */
export const TEXT_REGION = { x: 0.15, y: 0.3, width: 0.7, height: 0.4 };

export const WORDINGS = {
  mediaEscape: "path escapes the configured media roots",
  checkpointEscape: "path escapes the configured project roots",
  corrupted: "corrupted or hand-edited",
  mediaRefsBinding: "mediaRefs do not match project.mediaLibrary.items",
  mediaMoved: "missing, moved, or changed",
  contractVersion: "facade-slice-2",
  orphanLabel: "orphan — unverifiable, do not trust as an artifact",
};

/* ----------------------------- tiny checks ----------------------------- */

export function eq(name, actual, expected, detailExtra) {
  return {
    name,
    pass: actual === expected,
    detail: `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}${detailExtra ? ` ${detailExtra}` : ""}`,
  };
}

export function truthy(name, actual, detail) {
  return { name, pass: actual === true, detail: detail ?? `actual=${JSON.stringify(actual)}` };
}

export function matches(name, actual, predicate, detail) {
  let pass = false;
  try {
    pass = predicate(actual) === true;
  } catch {
    pass = false;
  }
  return { name, pass, detail: detail ?? `actual=${safeShort(actual)}` };
}

export function textIncludes(name, text, needle) {
  return {
    name,
    pass: typeof text === "string" && text.includes(needle),
    detail: `needle=${JSON.stringify(needle)} message=${JSON.stringify(typeof text === "string" ? text.slice(0, 400) : text)}`,
  };
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();
  if (keysA.length !== keysB.length) return false;
  if (!keysA.every((key, index) => key === keysB[index])) return false;
  return keysA.every((key) => deepEqual(a[key], b[key]));
}

function safeShort(value) {
  const text = JSON.stringify(value);
  if (typeof text !== "string") return String(value);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/** Serialize values with sorted object keys and array order preserved. */
export function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Compute the checkpoint digest from its persisted fields. */
export function computeStateSha256({ formatVersion, revision, project, mediaRefs }) {
  return createHash("sha256")
    .update(stableStringify({ formatVersion, revision, project, mediaRefs }), "utf8")
    .digest("hex");
}

/* ------------------------------ environment ----------------------------- */

export async function gitSha(repoRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repoRoot });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function probeClientClis() {
  const names = ["claude", "codex", "pi", "zcode", "dsh"];
  const probes = [];
  for (const name of names) {
    let found = false;
    let resolvedPath = null;
    try {
      const { stdout } = await execFileAsync("which", [name]);
      found = true;
      resolvedPath = stdout.trim();
    } catch {
      found = false;
    }
    probes.push({ cli: name, probedWith: `which ${name}`, found, resolvedPath });
  }
  return probes;
}

/** Facade result convenience: pull ok/error/value out of either a run stdout
 * line or an MCP facadeResult. */
export function of(line) {
  const result = line?.result ?? line;
  return result;
}

/** Assert a run stdout line is an ok result and return its value. */
export function okValue(line, stepId) {
  const result = of(line);
  if (!result || result.ok !== true) {
    throw new Error(`step "${stepId}" was expected to succeed but got ${JSON.stringify(result)?.slice(0, 600)}`);
  }
  return result.value;
}

/** Extract a run stdout line by step id. */
export function lineById(lines, id) {
  const line = lines.find((l) => l.id === id);
  if (!line) throw new Error(`no stdout line for step "${id}" (lines: ${lines.map((l) => l.id).join(",")})`);
  return line;
}

/** sha256 of a file (hex). */
export async function sha256File(absPath) {
  const buffer = await fs.readFile(absPath);
  return createHash("sha256").update(buffer).digest("hex");
}

/** The artifactRoot containment check compares realpath-to-realpath (macOS
 * /tmp → /private/tmp), exactly as the facade does. */
export async function realpathOf(p) {
  return fs.realpath(p);
}

export async function pathInsideRoot(candidate, root) {
  const [realCandidate, realRoot] = await Promise.all([
    fs.realpath(candidate).catch(() => null),
    fs.realpath(root),
  ]);
  return (
    realCandidate !== null &&
    (realCandidate === realRoot || realCandidate.startsWith(`${realRoot}${path.sep}`))
  );
}
