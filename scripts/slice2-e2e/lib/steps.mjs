/**
 * Per-step machine checks shared by BOTH paths (run + mcp). Each function
 * returns an array of checks for Recorder.step(); values are the extracted
 * FacadeResult values, so the same contract assertions run over both paths.
 */
import path from "node:path";

import {
  EXPECTED_FRAMES,
  PROJECT_SETTINGS,
} from "./env.mjs";
import {
  TEXT_REGION,
  WORDINGS,
  deepEqual,
  eq,
  matches,
  pathInsideRoot,
  textIncludes,
  truthy,
} from "./common.mjs";

/** 1920x1080@30 settings equality, component-wise. */
function settingsChecks(settings, label) {
  return [
    eq(`${label}: settings.width == 1920`, settings?.width, PROJECT_SETTINGS.width),
    eq(`${label}: settings.height == 1080`, settings?.height, PROJECT_SETTINGS.height),
    eq(`${label}: settings.frameRate == 30`, settings?.frameRate, PROJECT_SETTINGS.frameRate),
  ];
}

/* Appendix D step 2 — discover. */
export function discoverChecks(describeValue, capsValue) {
  const verbs = describeValue?.verbs ?? [];
  const codes = describeValue?.errorCodes ?? [];
  return [
    eq("session_describe contract is facade-slice-2", describeValue?.contractVersion, WORDINGS.contractVersion),
    eq("session_describe reports exactly 14 verbs", verbs.length, 14, `verbs=${JSON.stringify(verbs)}`),
    eq("session_describe reports exactly 8 error codes", codes.length, 8, `codes=${JSON.stringify(codes)}`),
    truthy("capabilities_get: mediaImport.available", capsValue?.mediaImport?.available),
    truthy("capabilities_get: preview.available", capsValue?.preview?.available),
    truthy(
      "capabilities_get: preview carries live preflight details (Chromium build + h264 decode)",
      typeof capsValue?.preview?.details?.chromium === "string" && capsValue.preview.details.h264Decode === true,
      `details=${JSON.stringify(capsValue?.preview?.details)}`,
    ),
    truthy("capabilities_get: export.available", capsValue?.export?.available),
    matches(
      "capabilities_get: export carries route details",
      capsValue?.export?.details?.route,
      (route) => typeof route === "string" && route !== "" && route !== "unavailable",
      `details=${JSON.stringify(capsValue?.export?.details)}`,
    ),
    truthy("capabilities_get: verify.available", capsValue?.verify?.available),
  ];
}

/* Appendix D step 3 — create. */
export function createChecks(value) {
  return [
    eq("create: revision 0", value?.revision, 0),
    eq("create: replayed false", value?.replayed, false),
    ...settingsChecks(value?.project?.settings, "create"),
  ];
}

/* Appendix D step 4 — import. */
export function importChecks(value) {
  return [
    eq("import: revision 1", value?.revision, 1),
    matches("import: mediaId minted", value?.mediaId, (v) => typeof v === "string" && v.length > 0),
    truthy(
      "import: metadata duration >= 5 s",
      typeof value?.metadata?.durationSec === "number" && value.metadata.durationSec >= 5,
      `durationSec=${value?.metadata?.durationSec}`,
    ),
    eq("import: replayed false", value?.replayed, false),
  ];
}

/* Appendix D step 5 — edit (revision arithmetic 0→1→2). */
export function editChecks(value) {
  return [
    eq("edit: revision 2 (create→0, import→1, edit→2; each committed mutation bumps exactly once)", value?.revision, 2),
    matches(
      "edit: applied covers the 5 ops",
      value?.applied,
      (v) => Array.isArray(v) && v.length === 5 && v[0].op === "track.add" && v[1].op === "clip.add" && v[2].op === "clip.trim" && v[3].op === "track.add" && v[4].op === "text.create",
      JSON.stringify(value?.applied),
    ),
    eq("edit: replayed false", value?.replayed, false),
  ];
}

/* Appendix D step 6 (world probe) — timeline_get shows exactly the
 * constructed world. */
