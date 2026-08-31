/**
 * Appendix D scenario 2 — `slice2-persistence-e2e` (r2.2, Decision 10),
 * executed COMPLETELY over two paths (run / mcp-simulated) and BOTH kill
 * variants of step 3 (clean SIGTERM after save, SIGKILL after save — both
 * must pass). The checkpoint file is the only state crossing the process
 * boundary; the corruption honesty probes of step 6d run in fresh
 * processes, one probe per process.
 */
import { existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import path from "node:path";

import { CLIP_DURATION_SEC, PROJECT_SETTINGS } from "./env.mjs";
import { doctorChecks, runDoctor } from "./doctor.mjs";
import { ServeClient } from "./mcp.mjs";
import { runWorkflow, spawnWorkflow, waitForLine } from "./run.mjs";
import {
  WORDINGS,
  computeStateSha256,
  lineById,
  of,
  okValue,
} from "./common.mjs";
import {
  compareSimilarChecks,
  continueEditChecks,
  corruptionProbeChecks,
  createChecks,
  editChecks,
  exportDoneChecks,
  exportStartedChecks,
  importChecks,
  mediaMovedDetailsChecks,
  openChecks,
  openConflictChecks,
  previewChecks,
  saveChecks,
  saveConflictChecks,
  timelineDeepEqualChecks,
  verifyProbeChecks,
} from "./steps.mjs";
import {
  CREATE_KEY,
  CREATE_PARAMS,
  EDIT_KEY,
  EDIT_OPS,
  EXPORT_SETTINGS,
  IMPORT_KEY,
  VERIFY_EXPECT,
  eqExit,
  pollToTerminal,
  truthyExit,
} from "./scenario1.mjs";

const SECOND_OVERLAY = "Second overlay";

function editOpsA(mediaId) {
  return EDIT_OPS(mediaId);
}

function editOpsB() {
  return [{ op: "text.create", text: SECOND_OVERLAY, trackId: "t1", startTime: 0, duration: CLIP_DURATION_SEC }];
}

/* ------------------------------------------------------------------ */
/* Path (a) — run                                                      */
/* ------------------------------------------------------------------ */

export async function scenario2Run({ env, recorder, cliPath, variant }) {
  const label = `s2-run-${variant.toLowerCase()}`;
  const v1Path = path.join(env.projectRoot, "e2e-v1.openreel.json");
  const v2Path = path.join(env.projectRoot, "e2e-v2.openreel.json");

  // Step 0 — doctor (same environment contract as scenario 1).
  const doctor1 = await runDoctor({ cliPath, env: env.cliEnv(), recorder, label });
  await recorder.step("0", "doctor report is usable and complete", doctorChecks(doctor1));

  // Step 1+2 — process A: create + edit + previewA + save. The workflow then
  // starts an export so the process is mid-job and still alive after the
  // save line appeared — that is when the variant's signal arrives.
  const handle = spawnWorkflow({
    cliPath,
    recorder,
    label: `${label}/A`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY } },
      { id: "import", verb: "media.import", params: { path: env.inputMp4, expectedRevision: 0, idempotencyKey: IMPORT_KEY } },
      { id: "edit", verb: "edit.apply", params: { ops: editOpsA({ $ref: "import#/mediaId" }), expectedRevision: 1, idempotencyKey: EDIT_KEY } },
      { id: "timelineA", verb: "timeline.get", params: {} },
      { id: "previewA", verb: "preview.render_frame", params: { timeSec: 2.5 } },
      { id: "save", verb: "project.save", params: { path: v1Path } },
      { id: "export", verb: "export.start", params: { settings: EXPORT_SETTINGS, idempotencyKey: "s2-expA" } },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 1_200_000, pollMs: 2000 } },
    ],
  });

  // Step 2 — the save line IS the save having completed (run emits one JSON
  // line per executed step).
  const saveLine = await waitForLine(handle, (l) => l.id === "save", 300_000);
  const saveValue = okValue(saveLine, "save");
  const timelineAValue = okValue(handle.lines.find((l) => l.id === "timelineA"), "timelineA");
  const previewAValue = okValue(handle.lines.find((l) => l.id === "previewA"), "previewA");
  const revisionBefore = timelineAValue.revision;
  await recorder.step("1", "process A: create + import + edit + previewA at 2.5 s", [
    ...createChecks(okValue(handle.lines.find((l) => l.id === "create"), "create")),
    ...importChecks(okValue(handle.lines.find((l) => l.id === "import"), "import")),
    ...editChecks(okValue(handle.lines.find((l) => l.id === "edit"), "edit")),
    ...(await previewChecks(previewAValue, env)),
  ]);
  await recorder.sha256Of(previewAValue.artifact.path, "s2 previewA PNG");

  await recorder.step("2", "process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings", [
    ...saveChecks(saveValue, { expectedRevision: revisionBefore, savePath: v1Path }),
    ...(await checkpointFileChecks({ savePath: v1Path, projectRoot: env.projectRoot })),
  ]);
  await recorder.sha256Of(v1Path, "s2 e2e-v1.openreel.json");

  // Step 3 — kill process A entirely (variant: SIGTERM clean / SIGKILL hard).
  await waitForLine(handle, (l) => l.id === "export", 60_000);
  handle.child.kill(variant);
  const exit = await handle.exitPromise;
  const expectedExit = variant === "SIGTERM" ? { code: 143 } : { code: null, signal: "SIGKILL" };
  await recorder.step("3", `process A killed entirely (${variant}) — checkpoint already complete and visible`, [
    {
      name: variant === "SIGTERM" ? "run process exited 143 (first-signal bounded disposal)" : "run process was killed by SIGKILL (no in-process cleanup)",
      pass: exit.code === expectedExit.code && (variant === "SIGTERM" || exit.signal === "SIGKILL"),
      detail: `exit=${JSON.stringify(exit)}`,
    },
    {
      name: "checkpoint file still present at the exact saved path",
      pass: existsSync(v1Path),
      detail: v1Path,
    },
  ]);

  // Step 4 — third process: create then open ⇒ CONFLICT (no silent takeover).
  const conflictRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/C-open-conflict`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: "s2-createC" } },
      { id: "open", verb: "project.open", params: { path: v1Path, idempotencyKey: "s2-openC" } },
    ],
  });
  await recorder.step("4a", "third process: project_create then project_open ⇒ CONFLICT", [
    eqExit("probe run exit 1 (the CONFLICT is the expected outcome)", conflictRun.exitCode, 1),
    ...openConflictChecks(of(lineById(conflictRun.lines, "open"))),
  ]);

  // Steps 4b+5+6 — process B (one fresh session): open, deep-equal timeline,
  // continue edit, save v2, save-conflict on v1, previewB, export, verify.
  const bRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/B`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "open", verb: "project.open", params: { path: v1Path, idempotencyKey: `s2-openB-${variant.toLowerCase()}` } },
      { id: "timelineB", verb: "timeline.get", params: {} },
      { id: "edit2", verb: "edit.apply", params: { ops: editOpsB(), expectedRevision: revisionBefore, idempotencyKey: "s2-editB" } },
      { id: "save2", verb: "project.save", params: { path: v2Path } },
      { id: "saveConflict", verb: "project.save", params: { path: v1Path } },
      { id: "previewB", verb: "preview.render_frame", params: { timeSec: 2.5 } },
      { id: "export", verb: "export.start", params: { settings: EXPORT_SETTINGS, idempotencyKey: `s2-expB-${variant.toLowerCase()}` } },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 1_200_000, pollMs: 2000 } },
      { id: "battery", verb: "verify.artifact", params: { path: { $ref: "wait#/artifact/path" }, expect: VERIFY_EXPECT } },
      {
        id: "simB",
        verb: "verify.artifact",
        params: {
          path: { $ref: "wait#/artifact/path" },
          compare: { referencePath: { $ref: "previewB#/artifact/path" }, timeSec: 2.5, region: TEXT_REGION, mode: "similar", maxMeanAbsDiff: 14 },
        },
      },
      {
        id: "simA",
        verb: "verify.artifact",
        params: {
          path: { $ref: "wait#/artifact/path" },
          compare: { referencePath: previewAValue.artifact.path, timeSec: 2.5, mode: "similar" },
        },
      },
    ],
  });
  if (bRun.exitCode !== 0) {
    throw new Error(`process B workflow exited ${bRun.exitCode}: ${JSON.stringify(bRun.lines).slice(0, 2000)}`);
  }
  const openValue = okValue(lineById(bRun.lines, "open"), "open");
  const timelineBValue = okValue(lineById(bRun.lines, "timelineB"), "timelineB");
  const edit2Value = okValue(lineById(bRun.lines, "edit2"), "edit2");
  const save2Value = okValue(lineById(bRun.lines, "save2"), "save2");
  const previewBValue = okValue(lineById(bRun.lines, "previewB"), "previewB");
  const exportBValue = okValue(lineById(bRun.lines, "export"), "export");
  const waitBValue = okValue(lineById(bRun.lines, "wait"), "wait");
  const batteryValue = okValue(lineById(bRun.lines, "battery"), "battery");
  const simBValue = okValue(lineById(bRun.lines, "simB"), "simB");
  const simAValue = okValue(lineById(bRun.lines, "simA"), "simA");

  await recorder.step("4b", "process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals", [
    ...openChecks(openValue, revisionBefore),
    ...timelineDeepEqualChecks(timelineBValue, timelineAValue),
  ]);
  await recorder.step("5a", "process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1", continueEditChecks(edit2Value, revisionBefore));
  await recorder.step("5b", "process B: save to NEW path e2e-v2 ⇒ ok", saveChecks(save2Value, { expectedRevision: revisionBefore + 1, savePath: v2Path }));
  await recorder.step("5c", "process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite)", [
    ...saveConflictChecks(of(lineById(bRun.lines, "saveConflict"))),
  ]);
  await recorder.step("6a", "process B: pixels — previewB renders the pre-restart content", [
    ...(await previewChecks(previewBValue, env)),
  ]);
  await recorder.sha256Of(previewBValue.artifact.path, "s2 previewB PNG");
  await recorder.step("6b", "process B: compare similar previewB vs previewA — pixel continuity across the restart", [
    ...compareSimilarChecks(simAValue, "previewA.png (pre-restart)"),
  ]);
  await recorder.step("8a", "process B export_start ⇒ queued", exportStartedChecks(exportBValue));
  await recorder.step("8b", "process B export reached terminal done", exportDoneChecks(waitBValue));
  await recorder.sha256Of(waitBValue.artifact.path, "s2 exported MP4");
  await recorder.step("6c", "process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview", [
    ...verifyProbeChecks(batteryValue),
    ...compareSimilarChecks(simBValue, "previewB.png (own preview)"),
  ]);

  // Step 6d — corruption honesty probes (each in a fresh process).
  await runCorruptionProbes({ env, recorder, cliPath, mode: "run", v1Path, variant });

  await recorder.step("9", "scenario 2 complete (run path)", [
    { name: "all process boundaries crossed via the checkpoint file only", pass: true, detail: `variant=${variant} revisionBefore=${revisionBefore}` },
  ]);
}

