/** Check project creation, media import, editing, preview, and export. */
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";

import { CLIP_DURATION_SEC, PROJECT_SETTINGS } from "./env.mjs";
import { runDoctor, doctorChecks } from "./doctor.mjs";
import { runWorkflow } from "./run.mjs";
import { TEXT_REGION, of, okValue, lineById } from "./common.mjs";
import {
  compareDifferentChecks,
  compareSimilarChecks,
  conflictChecks,
  createChecks,
  discoverChecks,
  editChecks,
  exportDoneChecks,
  exportStartedChecks,
  importChecks,
  orphanChecks,
  outsideRootsChecks,
  postRestartReadsChecks,
  previewChecks,
  replayChecks,
  timelineWorldChecks,
  verifyProbeChecks,
} from "./steps.mjs";

const CREATE_KEY = "s2-create";
const IMPORT_KEY = "s2-imp";
const EDIT_KEY = "s2-edit";
const EXPORT_KEY = "s2-exp";
const EXPORT2_KEY = "s2-exp2";

const EDIT_OPS = (mediaId) => [
  { op: "track.add", trackType: "video", trackId: "v1" },
  { op: "clip.add", trackId: "v1", mediaId, startTime: 0, clipId: "c1" },
  { op: "clip.trim", clipId: "c1", outPoint: CLIP_DURATION_SEC },
  { op: "track.add", trackType: "text", trackId: "t1" },
  { op: "text.create", text: "Hello world", trackId: "t1", startTime: 0, duration: CLIP_DURATION_SEC },
];

const CREATE_PARAMS = {
  name: "agent-transport-e2e",
  settings: {
    width: PROJECT_SETTINGS.width,
    height: PROJECT_SETTINGS.height,
    frameRate: PROJECT_SETTINGS.frameRate,
    sampleRate: 48000,
    channels: 2,
  },
};

const VERIFY_EXPECT = {
  container: "mp4",
  videoCodec: "h264",
  width: PROJECT_SETTINGS.width,
  height: PROJECT_SETTINGS.height,
  durationSec: CLIP_DURATION_SEC,
  // Container duration includes AAC encoder priming and padding.
  durationToleranceSec: 0.12,
};

// The default bitrate keeps exports within the runtime's chunk size. Set the
// environment variable to exercise multi-chunk writes.
const EXPORT_SETTINGS = process.env.REELTERMINAL_E2E_FORCE_MULTICHUNK === "1"
  ? { videoBitrateKbps: 8000 }
  : { videoBitrateKbps: 4000 };

/* ------------------------------------------------------------------ */
/* Path (a) — run                                                      */
/* ------------------------------------------------------------------ */