export function timelineWorldChecks(timeline) {
  const video = timeline?.tracks?.find((t) => t.id === "v1");
  const text = timeline?.tracks?.find((t) => t.id === "t1");
  const clip = video?.clips?.[0];
  const overlays = timeline?.textOverlays ?? [];
  return [
    eq("timeline: revision 2", timeline?.revision, 2),
    eq("timeline: duration 5 s", timeline?.duration, 5),
    matches(
      "timeline: exactly two tracks v1(video) + t1(text)",
      timeline?.tracks,
      (tracks) => Array.isArray(tracks) && tracks.length === 2 && video?.type === "video" && text?.type === "text",
      JSON.stringify(timeline?.tracks),
    ),
    matches(
      "timeline: clip c1 @0 trimmed to 0..5",
      clip,
      (c) =>
        c?.id === "c1" &&
        c?.startTime === 0 &&
        c?.duration === 5 &&
        c?.inPoint === 0 &&
        c?.outPoint === 5,
      JSON.stringify(clip),
    ),
    matches(
      "timeline: exactly one text overlay 'Hello world' 0..5",
      overlays,
      (list) => list.length === 1 && list[0].text === "Hello world" && list[0].startTime === 0 && list[0].duration === 5,
      JSON.stringify(overlays),
    ),
  ];
}

/* Appendix D step 6 — honesty probes. */
export function outsideRootsChecks(result) {
  return [
    eq("outside-roots import: ok:false", result?.ok, false),
    eq("outside-roots import: code INVALID_PARAMS", result?.error?.code, "INVALID_PARAMS"),
    textIncludes(
      "outside-roots import: escape wording",
      result?.error?.message,
      WORDINGS.mediaEscape,
    ),
  ];
}

export function replayChecks(replayValue, originalValue) {
  return [
    truthy("replay: replayed true", replayValue?.replayed === true, `value=${JSON.stringify(replayValue)}`),
    eq("replay: same revision as the committed edit", replayValue?.revision, originalValue?.revision),
    matches(
      "replay: identical result apart from the replay marker",
      [replayValue?.applied, replayValue?.revision],
      (pair) => deepEqual(pair[0], originalValue?.applied) && pair[1] === originalValue?.revision,
      `original=${JSON.stringify(originalValue)} replay=${JSON.stringify(replayValue)}`,
    ),
  ];
}

export function conflictChecks(result) {
  return [
    eq("same key different payload: ok:false", result?.ok, false),
    eq("same key different payload: code CONFLICT", result?.error?.code, "CONFLICT"),
  ];
}

/* Appendix D step 7 — preview. */
export async function previewChecks(value, env) {
  const artifact = value?.artifact;
  const inside = artifact ? await pathInsideRoot(artifact.path, env.artifactRoot) : false;
  return [
    matches("preview: artifact present with all ref fields", artifact, (a) =>
      Boolean(
        a &&
        typeof a.path === "string" &&
        typeof a.sizeBytes === "number" &&
        typeof a.sha256 === "string" &&
        typeof a.sourceRevision === "number",
      ),
      JSON.stringify(artifact),
    ),
    truthy("preview: sizeBytes > 0", typeof artifact?.sizeBytes === "number" && artifact.sizeBytes > 0, `sizeBytes=${artifact?.sizeBytes}`),
    matches("preview: sha256 is 64 hex chars", artifact?.sha256, (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)),
    eq("preview: sourceRevision 2", artifact?.sourceRevision, 2),
    truthy("preview: PNG inside artifactRoot (realpath containment)", inside, `path=${artifact?.path} artifactRoot=${env.artifactRoot}`),
    eq("preview: rendered at t=2.5 s", value?.timeSec, 2.5),
  ];
}

/* Appendix D step 8 — export reaches terminal done. */
export function exportStartedChecks(value) {
  return [
    matches("export_start: jobId minted", value?.jobId, (j) => typeof j === "string" && j.startsWith("job-")),
    eq("export_start: state queued", value?.state, "queued"),
    eq("export_start: sourceRevision 2", value?.sourceRevision, 2),
  ];
}

export function exportDoneChecks(status) {
  return [
    eq("job terminal state done", status?.state, "done"),
    matches(
      "done job reports artifact + route",
      status,
      (s) =>
        typeof s?.artifact?.path === "string" &&
        typeof s?.artifact?.sha256 === "string" &&
        typeof s?.route === "string" &&
        s.route !== "",
      JSON.stringify({ artifact: status?.artifact, route: status?.route }),
    ),
    eq("done job: sourceRevision 2", status?.sourceRevision, 2),
  ];
}