/* ------------------------------------------------------------------ */
/* Path (b) — mcp (simulated client)                                   */
/* ------------------------------------------------------------------ */

export async function scenario2Mcp({ env, recorder, cliPath, variant }) {
  const label = `s2-mcp-${variant.toLowerCase()}`;
  const v1Path = path.join(env.projectRoot, "e2e-v1.openreel.json");
  const v2Path = path.join(env.projectRoot, "e2e-v2.openreel.json");

  const doctor1 = await runDoctor({ cliPath, env: env.cliEnv(), recorder, label });
  await recorder.step("0", "doctor report is usable and complete", doctorChecks(doctor1));

  // Process A.
  const clientA = new ServeClient({ cliPath, args: env.cliFlags(), env: env.cliEnv(), recorder, label: `${label}/A` });
  await clientA.initialize();
  const created = await clientA.call("project_create", { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY });
  const imported = await clientA.call("media_import", { path: env.inputMp4, expectedRevision: 0, idempotencyKey: IMPORT_KEY });
  const edited = await clientA.call("edit_apply", { ops: editOpsA(imported.facadeResult.value.mediaId), expectedRevision: 1, idempotencyKey: EDIT_KEY });
  const previewA = await clientA.call("preview_render_frame", { timeSec: 2.5 });
  await recorder.step("1", "process A: create + import + edit + previewA at 2.5 s", [
    ...createChecks(created.facadeResult.value),
    ...importChecks(imported.facadeResult.value),
    ...editChecks(edited.facadeResult.value),
    ...(await previewChecks(previewA.facadeResult.value, env)),
  ]);
  await recorder.sha256Of(previewA.facadeResult.value.artifact.path, "s2 previewA PNG (mcp)");

  const timelineA = await clientA.call("timeline_get", {});
  const revisionBefore = timelineA.facadeResult.value.revision;
  const saved = await clientA.call("project_save", { path: v1Path });
  await recorder.step("2", "process A: save checkpoint ⇒ ok; revision == revisionBefore; exact path; no .tmp siblings", [
    ...saveChecks(saved.facadeResult.value, { expectedRevision: revisionBefore, savePath: v1Path }),
    ...(await checkpointFileChecks({ savePath: v1Path, projectRoot: env.projectRoot })),
  ]);
  await recorder.sha256Of(v1Path, "s2 e2e-v1.openreel.json (mcp)");

  // Step 3 — kill process A entirely (after the save returned ok).
  clientA.kill(variant);
  const exitA = await clientA.waitForExit();
  await recorder.step("3", `process A killed entirely (${variant}) — checkpoint already complete and visible`, [
    {
      name: variant === "SIGTERM" ? "serve exited 143 (first-signal bounded disposal)" : "serve was killed by SIGKILL (no in-process cleanup)",
      pass: variant === "SIGTERM" ? exitA === 143 : exitA === null,
      detail: `exit=${exitA}`,
    },
    { name: "checkpoint file still present at the exact saved path", pass: existsSync(v1Path), detail: v1Path },
  ]);

  // Third process: create then open ⇒ CONFLICT.
  const clientC = new ServeClient({ cliPath, args: env.cliFlags(), env: env.cliEnv(), recorder, label: `${label}/C` });
  await clientC.initialize();
  await clientC.call("project_create", { ...CREATE_PARAMS, idempotencyKey: "s2-createC" });
  const openConflict = await clientC.call("project_open", { path: v1Path, idempotencyKey: "s2-openC" });
  await recorder.step("4a", "third process: project_create then project_open ⇒ CONFLICT", openConflictChecks(openConflict.facadeResult));
  await clientC.disconnect();
  await clientC.waitForExit();

  // Process B.
  const clientB = new ServeClient({ cliPath, args: env.cliFlags(), env: env.cliEnv(), recorder, label: `${label}/B` });
  await clientB.initialize();
  const opened = await clientB.call("project_open", { path: v1Path, idempotencyKey: `s2-openB-${variant.toLowerCase()}` });
  const timelineB = await clientB.call("timeline_get", {});
  await recorder.step("4b", "process B: fresh session, empty ledger — project_open ⇒ adopted at revisionBefore; timeline deep-equals", [
    ...openChecks(opened.facadeResult.value, revisionBefore),
    ...timelineDeepEqualChecks(timelineB.facadeResult.value, timelineA.facadeResult.value),
  ]);

  const edit2 = await clientB.call("edit_apply", { ops: editOpsB(), expectedRevision: revisionBefore, idempotencyKey: "s2-editB" });
  await recorder.step("5a", "process B: continue edit (expectedRevision == revisionBefore) ⇒ revision + 1", continueEditChecks(edit2.facadeResult.value, revisionBefore));

  const saved2 = await clientB.call("project_save", { path: v2Path });
  await recorder.step("5b", "process B: save to NEW path e2e-v2 ⇒ ok", saveChecks(saved2.facadeResult.value, { expectedRevision: revisionBefore + 1, savePath: v2Path }));

  const saveConflict = await clientB.call("project_save", { path: v1Path });
  await recorder.step("5c", "process B: save back onto v1 without overwrite ⇒ CONFLICT (default no-overwrite)", saveConflictChecks(saveConflict.facadeResult));

  const previewB = await clientB.call("preview_render_frame", { timeSec: 2.5 });
  await recorder.step("6a", "process B: pixels — previewB renders the pre-restart content", previewChecks(previewB.facadeResult.value, env));
  await recorder.sha256Of(previewB.facadeResult.value.artifact.path, "s2 previewB PNG (mcp)");

  const exportB = await clientB.call("export_start", { settings: EXPORT_SETTINGS, idempotencyKey: `s2-expB-${variant.toLowerCase()}` });
  const doneB = await pollToTerminal({ client: clientB, jobId: exportB.facadeResult.value.jobId, recorder, label: `${label}/B` });
  await recorder.step("8", "process B export_start ⇒ queued → terminal done (poll 2.5 s)", [
    ...exportStartedChecks(exportB.facadeResult.value),
    ...exportDoneChecks(doneB),
  ]);
  await recorder.sha256Of(doneB.artifact.path, "s2 exported MP4 (mcp)");

  const battery = await clientB.call("verify_artifact", { path: doneB.artifact.path, expect: VERIFY_EXPECT });
  const simB = await clientB.call("verify_artifact", {
    path: doneB.artifact.path,
    compare: { referencePath: previewB.facadeResult.value.artifact.path, timeSec: 2.5, region: TEXT_REGION, mode: "similar", maxMeanAbsDiff: 14 },
  });
  const simA = await clientB.call("verify_artifact", {
    path: doneB.artifact.path,
    compare: { referencePath: previewA.facadeResult.value.artifact.path, timeSec: 2.5, mode: "similar" },
  });
  await recorder.step("6b", "process B: compare similar previewB vs previewA — pixel continuity across the restart", [
    ...compareSimilarChecks(simA.facadeResult.value, "previewA.png (pre-restart)"),
  ]);
  await recorder.step("6c", "process B: full verify battery of scenario 1 step 9 incl. compare-similar vs its own preview", [
    ...verifyProbeChecks(battery.facadeResult.value),
    ...compareSimilarChecks(simB.facadeResult.value, "previewB.png (own preview)"),
  ]);
  await clientB.disconnect();
  await clientB.waitForExit();

  // Step 6d — corruption honesty probes (each in a fresh process).
  await runCorruptionProbes({ env, recorder, cliPath, mode: "mcp", v1Path, variant });

  await recorder.step("9", "scenario 2 complete (mcp path)", [
    { name: "all process boundaries crossed via the checkpoint file only", pass: true, detail: `variant=${variant} revisionBefore=${revisionBefore}` },
  ]);
}