export async function scenario1Run({ env, recorder, cliPath }) {
  const label = "s1-run";

  // Step 1 — doctor.
  const doctor1 = await runDoctor({ cliPath, env: env.cliEnv(), recorder, label });
  await recorder.step("1", "doctor report is usable and complete", doctorChecks(doctor1));

  // Step 2 — discover (the run path's fresh session answers the same verbs).
  const describeWorkflow = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/discover`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "describe", verb: "session.describe", params: {} },
      { id: "caps", verb: "capabilities.get", params: {} },
    ],
  });
  await recorder.step("2", "session.describe: contract, workflow verbs and error codes; capabilities available", [
    ...discoverChecks(
      okValue(lineById(describeWorkflow.lines, "describe"), "describe"),
      okValue(lineById(describeWorkflow.lines, "caps"), "caps"),
    ),
  ]);

  // Steps 3–9 in ONE workflow (all-positive; refs carry the minted ids).
  const main = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/main`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY } },
      { id: "import", verb: "media.import", params: { path: env.inputMp4, expectedRevision: 0, idempotencyKey: IMPORT_KEY } },
      { id: "edit", verb: "edit.apply", params: { ops: EDIT_OPS({ $ref: "import#/mediaId" }), expectedRevision: 1, idempotencyKey: EDIT_KEY } },
      { id: "timeline", verb: "timeline.get", params: {} },
      { id: "preview", verb: "preview.render_frame", params: { timeSec: 2.5 } },
      { id: "export", verb: "export.start", params: { settings: EXPORT_SETTINGS, idempotencyKey: EXPORT_KEY } },
      { id: "wait", await: { jobId: { $ref: "export#/jobId" }, timeoutMs: 1_200_000, pollMs: 2000 } },
      { id: "verify", verb: "verify.artifact", params: { path: { $ref: "wait#/artifact/path" }, expect: VERIFY_EXPECT } },
      {
        id: "similar",
        verb: "verify.artifact",
        params: {
          path: { $ref: "wait#/artifact/path" },
          compare: {
            referencePath: { $ref: "preview#/artifact/path" },
            timeSec: 2.5,
            region: TEXT_REGION,
            mode: "similar",
            maxMeanAbsDiff: 14,
          },
        },
      },
      {
        id: "different",
        verb: "verify.artifact",
        params: {
          path: { $ref: "wait#/artifact/path" },
          compare: {
            referencePath: env.inputMp4,
            timeSec: 2.5,
            referenceTimeSec: 2.5,
            region: TEXT_REGION,
            mode: "different",
            minChangedPixelsRatio: 0.005,
          },
        },
      },
    ],
  });
  if (main.exitCode !== 0) {
    throw new Error(`main workflow exited ${main.exitCode}: ${JSON.stringify(main.lines).slice(0, 2000)}`);
  }

  const createValue = okValue(lineById(main.lines, "create"), "create");
  const importValue = okValue(lineById(main.lines, "import"), "import");
  const editValue = okValue(lineById(main.lines, "edit"), "edit");
  const timelineValue = okValue(lineById(main.lines, "timeline"), "timeline");
  const previewValue = okValue(lineById(main.lines, "preview"), "preview");
  const exportValue = okValue(lineById(main.lines, "export"), "export");
  const waitValue = okValue(lineById(main.lines, "wait"), "wait");
  const verifyValue = okValue(lineById(main.lines, "verify"), "verify");
  const similarValue = okValue(lineById(main.lines, "similar"), "similar");
  const differentValue = okValue(lineById(main.lines, "different"), "different");

  await recorder.step("3", "project_create ⇒ ok, revision 0, replayed false", createChecks(createValue));
  await recorder.step("4", "media_import ⇒ revision 1, mediaId, duration >= 5 s", importChecks(importValue));
  await recorder.step("5", "edit_apply ⇒ revision 2 (0→1→2 arithmetic)", editChecks(editValue));

  // Run each expected-failing validation probe in its own invocation.
  // The file must EXIST for the probe to reach the containment verdict: a
  // nonexistent path is classified "cannot be read" before the roots check.
  const outsidePath = path.join(env.scratchDir, "outside.mp4");
  await fs.writeFile(outsidePath, "probe: outside mediaRoots\n", "utf8");
  const outsideRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/probe-outside-roots`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY } },
      { id: "importOutside", verb: "media.import", params: { path: outsidePath, expectedRevision: 0, idempotencyKey: "s2-outside" } },
    ],
  });
  await recorder.step("6a", "media_import outside roots ⇒ INVALID_PARAMS (escape wording)", [
    eqExit("probe run exit 1 (stop-on-first-failure is the honesty mechanism)", outsideRun.exitCode, 1),
    ...outsideRootsChecks(of(lineById(outsideRun.lines, "importOutside"))),
  ]);

  // Replay + conflict probes: ONE --keep-going run whose nonzero exit is the
  // expected outcome. A fresh `run` session has an empty ledger, so the same
  // keys commit once and then replay/conflict inside this single session.
  const conflictOps = EDIT_OPS({ $ref: "import#/mediaId" }).map((op) =>
    op.op === "text.create" ? { ...op, text: "Different world" } : op,
  );
  const probeRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/probe-replay-conflict`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: [...env.cliFlags(), "--keep-going"],
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY } },
      { id: "import", verb: "media.import", params: { path: env.inputMp4, expectedRevision: 0, idempotencyKey: IMPORT_KEY } },
      { id: "edit", verb: "edit.apply", params: { ops: EDIT_OPS({ $ref: "import#/mediaId" }), expectedRevision: 1, idempotencyKey: EDIT_KEY } },
      { id: "replay", verb: "edit.apply", params: { ops: EDIT_OPS({ $ref: "import#/mediaId" }), expectedRevision: 2, idempotencyKey: EDIT_KEY } },
      { id: "conflict", verb: "edit.apply", params: { ops: conflictOps, expectedRevision: 2, idempotencyKey: EDIT_KEY } },
      { id: "timelineAfter", verb: "timeline.get", params: {} },
    ],
  });
  // Compare within THIS probe session: the ledger is per-process, so the
  // replay must equal the edit committed earlier in the same workflow (a
  // cross-session result would carry different minted ids by design).
  const probeEditValue = okValue(lineById(probeRun.lines, "edit"), "edit");
  await recorder.step("6b", "replay same key+payload ⇒ identical result replayed:true", [
    ...replayChecks(okValue(lineById(probeRun.lines, "replay"), "replay"), probeEditValue),
  ]);
  await recorder.step("6c", "same key different payload ⇒ CONFLICT", [
    eqExit("probe run exit 1 (--keep-going: exit still reflects the first failure)", probeRun.exitCode, 1),
    ...conflictChecks(of(lineById(probeRun.lines, "conflict"))),
  ]);
  await recorder.step(
    "6d",
    "timeline_get deep-check: exactly the constructed world (conflict applied nothing)",
    timelineWorldChecks(okValue(lineById(probeRun.lines, "timelineAfter"), "timelineAfter")),
  );
  // The main session's own timeline view (step 6's world contract).
  await recorder.step("6e", "timeline_get deep-check: main session world", timelineWorldChecks(timelineValue));

  // Step 7 — preview.
  await recorder.step("7", "preview PNG {sizeBytes>0, sha256, sourceRevision:2} inside artifactRoot", [
    ...(await previewChecks(previewValue, env)),
  ]);
  await recorder.sha256Of(previewValue.artifact.path, "s1 preview PNG");
  if (!existsSync(previewValue.artifact.path)) {
    throw new Error("preview artifact missing on disk");
  }

  // Step 8 — export to terminal done.
  await recorder.step("8a", "export_start ⇒ {jobId, state:queued, sourceRevision:2}", exportStartedChecks(exportValue));
  await recorder.step(
    "8b",
    `bounded await step reached terminal done with artifact + route (150 frames implied by ${CLIP_DURATION_SEC}s x ${PROJECT_SETTINGS.frameRate}fps)`,
    exportDoneChecks(waitValue),
  );
  await recorder.sha256Of(waitValue.artifact.path, "s1 exported MP4");

  // Step 9 — verify battery incl. both compares.
  await recorder.step("9a", "verify_artifact full battery ⇒ probe.frameCount == 150, all checks pass", verifyProbeChecks(verifyValue));
  await recorder.step("9b", "compare similar vs step-7 preview PNG (same project/revision)", compareSimilarChecks(similarValue, "preview PNG"));
  await recorder.step("9c", "compare different vs raw input.mp4 (minChangedPixelsRatio > 0 — the load-bearing pixel proof)", compareDifferentChecks(differentValue, "raw input.mp4"));

  // Step 10 — cleanup honesty: a second export_start, then the process exits
  // immediately (run == disconnect; dispose cancels the tracked job).
  const cleanupRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/cleanup-second-export`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: env.cliFlags(),
    steps: [
      { id: "create", verb: "project.create", params: { ...CREATE_PARAMS, idempotencyKey: CREATE_KEY } },
      { id: "import", verb: "media.import", params: { path: env.inputMp4, expectedRevision: 0, idempotencyKey: IMPORT_KEY } },
      { id: "edit", verb: "edit.apply", params: { ops: EDIT_OPS({ $ref: "import#/mediaId" }), expectedRevision: 1, idempotencyKey: EDIT_KEY } },
      { id: "export2", verb: "export.start", params: { settings: EXPORT_SETTINGS, idempotencyKey: EXPORT2_KEY } },
    ],
  });
  const job1Id = exportValue.jobId;
  const job2Id = okValue(lineById(cleanupRun.lines, "export2"), "export2").jobId;

  const readsRun = await runWorkflow({
    cliPath,
    recorder,
    label: `${label}/cleanup-reads`,
    scratchDir: env.scratchDir,
    env: env.cliEnv(),
    flags: [...env.cliFlags(), "--keep-going"],
    steps: [
      { id: "timelineRead", verb: "timeline.get", params: {} },
      { id: "job1Read", verb: "job.status", params: { jobId: job1Id } },
      { id: "job2Read", verb: "job.status", params: { jobId: job2Id } },
    ],
  });
  await recorder.step("10a", "restart ⇒ fresh session has no project and no jobs (NOT_FOUND on reads)", [
    eqExit("reads run exit 1 (the NOT_FOUNDs are the expected outcome)", readsRun.exitCode, 1),
    ...postRestartReadsChecks({
      timelineResult: of(lineById(readsRun.lines, "timelineRead")),
      job1Result: of(lineById(readsRun.lines, "job1Read")),
      job2Result: of(lineById(readsRun.lines, "job2Read")),
    }),
  ]);

  const doctor2 = await runDoctor({ cliPath, env: env.cliEnv(), recorder, label: `${label}/doctor-after` });
  await recorder.step("10b", "doctor lists the orphan; nothing auto-deleted", [
    ...orphanChecks({
      report: doctor2.report,
      job2Id,
      artifactPath: waitValue.artifact.path,
      artifactRootReal: env.artifactRoot,
    }),
  ]);
}

function eqExit(name, actual, expected) {
  return {
    name,
    pass: actual === expected,
    detail: `exitCode=${actual} expected=${expected}`,
  };
}

function truthyExit(name, pass, detail) {
  return { name, pass, detail };
}

// Re-export for scenario 2's shared probes.
export { eqExit, truthyExit, CREATE_PARAMS, VERIFY_EXPECT, EDIT_OPS, CREATE_KEY, IMPORT_KEY, EDIT_KEY, EXPORT_SETTINGS };