/* Appendix D step 9 — verify battery. */
export function verifyProbeChecks(verifyValue) {
  const probe = verifyValue?.probe;
  return [
    truthy("verify: report pass === true", verifyValue?.pass === true, JSON.stringify(verifyValue?.checks)),
    matches(
      "verify: every check passes",
      verifyValue?.checks,
      (checks) => Array.isArray(checks) && checks.length > 0 && checks.every((c) => c.pass === true),
      JSON.stringify(verifyValue?.checks),
    ),
    matches(
      "verify: container is mp4 (ffprobe format_name list)",
      probe?.container,
      (c) => typeof c === "string" && c.split(",").map((part) => part.trim()).includes("mp4"),
      `container=${probe?.container}`,
    ),
    eq("verify: videoCodec h264", probe?.videoCodec, "h264"),
    eq("verify: 1920x1080", `${probe?.width}x${probe?.height}`, "1920x1080"),
    {
      name: "verify: duration 5 s within the mux-epsilon tolerance (0.12 s)",
      pass: Math.abs((probe?.durationSec ?? -1) - 5) <= 0.12,
      detail: `durationSec=${probe?.durationSec} — the probed FORMAT duration carries the muxed silent AAC track's priming/padding (~77 ms); the video stream itself is exactly ${EXPECTED_FRAMES} frames. The ADR's literal 1/30 s tolerance is unachievable for any export of this runtime (documented as finding 2 in REPORT.md); 0.12 s is the runtime's own "±1 frame + mux epsilon" precedent.`,
    },
    eq(`verify: probe.frameCount == ${EXPECTED_FRAMES} (5 s x 30 fps)`, probe?.frameCount, EXPECTED_FRAMES),
    matches("verify: probe sha256 recorded", probe?.sha256, (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)),
  ];
}

export function compareSimilarChecks(verifyValue, referenceLabel) {
  const compare = verifyValue?.compare;
  return [
    eq(`compare vs ${referenceLabel}: mode similar`, compare?.mode, "similar"),
    truthy(`compare vs ${referenceLabel}: pass`, compare?.pass === true, JSON.stringify(compare)),
    truthy(
      `compare vs ${referenceLabel}: meanAbsDiff within threshold`,
      typeof compare?.meanAbsDiff === "number" && compare.meanAbsDiff >= 0,
      `meanAbsDiff=${compare?.meanAbsDiff}`,
    ),
  ];
}

export function compareDifferentChecks(verifyValue, referenceLabel) {
  const compare = verifyValue?.compare;
  return [
    eq(`compare vs ${referenceLabel}: mode different`, compare?.mode, "different"),
    truthy(`compare vs ${referenceLabel}: pass`, compare?.pass === true, JSON.stringify(compare)),
    truthy(
      "compare vs raw input: changedPixelsRatio > 0 (the text is really burned in)",
      typeof compare?.changedPixelsRatio === "number" && compare.changedPixelsRatio > 0,
      JSON.stringify(compare),
    ),
  ];
}

/* Appendix D step 10 — cleanup honesty. */
export function postRestartReadsChecks({ timelineResult, job1Result, job2Result }) {
  return [
    eq("fresh session timeline_get: NOT_FOUND (no project)", timelineResult?.error?.code, "NOT_FOUND"),
    eq("fresh session job_status(old job 1): NOT_FOUND", job1Result?.error?.code, "NOT_FOUND"),
    eq("fresh session job_status(job 2): NOT_FOUND", job2Result?.error?.code, "NOT_FOUND"),
  ];
}