/* ------------------------------------------------------------------ */
/* Step 6d — the five corruption honesty probes                        */
/* ------------------------------------------------------------------ */

async function runCorruptionProbes({ env, recorder, cliPath, mode, v1Path, variant }) {
  const label = `${mode === "run" ? "s2-run" : "s2-mcp"}-${variant.toLowerCase()}`;
  const probesDir = path.join(env.projectRoot, "probes");
  await fs.mkdir(probesDir, { recursive: true });
  const raw = await fs.readFile(v1Path, "utf8");
  const doc = JSON.parse(raw);
  const mediaId = doc.mediaRefs[0].mediaId;

  // Open helper: one probe = one fresh process (open needs an empty session).
  const openExpectingRefusal = async (probeId, title, checkpointPath, { code, wording }) => {
    if (mode === "run") {
      const run = await runWorkflow({
        cliPath,
        recorder,
        label: `${label}/probe-${probeId}`,
        scratchDir: env.scratchDir,
        env: env.cliEnv(),
        flags: env.cliFlags(),
        steps: [{ id: "open", verb: "project.open", params: { path: checkpointPath } }],
      });
      await recorder.step(probeId, title, [
        eqExit("probe run exit 1 (the refusal is the expected outcome)", run.exitCode, 1),
        ...corruptionProbeChecks(of(lineById(run.lines, "open")), { code, wording }),
      ]);
      return of(lineById(run.lines, "open"));
    }
    const client = new ServeClient({ cliPath, args: env.cliFlags(), env: env.cliEnv(), recorder, label: `${label}/probe-${probeId}` });
    await client.initialize();
    const opened = await client.call("project_open", { path: checkpointPath });
    await client.disconnect();
    await client.waitForExit();
    await recorder.step(probeId, title, corruptionProbeChecks(opened.facadeResult, { code, wording }));
    return opened.facadeResult;
  };

  // 6d-i — one byte flipped inside `project` ⇒ integrity refusal.
  const byteflipPath = path.join(probesDir, "byteflip.openreel.json");
  await fs.writeFile(byteflipPath, raw.replace('"Hello world"', '"Xello world"'), "utf8");
  await openExpectingRefusal(
    "6d-i",
    "byte flip inside project ⇒ integrity refusal (stateSha256 mismatch)",
    byteflipPath,
    { code: "INVALID_PARAMS", wording: WORDINGS.corrupted },
  );

  // 6d-ii — formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording).
  const fmt999Path = path.join(probesDir, "fmt999.openreel.json");
  await fs.writeFile(fmt999Path, JSON.stringify({ ...doc, formatVersion: 999 }, null, 2) + "\n", "utf8");
  await openExpectingRefusal(
    "6d-ii",
    "formatVersion 999 ⇒ UNSUPPORTED (unknown-version wording)",
    fmt999Path,
    { code: "UNSUPPORTED", wording: "formatVersion 999" },
  );

  // 6d-iii — mediaRefs path diverging from the item's originalUrl, hash
  // recomputed exactly per the 10.2 recipe ⇒ structure/binding refusal.
  const diverged = JSON.parse(raw);
  diverged.mediaRefs[0].path = path.join(env.mediaRoot, "input-diverged.mp4");
  diverged.stateSha256 = computeStateSha256({
    formatVersion: diverged.formatVersion,
    revision: diverged.revision,
    project: diverged.project,
    mediaRefs: diverged.mediaRefs,
  });
  const divergedPath = path.join(probesDir, "diverged.openreel.json");
  await fs.writeFile(divergedPath, JSON.stringify(diverged, null, 2) + "\n", "utf8");
  const divergedResult = await openExpectingRefusal(
    "6d-iii",
    "mediaRefs path diverging from originalUrl (hash recomputed) ⇒ binding refusal naming step 5",
    divergedPath,
    { code: "INVALID_PARAMS", wording: WORDINGS.mediaRefsBinding },
  );
  await recorder.step("6d-iii-2", "binding refusal names the offending mediaId", [
    mediaMovedDetailsChecks(divergedResult),
  ]);

  // 6d-iv — referenced media renamed away ⇒ refusal naming the mediaId.
  const pristinePath = path.join(probesDir, "pristine.openreel.json");
  await fs.copyFile(v1Path, pristinePath);
  const awayPath = path.join(env.mediaRoot, "input-away.mp4");
  await fs.rename(env.inputMp4, awayPath);
  let movedResult;
  try {
    movedResult = await openExpectingRefusal(
      "6d-iv",
      "referenced media renamed away ⇒ open refuses, details naming the mediaId",
      pristinePath,
      { code: "INVALID_PARAMS", wording: WORDINGS.mediaMoved },
    );
  } finally {
    await fs.rename(awayPath, env.inputMp4);
  }
  await recorder.step("6d-iv-2", "media-moved refusal names the offending mediaId", [
    mediaMovedDetailsChecks(movedResult),
  ]);

  // 6d-v — checkpoint path through a symlinked directory escaping
  // projectRoots ⇒ INVALID_PARAMS (escape wording).
  const outsideDir = path.join(env.scratchDir, "outside-dir");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.copyFile(v1Path, path.join(outsideDir, "escaped.openreel.json"));
  const linkPath = path.join(env.projectRoot, "escape-link");
  await fs.symlink(outsideDir, linkPath, "dir");
  try {
    await openExpectingRefusal(
      "6d-v",
      "checkpoint path through a symlinked dir escaping projectRoots ⇒ INVALID_PARAMS (escape wording)",
      path.join(linkPath, "escaped.openreel.json"),
      { code: "INVALID_PARAMS", wording: WORDINGS.checkpointEscape },
    );
  } finally {
    await fs.rm(linkPath, { force: true });
  }
}

/** Checkpoint file assertions shared by both paths (step 2). */
async function checkpointFileChecks({ savePath, projectRoot }) {
  const files = await fs.readdir(projectRoot);
  const tmpSiblings = files.filter((name) => name.endsWith(".tmp"));
  return [
    { name: "checkpoint file exists at exactly the saved path", pass: existsSync(savePath), detail: savePath },
    {
      name: "no .tmp siblings left behind (atomic publication)",
      pass: tmpSiblings.length === 0,
      detail: `projectRoot contents=${JSON.stringify(files)}`,
    },
  ];
}

export { checkpointFileChecks };
