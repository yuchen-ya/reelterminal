import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  computeAudioReuseKey,
  findReusableAudioArtifact,
  recordReusableAudioArtifact,
} from "./audio-artifact-reuse";
import { sweepAbandonedAudioArtifactStaging } from "./audio-artifact-lifecycle";

let root = "";

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "audio-lifecycle-")));
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("computeAudioReuseKey (AUD-13)", () => {
  it("keys on the full effective identity, not mediaId", () => {
    const base = {
      verb: "audio.process.normalize",
      sourceSha256: "a".repeat(64),
      audioStream: 0,
      startSec: "0",
      endSec: "10",
      algorithm: "normalize@2+ffmpeg version 7.0",
    };
    const key = computeAudioReuseKey(base);
    expect(key).toBe(computeAudioReuseKey({ ...base }));
    // Source content, range, stream, params and algorithm version all matter.
    expect(key).not.toBe(computeAudioReuseKey({ ...base, sourceSha256: "b".repeat(64) }));
    expect(key).not.toBe(computeAudioReuseKey({ ...base, startSec: "1" }));
    expect(key).not.toBe(computeAudioReuseKey({ ...base, endSec: "11" }));
    expect(key).not.toBe(computeAudioReuseKey({ ...base, audioStream: 1 }));
    expect(key).not.toBe(computeAudioReuseKey({ ...base, algorithm: "normalize@3+ffmpeg version 7.0" }));
    // The identity is the CONTENT sha, never a mediaId: two imports of the
    // same file under different mediaIds produce the same key.
    expect(key).toBe(computeAudioReuseKey({ ...base, sourceSha256: "a".repeat(64) }));
  });
});

describe("reuse index validation (AUD-13)", () => {
  it("hits only when the file exists with the recorded sha and matching version", async () => {
    const kindRoot = join(root, "generated-assets", "audio-normalize");
    const artifactDir = join(kindRoot, "job-1");
    await mkdir(artifactDir, { recursive: true });
    const wav = join(artifactDir, "normalized.wav");
    await writeFile(wav, Buffer.from("deterministic bytes"));
    const provenance = {
      sourceSha256: "a".repeat(64),
      before: { integratedLufs: -20, truePeakDbtp: -2, loudnessRangeLu: 5, thresholdLufs: -30 },
      after: { integratedLufs: -16, truePeakDbtp: -1, loudnessRangeLu: 5, thresholdLufs: -30 },
      normalizationMode: "linear",
      firstPassTargetOffset: 0.1,
    };
    await writeFile(join(artifactDir, "provenance.json"), JSON.stringify(provenance));
    const cacheKey = computeAudioReuseKey({ verb: "v", sourceSha256: provenance.sourceSha256 });
    const algorithmVersion = "normalize@2+ffmpeg version test";
    await recordReusableAudioArtifact({
      root, kind: "audio-normalize", cacheKey, artifactId: "job-1",
      wavFilename: "normalized.wav", wavSha256: "unmatched-sha", algorithmVersion,
    });

    // sha mismatch → miss and the stale entry is pruned.
    expect(await findReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, algorithmVersion, wavFilename: "normalized.wav" })).toBeNull();
    const afterPrune = JSON.parse(await readFile(join(kindRoot, ".reuse-index.json"), "utf8"));
    expect(afterPrune.entries[cacheKey]).toBeUndefined();

    // Correct sha → hit.
    const { sha256File } = await import("./artifact-io");
    const realSha = await sha256File(wav);
    await recordReusableAudioArtifact({
      root, kind: "audio-normalize", cacheKey, artifactId: "job-1",
      wavFilename: "normalized.wav", wavSha256: realSha, algorithmVersion,
    });
    const hit = await findReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, algorithmVersion, wavFilename: "normalized.wav" });
    expect(hit?.artifactId).toBe("job-1");
    expect(hit?.provenance.sourceSha256).toBe(provenance.sourceSha256);

    await writeFile(join(artifactDir, "provenance.json"), JSON.stringify({ ...provenance, after: { ...provenance.after, integratedLufs: -40 } }));
    expect(await findReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, algorithmVersion, wavFilename: "normalized.wav" })).toBeNull();
    await writeFile(join(artifactDir, "provenance.json"), JSON.stringify(provenance));
    await recordReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, artifactId: "job-1", wavFilename: "normalized.wav", wavSha256: realSha, algorithmVersion });

    // Version drift → miss (and prune).
    expect(await findReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, algorithmVersion: "normalize@3+other", wavFilename: "normalized.wav" })).toBeNull();

    // Missing file after deletion → miss.
    await recordReusableAudioArtifact({
      root, kind: "audio-normalize", cacheKey, artifactId: "job-1",
      wavFilename: "normalized.wav", wavSha256: realSha, algorithmVersion,
    });
    await rm(artifactDir, { recursive: true, force: true });
    expect(await findReusableAudioArtifact({ root, kind: "audio-normalize", cacheKey, algorithmVersion, wavFilename: "normalized.wav" })).toBeNull();
  });
});

describe("sweepAbandonedAudioArtifactStaging (AUD-13)", () => {
  it("keeps another producer's directory until that process exits", async () => {
    const producer = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
    const exited = once(producer, "exit");
    await once(producer, "spawn");
    const pending = join(root, "generated-assets", "audio-separate", `.job-live.${producer.pid}.${randomUUID()}.pending`);
    try {
      await mkdir(pending, { recursive: true });
      await writeFile(join(pending, "separated.wav"), "in progress");
      expect(await sweepAbandonedAudioArtifactStaging([root])).not.toContain(pending);
      expect(await readFile(join(pending, "separated.wav"), "utf8")).toBe("in progress");
      producer.kill();
      await exited;
      expect(await sweepAbandonedAudioArtifactStaging([root])).toContain(pending);
    } finally { producer.kill(); await exited; }
  });
  it("removes only exact-pattern staging directories and keeps everything else", async () => {
    const kindRoot = join(root, "generated-assets", "audio-denoise");
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8", windowsHide: true });
    expect(exited.status).toBe(0);
    const pid = Number(exited.stdout);
    const pendingA = join(kindRoot, `.job-a.${pid}.${randomUUID()}.pending`);
    const pendingB = join(kindRoot, `.job-b.${pid}.${randomUUID()}.pending`);
    const active = join(kindRoot, `.job-active.${process.pid}.${randomUUID()}.pending`);
    const legacy = join(kindRoot, `.job-legacy.${randomUUID()}.pending`);
    const published = join(kindRoot, "job-published");
    const indexFile = join(kindRoot, ".reuse-index.json");
    const lookalike = join(kindRoot, ".not-a-staging-dir.pending");
    const notPendingDot = join(kindRoot, ".job-c.not-a-uuid.pending");
    for (const dir of [pendingA, pendingB, active, legacy, published, lookalike, notPendingDot]) {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "denoised.wav"), Buffer.from("x"));
    }
    await writeFile(indexFile, "{}");

    const removed = await sweepAbandonedAudioArtifactStaging([root]);

    expect(removed.sort()).toEqual([pendingA, pendingB].sort());
    for (const kept of [active, legacy, published, lookalike, notPendingDot, indexFile]) {
      await expect(realpath(kept)).resolves.toBeTruthy();
    }
    // Idempotent: nothing left to remove.
    expect(await sweepAbandonedAudioArtifactStaging([root])).toEqual([]);
  });
});
