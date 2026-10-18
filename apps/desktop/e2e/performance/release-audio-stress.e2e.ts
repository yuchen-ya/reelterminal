import { test, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdir, copyFile, writeFile, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { createAgentFacade } from "@reelterminal/agent-facade";
import { runReleaseFeature } from "../harness/performance/release-feature";

const enabled = process.env.REELTERMINAL_RELEASE_FEATURE === "audio";
(enabled ? test : test.skip)("real audio full-event reads, stable records and normalized asset lifecycle", async () => {
  await runReleaseFeature("audio", async c => {
    const jobs = Number(process.env.REELTERMINAL_FEATURE_AUDIO_JOBS ?? 10);
    const durationSeconds = Number(process.env.REELTERMINAL_FEATURE_AUDIO_READ_SECONDS ?? 1800);
    const reads = Number(process.env.REELTERMINAL_FEATURE_AUDIO_READS ?? 200);
    if (![jobs, durationSeconds, reads].every(n => Number.isSafeInteger(n) && n > 0)) throw new Error("invalid audio scale");
    c.record.scale = { jobs_per_kind: jobs, fixed_record_reads: reads, fixed_record_observation_seconds: durationSeconds, source_seconds: 130, analyzed_seconds: 120, channels: 2, source_rate: 44100 };
    const root = path.join(c.record.capabilities.mediaImport.recommendedRoot, "jobs", "release-audio-" + Date.now());
    expect(root.startsWith(c.app.runDir)).toBe(true);
    await mkdir(root, { recursive: true });
    const source = path.join(root, "pulsed-44100-stereo.wav");
    const ffmpeg = process.env.REELTERMINAL_FFMPEG_PATH || "ffmpeg";
    const ffprobe = process.env.REELTERMINAL_FFPROBE_PATH || "ffprobe";
    const run = (bin: string, args: string[]) => execFileSync(bin, args, { timeout: 180_000, maxBuffer: 32 * 1024 * 1024 });
    const hash = async (file: string) => createHash("sha256").update(await readFile(file)).digest("hex");
    run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=if(lt(mod(t\\,0.2)\\,0.04)\\,0.2*sin(2*PI*997*t)\\,0):s=44100:d=130", "-ac", "2", "-c:a", "pcm_s16le", source]);
    c.record.source_sha256 = await hash(source);
    await copyFile(source, path.join(c.evidence, "source.wav"));
    const importResult = await c.call("media.import", { path: source, expectedRevision: (await c.call("project.get_state")).revision, idempotencyKey: "release-audio-source" });
    const channelMedia: { name: string; mediaId: string }[] = [];
    for (const [name, expression] of [["right-only", "0|0.2*sin(2*PI*997*t)"], ["anti-phase", "0.2*sin(2*PI*997*t)|-0.2*sin(2*PI*997*t)"]]) {
      const file = path.join(root, name + ".wav");
      run(ffmpeg, ["-v", "error", "-f", "lavfi", "-i", "aevalsrc=" + expression + ":s=44100:d=4", "-c:a", "pcm_s16le", file]);
      const imported = await c.call("media.import", { path: file, expectedRevision: (await c.call("project.get_state")).revision, idempotencyKey: name });
      channelMedia.push({ name: name!, mediaId: imported.mediaId });
      await copyFile(file, path.join(c.evidence, name + ".wav"));
    }
    const analysisParams = { mediaId: importResult.mediaId, analysisTypes: ["audioSummary", "silence", "beatGrid"] as const, startSec: 0, endSec: 120, silenceParams: { thresholdDb: -35, minDurationSec: .05, paddingSec: 0 } };
    const before = await c.call("project.get_state");
    const wait = async (jobId: string) => {
      const deadline = Date.now() + 300_000;
      for (;;) {
        const status = await c.call("job.status", { jobId });
        if (["done", "error", "cancelled"].includes(status.state)) return status;
        if (Date.now() > deadline) throw new Error("audio job did not settle: " + jobId);
        await c.app.page.waitForTimeout(50);
      }
    };
    const pageEvents = async (recordId: string) => {
      let cursor: string | undefined;
      const events: any[] = [];
      let pages = 0;
      do {
        const result = await c.call("analysis.get", { recordId, view: "events", series: "silence.silentRegions", limit: 128, ...(cursor ? { cursor } : {}) });
        expect(result.events.items.length).toBeLessThanOrEqual(128);
        expect(result.events.complete).toBe(true);
        events.push(...result.events.items);
        cursor = result.events.nextCursor ?? undefined;
        pages++;
        if (pages > 1000) throw new Error("pagination did not end");
      } while (cursor);
      expect(new Set(events.map(event => event.id)).size).toBe(events.length);
      expect(events.length).toBeGreaterThan(256);
      return { events, pages };
    };
    c.record.analysis_jobs = [];
    c.record.phase = "analysis_jobs";
    c.record.channel_checks = [];
    for (const media of channelMedia) {
      const start = await c.call("media.analyze_start", { mediaId: media.mediaId, analysisTypes: ["audioSummary"], startSec: 0, endSec: 4, expectedRevision: before.revision, idempotencyKey: "channel-check-" + media.name });
      const status = await wait(start.jobId);
      expect(status.state).toBe("done");
      expect(status.result.summary.audioSummary.silenceCount).toBe(0);
      c.record.channel_checks.push({ name: media.name, status });
    }
    let fixedJob: any;
    let fixedRecord = "";
    for (let index = 0; index < jobs; index++) {
      const start = performance.now();
      const submitted = await c.call("media.analyze_start", { ...analysisParams, expectedRevision: before.revision, idempotencyKey: "release-analysis-" + index });
      const status = await wait(submitted.jobId);
      expect(status.state).toBe("done");
      const recordId = status.result.summary.analysisRecord.id;
      const summary = await c.call("analysis.get", { recordId });
      expect(JSON.stringify(summary)).not.toMatch(/"(?:silentRegions|waveform|onsets|beats)":/);
      expect(JSON.stringify(status.result.summary)).not.toMatch(/"(?:silentRegions|waveform|onsets|beats)":/);
      const paged = await pageEvents(recordId);
      expect(paged.events.length).toBe(summary.details.find((detail: any) => detail.series === "silence.silentRegions").totalCount);
      c.record.analysis_jobs.push({ index, elapsed_ms: performance.now() - start, status, summary, event_count: paged.events.length, pages: paged.pages });
      if (index === 0) await writeFile(path.join(c.evidence, "complete-silence-events.json"), JSON.stringify(paged.events, null, 2));
      fixedJob = status; fixedRecord = recordId;
      await c.flush(); console.info("REAL_AUDIO_ANALYSIS_COMPLETE", { index, events: paged.events.length });
    }
    expect((await c.call("project.get_state")).revision).toBe(before.revision);
    // A separate headless session consumes the same bytes after live work ends.
    const headless = createAgentFacade({ mediaRoots: [root], projectRoots: [root], artifactRoot: path.join(root, "headless-records") });
    const unwrap = (reply: any) => { if (!reply.ok) throw new Error(reply.error?.message); return reply.value; };
    unwrap(await headless["project.create"]({ name: "Audio parity" }));
    const headlessMedia = unwrap(await headless["media.import"]({ path: source }));
    const headlessStart = unwrap(await headless["media.analyze_start"]({ ...analysisParams, mediaId: headlessMedia.mediaId, idempotencyKey: "headless-parity" }));
    let headlessStatus: any;
    const parityDeadline = Date.now() + 300_000;
    do {
      headlessStatus = unwrap(await headless["job.status"]({ jobId: headlessStart.jobId }));
      if (Date.now() > parityDeadline) throw new Error("headless parity timeout");
      if (!["done", "error", "cancelled"].includes(headlessStatus.state)) await c.app.page.waitForTimeout(50);
    } while (!["done", "error", "cancelled"].includes(headlessStatus.state));
    expect(headlessStatus.state).toBe("done");
    const headlessSummary: any = unwrap(await headless["analysis.get"]({ recordId: headlessStatus.result.summary.analysisRecord.id }));
    const liveSummary = await c.call("analysis.get", { recordId: fixedRecord });
    // Session identity and import timestamps legitimately differ. Preserve both
    // originals and compare every analytical fact, including fingerprint size.
    const comparableFacts = (summary: any) => summary.observations.map((o: any) => {
      const facts = structuredClone(o.facts);
      delete facts.mediaId;
      if (facts.sourceFingerprint) delete facts.sourceFingerprint.lastModified;
      return facts;
    });
    c.record.headless_parity = { status: headlessStatus, live_summary: liveSummary, headless_summary: headlessSummary, excluded_session_fields: ["mediaId", "sourceFingerprint.lastModified"] };
    expect(comparableFacts(headlessSummary)).toEqual(comparableFacts(liveSummary));
    c.record.headless_parity.summary_facts_equal = true;
    const badQuery = await c.reply("analysis.get", { recordId: fixedRecord, view: "events", series: "silence.silentRegions", limit: 257 });
    expect(badQuery.ok).toBe(false);
    c.record.invalid_query = { ok: badQuery.ok, error: badQuery.error };
    c.record.phase = "fixed_record_observation";
    c.record.read_observation_started_epoch_ms = Date.now();
    const observationStart = performance.now();
    let nextSample = 0;
    c.record.reads = [];
    for (let index = 0; index < reads || performance.now() - observationStart < durationSeconds * 1000; index++) {
      expect(await c.app.page.evaluate(() => !document.hidden)).toBe(true);
      const start = performance.now();
      const status = await c.call("job.status", { jobId: fixedJob.jobId });
      const summary = await c.call("analysis.get", { recordId: fixedRecord });
      expect(status.state).toBe("done");
      expect(summary).toEqual(liveSummary);
      const paged = await pageEvents(fixedRecord);
      const waveform = await c.call("analysis.get", { recordId: fixedRecord, view: "waveform", startSec: 0, endSec: 120, maxPoints: 600 });
      expect(waveform.waveform.points.length).toBeLessThanOrEqual(600);
      c.record.reads.push({ index, elapsed_ms: performance.now() - start, summary_bytes: Buffer.byteLength(JSON.stringify(summary)), status_bytes: Buffer.byteLength(JSON.stringify(status)), waveform_bytes: Buffer.byteLength(JSON.stringify(waveform)), events: paged.events.length, pages: paged.pages });
      if (performance.now() - observationStart >= nextSample) { await c.app.page.waitForTimeout(1000); await c.sample(); await c.flush(); nextSample = performance.now() - observationStart + 30_000; console.info("AUDIO_FIXED_RECORD_PROGRESS", { elapsed_seconds: Math.round((performance.now() - observationStart) / 1000), completed_reads: index + 1 }); }
      const remaining = (index + 1) * durationSeconds * 1000 / reads - (performance.now() - observationStart);
      if (remaining > 0) await c.app.page.waitForTimeout(remaining);
    }
    c.record.read_observation_elapsed_ms = performance.now() - observationStart;
    expect(c.record.read_observation_elapsed_ms).toBeGreaterThanOrEqual(durationSeconds * 1000);
    expect((await c.call("project.get_state")).revision).toBe(before.revision);
    c.record.phase = "normalization_jobs";
    const params = { mediaId: importResult.mediaId, audioStream: 0, startSec: 1.123, endSec: 121.123, targetLufs: -18, truePeakDbtp: -1, loudnessRangeLu: 11, sampleRate: 48000, channels: 2 };
    c.record.normalization_params = params;
    c.record.normalizations = [];
    const failureJob = await c.call("audio.process.normalize", { ...params, expectedRevision: (await c.call("project.get_state")).revision, idempotencyKey: "normalize-owned-ffmpeg-failure" });
    const mainPid = await c.app.app.evaluate(() => process.pid);
    const killDeadline = Date.now() + 30_000;
    let ownedFfmpeg: number | undefined;
    while (!ownedFfmpeg && Date.now() < killDeadline) {
      const rows = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n");
      for (const line of rows) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match && Number(match[2]) === mainPid && path.basename(match[3]!) === "ffmpeg") ownedFfmpeg = Number(match[1]);
      }
      if (!ownedFfmpeg) await c.app.page.waitForTimeout(20);
    }
    expect(ownedFfmpeg, "the isolated app's real FFmpeg process was not observed").toBeDefined();
    c.record.ffmpeg_failure_injection = { app_pid: mainPid, child_pid: ownedFfmpeg, method: "SIGTERM_owned_ffmpeg_child" };
    await c.flush();
    process.kill(ownedFfmpeg!, "SIGTERM");
    c.record.ffmpeg_failure = await wait(failureJob.jobId);
    expect(c.record.ffmpeg_failure.state).toBe("error");
    expect(c.record.ffmpeg_failure.result).toBeNull();
    for (let index = 0; index < jobs; index++) {
      const state = await c.call("project.get_state");
      const start = performance.now();
      const submitted = await c.call("audio.process.normalize", { ...params, expectedRevision: state.revision, idempotencyKey: "release-normalize-" + index });
      const status = await wait(submitted.jobId);
      expect(status.state, JSON.stringify(status.error)).toBe("done");
      expect((await c.call("project.get_state")).revision).toBe(state.revision);
      const output = status.result.path;
      const probe = JSON.parse(run(ffprobe, ["-v", "error", "-show_streams", "-show_format", "-of", "json", output]).toString());
      expect(probe.streams[0]).toMatchObject({ codec_name: "pcm_s24le", sample_rate: "48000", channels: 2, duration_ts: 5760000 });
      run(ffmpeg, ["-v", "error", "-i", output, "-f", "null", "-"]);
      const { spawnSync } = await import("node:child_process");
      const measured = spawnSync(ffmpeg, ["-hide_banner", "-nostdin", "-i", output, "-af", "loudnorm=I=-18:TP=-1:LRA=11:print_format=json", "-f", "null", "-"], { encoding: "utf8", timeout: 180_000, maxBuffer: 16 * 1024 * 1024 });
      expect(measured.status).toBe(0);
      const match = /\{\s*"input_i"[\s\S]*?\}/.exec(measured.stderr);
      if (!match) throw new Error("independent loudness measurement missing");
      const loudness = JSON.parse(match[0]);
      expect(Math.abs(Number(loudness.input_i) - params.targetLufs)).toBeLessThanOrEqual(1);
      expect(Number(loudness.input_tp)).toBeLessThanOrEqual(params.truePeakDbtp + .2);
      await copyFile(output, path.join(c.evidence, "normalized-" + index + ".wav"));
      await copyFile(status.result.provenancePath, path.join(c.evidence, "provenance-" + index + ".json"));
      if (index === jobs - 1) {
        const stale = await c.reply("audio.process.register", { jobId: submitted.jobId, expectedRevision: state.revision - 1 });
        expect(stale.ok).toBe(false);
        expect(stale.error.code).toBe("CONFLICT");
        const validBytes = await readFile(output);
        await writeFile(output, Buffer.concat([validBytes, Buffer.from([0])]));
        const changed = await c.reply("audio.process.register", { jobId: submitted.jobId, expectedRevision: state.revision });
        expect(changed.ok).toBe(false);
        await copyFile(output, path.join(c.evidence, "tampered-normalized.wav"));
        await writeFile(output, validBytes);
        c.record.registration_negatives = { stale: { ok: stale.ok, error: stale.error }, tampered: { ok: changed.ok, error: changed.error } };
      }
      const registered = await c.call("audio.process.register", { jobId: submitted.jobId, expectedRevision: state.revision });
      const replay = await c.call("audio.process.register", { jobId: submitted.jobId, expectedRevision: state.revision });
      expect(replay.mediaId).toBe(registered.mediaId);
      expect(replay.replayed).toBe(true);
      c.record.normalizations.push({ index, elapsed_ms: performance.now() - start, job: status, probe, measured: loudness, registered, replay, output_sha256: await hash(output) });
      await c.sample(); await c.flush(); console.info("REAL_NORMALIZATION_COMPLETE", { index });
    }
    expect(await hash(source)).toBe(c.record.source_sha256);
    // Deliberate cancellation happens after an actual running status, and
    // settle is observed before testing queue recovery.
    const cancelStart = await c.call("audio.process.normalize", { ...params, expectedRevision: (await c.call("project.get_state")).revision, idempotencyKey: "normalize-cancel" });
    const cancelDeadline = Date.now() + 30_000;
    let cancelChild: number | undefined;
    while (!cancelChild && Date.now() < cancelDeadline) {
      for (const line of execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" }).split("\n")) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
        if (match && Number(match[2]) === mainPid && path.basename(match[3]!) === "ffmpeg") cancelChild = Number(match[1]);
      }
      if (!cancelChild) await c.app.page.waitForTimeout(20);
    }
    expect(cancelChild, "actual owned FFmpeg was not observed before cancellation").toBeDefined();
    c.record.cancel_owned_ffmpeg_pid = cancelChild;
    c.record.cancel_before = await c.call("job.status", { jobId: cancelStart.jobId });
    expect(["queued", "running"]).toContain(c.record.cancel_before.state);
    await c.call("job.cancel", { jobId: cancelStart.jobId });
    c.record.cancellation = await wait(cancelStart.jobId);
    expect(c.record.cancellation.state).toBe("cancelled");
    expect(c.record.cancellation.result).toBeNull();
    const recoveryStart = await c.call("audio.process.normalize", { ...params, expectedRevision: (await c.call("project.get_state")).revision, idempotencyKey: "normalize-after-cancel" });
    c.record.cancel_recovery = await wait(recoveryStart.jobId);
    expect(c.record.cancel_recovery.state).toBe("done");
    await c.flush(); console.info("REAL_AUDIO_CANCEL_RECOVERY_COMPLETE");
    const generatedRoot = path.dirname(path.dirname(c.record.normalizations[0].job.result.path));
    c.record.failed_cancelled_files = {};
    const children = await readdir(generatedRoot);
    for (const job of [c.record.ffmpeg_failure, c.record.cancellation]) {
      const matching = children.filter(name => name.includes(job.jobId));
      c.record.failed_cancelled_files[job.jobId] = matching;
      expect(matching).toEqual([]);
    }
    const saved = await c.call("node.save", { expectedRevision: (await c.call("project.get_state")).revision, name: "Audio registered outputs" });
    c.record.saved_node = saved;
    await c.app.page.keyboard.press("Control+s");
    await c.app.page.waitForFunction(async () => {
      const r = await (globalThis as any).__reelterminalPerformanceCapture.readResources();
      return r.workspace.pendingWrites === 0 && r.workspace.queuedWrites === 0 && r.autoSave.queuedSaveOperations === 0;
    }, null, { timeout: 30_000 });
    const originalProject = (await c.call("project.get_state")).project;
    await c.app.page.screenshot({ path: path.join(c.evidence, "audio-assets.png") });
    c.record.phase = "relaunch_recovery"; await c.flush();
    await c.reconnect();
    const restored = await c.call("project.get_state");
    expect(restored.project.mediaLibrary.items.map((m: any) => m.id)).toEqual(originalProject.mediaLibrary.items.map((m: any) => m.id));
    c.record.recovered_job = await c.call("job.status", { jobId: c.record.normalizations[0].job.jobId });
    expect(c.record.recovered_job.state).toBe("done");
    c.record.phase = "finished";
    await c.sample();
    // Copy only persisted status documents; never endpoint descriptors.
    const collect = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await collect(file);
        else if (entry.name.endsWith(".status.json")) await copyFile(file, path.join(c.evidence, entry.name));
      }
    };
    await collect(c.app.runDir);
  });
}, 7_200_000);
