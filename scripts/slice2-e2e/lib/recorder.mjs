/** Record scenario observations, assertions, and artifact digests. */
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256File(absPath) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(absPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

export class Recorder {
  constructor(dir, label) {
    this.dir = dir;
    this.label = label;
    this.steps = []; // { id, title, pass, detail, evidence }
    this.recordSeq = 0;
    this.transcriptPath = path.join(dir, "transcript.jsonl");
    this.assertionsPath = path.join(dir, "assertions.md");
    this.shaPath = path.join(dir, "sha256s.txt");
    this.shaLines = [];
    this._stream = null;
    this.failures = [];
  }

  async open() {
    await mkdir(this.dir, { recursive: true });
    this._stream = createWriteStream(this.transcriptPath, { flags: "w" });
    await this.record("scenario", {
      label: this.label,
      startedAt: new Date().toISOString(),
    });
  }

  async record(type, payload) {
    const line = JSON.stringify({
      seq: this.recordSeq++,
      ts: new Date().toISOString(),
      type,
      ...payload,
    });
    if (!this._stream) {
      await mkdir(this.dir, { recursive: true });
      this._stream = createWriteStream(this.transcriptPath, { flags: "a" });
    }
    await new Promise((resolve, reject) =>
      this._stream.write(`${line}\n`, (error) => (error ? reject(error) : resolve())),
    );
  }

  /** Record a group of checks and stop after recording the first failure. */
  async step(stepId, title, checks) {
    const rows = [];
    for (const check of checks) {
      const row = {
        step: stepId,
        title,
        name: check.name,
        pass: check.pass === true,
        detail: check.detail ?? null,
      };
      rows.push(row);
      this.steps.push(row);
      if (!row.pass) this.failures.push(row);
      await this.record("assert", row);
    }
    const failed = rows.filter((r) => !r.pass);
    if (failed.length > 0) {
      const first = failed[0];
      throw new Error(
        `[${this.label}] step ${stepId} (${title}) FAILED check "${first.name}": ${first.detail ?? "(no detail)"}`,
      );
    }
  }

  /** Single ad-hoc boolean check that throws when false. */
  async check(stepId, title, name, pass, detail) {
    await this.step(stepId, title, [{ name, pass, detail }]);
  }

  async sha256Of(absPath, label) {
    const digest = await sha256File(absPath);
    const line = `${digest}  ${label ?? path.basename(absPath)}`;
    this.shaLines.push(line);
    await this.record("sha256", { label: label ?? absPath, path: absPath, sha256: digest });
    return digest;
  }

  async close() {
    if (this._stream) {
      await new Promise((resolve) => this._stream.end(resolve));
      this._stream = null;
    }
    const passed = this.steps.filter((s) => s.pass).length;
    const lines = [
      `# Assertions — ${this.label}`,
      "",
      `Result: ${this.failures.length === 0 ? "ALL PASS" : "FAILURES PRESENT"} — ${passed}/${this.steps.length} checks passed.`,
      "",
      "| Step | Check | Pass | Detail |",
      "|---|---|---|---|",
      ...this.steps.map(
        (s) =>
          `| ${s.step} | ${escapeCell(s.title)} — ${escapeCell(s.name)} | ${s.pass ? "PASS" : "**FAIL**"} | ${escapeCell(s.detail === null || s.detail === undefined ? "" : typeof s.detail === "string" ? s.detail : JSON.stringify(s.detail))} |`,
      ),
      "",
    ];
    await writeFile(this.assertionsPath, lines.join("\n"), "utf8");
    await writeFile(
      this.shaPath,
      [`# sha256 — ${this.label}`, ...this.shaLines, ""].join("\n"),
      "utf8",
    );
    return { passed, failed: this.failures.length, total: this.steps.length };
  }
}

function escapeCell(text) {
  return String(text).replaceAll("|", "\\|").replaceAll("\n", " ");
}