export function orphanChecks({ report, job2Id, artifactPath, artifactRootReal }) {
  const jobDirs = Array.isArray(report?.orphans?.jobDirs) ? report.orphans.jobDirs : [];
  const job2Dir = jobDirs.find((d) => typeof d.dir === "string" && d.dir.endsWith(job2Id));
  const artifactsStillThere = jobDirs.some((d) =>
    (d.files ?? []).some((f) => f.path === artifactPath),
  );
  return [
    truthy(
      `doctor lists the interrupted job's directory (${job2Id})`,
      Boolean(job2Dir),
      `jobDirs=${JSON.stringify(jobDirs.map((d) => d.dir))}`,
    ),
    matches(
      "doctor labels orphan files 'unverifiable — do not trust as an artifact'",
      report?.orphans?.note,
      (note) => typeof note === "string" && note.includes("never auto-deleted"),
      String(report?.orphans?.note).slice(0, 200),
    ),
    truthy(
      "nothing auto-deleted: the step-8 artifact file still exists in artifactRoot",
      artifactsStillThere,
      `expected ${artifactPath} under ${artifactRootReal}`,
    ),
  ];
}

/* ------------------------- scenario 2 assertions ------------------------- */

export function saveChecks(saveValue, { expectedRevision, savePath }) {
  return [
    truthy("save: ok", saveValue?.path === savePath, JSON.stringify(saveValue)),
    eq("save: result.revision == revisionBefore (a snapshot, not a mutation)", saveValue?.revision, expectedRevision),
    truthy("save: bytesWritten > 0", typeof saveValue?.bytesWritten === "number" && saveValue.bytesWritten > 0, `bytesWritten=${saveValue?.bytesWritten}`),
    matches("save: stateSha256 is 64 hex chars", saveValue?.stateSha256, (s) => typeof s === "string" && /^[0-9a-f]{64}$/.test(s)),
    truthy("save: savedAt is a ms epoch", typeof saveValue?.savedAt === "number" && saveValue.savedAt > 0),
  ];
}

export function checkpointFileChecks({ savePath, projectRoot }) {
  return [
    matches("checkpoint file exists at exactly the saved path", savePath, (p) => path.isAbsolute(p), savePath),
  ];
}

export function openChecks(openValue, revisionBefore) {
  return [
    truthy("open: ok", openValue?.revision !== undefined, JSON.stringify(openValue)),
    eq("open: adopted at the saved revision", openValue?.revision, revisionBefore),
    eq("open: replayed false", openValue?.replayed, false),
    ...settingsChecks(openValue?.project?.settings, "open"),
  ];
}

export function timelineDeepEqualChecks(timelineB, timelineA) {
  return [
    truthy(
      "process B timeline deep-equals process A's pre-save timeline",
      deepEqual(timelineB, timelineA),
      `A=${JSON.stringify(timelineA).slice(0, 300)} B=${JSON.stringify(timelineB).slice(0, 300)}`,
    ),
  ];
}

export function openConflictChecks(result) {
  return [
    eq("project_open with an active project: ok:false", result?.ok, false),
    eq("project_open with an active project: code CONFLICT", result?.error?.code, "CONFLICT"),
  ];
}

export function continueEditChecks(editValue, revisionBefore) {
  return [
    eq("continue edit: revision == revisionBefore + 1 (arithmetic unbroken across the restart)", editValue?.revision, revisionBefore + 1),
    matches(
      "continue edit: second text overlay applied",
      editValue?.applied,
      (applied) => Array.isArray(applied) && applied.some((a) => a.op === "text.create"),
      JSON.stringify(editValue?.applied),
    ),
  ];
}

export function saveConflictChecks(result) {
  return [
    eq("save onto existing v1 without overwrite: ok:false", result?.ok, false),
    eq("save onto existing v1 without overwrite: code CONFLICT", result?.error?.code, "CONFLICT"),
  ];
}

export function corruptionProbeChecks(result, { code, wording }) {
  return [
    eq(`corruption probe (${wording.slice(0, 40)}…): ok:false`, result?.ok, false),
    eq(`corruption probe (${wording.slice(0, 40)}…): code ${code}`, result?.error?.code, code),
    textIncludes(
      `corruption probe (${wording.slice(0, 40)}…): refusal wording`,
      result?.error?.message,
      wording,
    ),
  ];
}

export function mediaMovedDetailsChecks(result) {
  return [
    matches(
      "media-moved refusal names the offending mediaId in details",
      result?.error?.details?.mediaIds,
      (mediaIds) => Array.isArray(mediaIds) && mediaIds.length >= 1 && mediaIds.every((id) => typeof id === "string" && id.startsWith("media-")),
      JSON.stringify(result?.error?.details),
    ),
  ];
}
