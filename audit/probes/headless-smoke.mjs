// Headless runnability smoke probe.
//
// Proves (or disproves) that an agent tool-call turn can be driven in pure Node
// against HeadlessHost with NO LLM: builds a minimal Project, loads the real
// registry + headless host through the audit loader harness, and invokes tool
// handlers directly via registry.getTool(name).handler(args, host).
//
// Covered cases:
//   1  get_editor_state                       (readTool)
//   2  get_capabilities                       (readTool)
//   3  rename_project                         (actionTool -> applyAction)
//   4  add_track                              (actionTool -> applyAction)
//   5  create_text_clip                       (overlay create; falls back to
//                                              text/create action on headless)
//   6  remove_text_clip                       (overlayRemoveTool; falls back to
//                                              text/remove action on headless)
//   7  export_video                           (jobTool; no jobRunner injected ->
//                                              expect graceful JOB_FAILED)
//   8  undo via ActionHistory                 (host.applyAction + history.undo()
//                                              + executor inverse replay)
//   9  transaction rollback                   (begin/apply/rollback restores
//                                              project + clears history)
//  10  transaction commit                     (begin/apply/commit persists)
//
// Run from the repo root:
//   node --experimental-transform-types audit/probes/headless-smoke.mjs
//
// Output: per-case PASS/FAIL lines, error codes, plus a JSON summary written to
// audit/probes/out/headless-smoke.json.

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import {
  REPO_ROOT,
  scanClosure,
  stubSourceFor,
  toFileUrl,
} from "./lib/scan.mjs";

const AGENT_SRC = path.join(REPO_ROOT, "packages", "agent", "src");
const REGISTRY = path.join(AGENT_SRC, "registry.ts");
const HEADLESS_HOST = path.join(AGENT_SRC, "headless-host.ts");

function makeProject() {
  // Modeled on packages/core/src/actions/headless.node.test.ts makeProject().
  const clip = {
    id: "c1",
    mediaId: "m1",
    trackId: "t1",
    startTime: 0,
    duration: 5,
    inPoint: 0,
    outPoint: 5,
    effects: [],
    audioEffects: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 },
      rotation: 0,
      opacity: 1,
    },
    volume: 1,
    keyframes: [],
  };
  return {
    id: "p1",
    name: "Smoke",
    createdAt: 0,
    modifiedAt: 0,
    settings: {
      width: 1920,
      height: 1080,
      frameRate: 30,
      sampleRate: 48000,
      channels: 2,
    },
    timeline: {
      duration: 5,
      subtitles: [],
      markers: [],
      tracks: [
        {
          id: "t1",
          type: "video",
          name: "V1",
          clips: [clip],
          transitions: [],
          locked: false,
          hidden: false,
          muted: false,
          solo: false,
        },
      ],
    },
    mediaLibrary: { items: [] },
  };
}

const results = [];
let caseNo = 0;

async function call(label, fn, expect = {}) {
  const n = ++caseNo;
  const rec = { case: n, label, outcome: "FAIL", ok: null, errorCode: null, detail: "" };
  try {
    const result = await fn();
    rec.ok = result?.ok ?? null;
    rec.errorCode =
      result && typeof result === "object" ? (result.error?.code ?? null) : null;
    const errText =
      result && typeof result === "object" && result.error
        ? typeof result.error === "string"
          ? result.error
          : result.error.message ?? JSON.stringify(result.error)
        : "";
    if (!expect.ok) {
      rec.outcome = result?.ok === false ? "PASS" : "FAIL";
      rec.detail = result?.ok === false ? String(errText).slice(0, 140) : "expected failure";
    } else {
      rec.outcome = result?.ok === true ? "PASS" : "FAIL";
      rec.detail =
        result?.ok === true
          ? String(result.summary ?? "").slice(0, 120)
          : `${result?.summary ?? ""} ${errText}`.trim().slice(0, 160);
    }
  } catch (error) {
    rec.ok = "throw";
    rec.errorCode = error.code ?? null;
    rec.detail = String(error?.message ?? error).slice(0, 200);
  }
  results.push(rec);
  console.log(
    `[${rec.outcome}] #${n} ${label}${rec.errorCode ? ` (code=${rec.errorCode})` : ""} :: ${rec.detail}`,
  );
  return rec;
}

async function main() {
  const closure = scanClosure([REGISTRY, HEADLESS_HOST]);
  const stubs = {};
  for (const [pkg, rec] of closure.thirdParty) stubs[pkg] = stubSourceFor(pkg, rec);
  register("./lib/openreel-loader.mjs", {
    parentURL: toFileUrl(path.join(REPO_ROOT, "audit", "probes") + "/"),
    data: { repoRoot: REPO_ROOT, stubs },
  });

  console.log("[loader] files:", closure.files.length, "| stubbed:", [...closure.thirdParty.keys()].join(", "));
  if (closure.unresolved.length) {
    console.log("[loader] unresolved:", closure.unresolved.slice(0, 10).join(" | "));
  }

  await import(toFileUrl(REGISTRY)); // side-effect: registers core action handlers too? (handlers import lives in ActionExecutor)
  const registryMod = await import(toFileUrl(REGISTRY));
  await import(toFileUrl(HEADLESS_HOST)); // ensure class module evaluated under same loader cache

  const { getTool } = registryMod;
  const hostMod = await import(toFileUrl(HEADLESS_HOST));
  const { HeadlessHost } = hostMod;
  const coreHistUrl = toFileUrl(path.join(REPO_ROOT, "packages", "core", "src", "actions", "action-history.ts"));
  const { ActionHistory } = await import(coreHistUrl);

  // --- fresh host with injectable history ------------------------------------
  const project = makeProject();
  const history = new ActionHistory();
  const host = new HeadlessHost(project, { history });
  console.log(
    "[host] methods:", Object.getOwnPropertyNames(HeadlessHost.prototype).filter((m) => m !== "constructor").sort().join(", "),
  );

  // 1-2 read tools
  await call("get_editor_state", () => getTool("get_editor_state").handler({}, host), { ok: true });
  await call("get_capabilities", () => getTool("get_capabilities").handler({}, host), { ok: true });

  // 3-4 actionTool mutations
  await call("rename_project -> 'Smoke Renamed'", () =>
    getTool("rename_project").handler({ name: "Smoke Renamed" }, host), { ok: true });
  const renamedOk = host.getProject().name === "Smoke Renamed";
  console.log(`[state] project.name after rename: "${host.getProject().name}" (${renamedOk ? "ok" : "MISMATCH"})`);

  await call("add_track video", () =>
    getTool("add_track").handler({ trackType: "video" }, host), { ok: true });
  const trackCount = host.getProject().timeline.tracks.length;
  console.log(`[state] track count after add_track: ${trackCount} (expect 2)`);

  // 5a text overlay creation (headless fallback path) — NO explicit id
  // (schema documents none): core text/create handler requires clip.id, expect fail.
  await call("create_text_clip (no clip.id)", () =>
    getTool("create_text_clip").handler(
      { clip: { text: "Hello Headless", startTime: 6, duration: 2 } },
      host,
    ), {}); // expecting graceful failure (documented below)

  // 5b same tool WITH explicit clip.id (workaround)
  let createdClipId = null;
  await call("create_text_clip (explicit clip.id)", async () => {
    const r = await getTool("create_text_clip").handler(
      { clip: { id: "txt-probe-1", text: "Hello Headless", startTime: 6, duration: 2 } },
      host,
    );
    const p = host.getProject();
    const textClips = Array.isArray(p.textClips) ? p.textClips : [];
    const trackWithText = (p.timeline.tracks ?? []).find(
      (t) => t.type === "text" || (t.clips ?? []).some((c) => c.type === "text" || c.id === "txt-probe-1"),
    );
    createdClipId = textClips.some((c) => c.id === "txt-probe-1") ? "txt-probe-1" : null;
    console.log(
      `[state] after create_text_clip: project.textClips=${textClips.length}` +
        ` hasCreated=${createdClipId !== null} timelineTrackHoldingIt=${trackWithText ? trackWithText.id : "none"}`,
    );
    return r;
  }, { ok: true });

  // 6 overlay removal fallback
  if (createdClipId) {
    await call(`remove_text_clip clipId=${createdClipId}`, () =>
      getTool("remove_text_clip").handler({ clipId: createdClipId }, host), { ok: true });
    const remaining = Array.isArray(host.getProject().textClips)
      ? host.getProject().textClips.length
      : "n/a";
    console.log(`[state] project.textClips after remove: ${remaining}`);
  } else {
    results.push({ case: ++caseNo, label: "remove_text_clip", outcome: "SKIP", detail: "no clip id captured" });
    console.log("[SKIP] remove_text_clip (create left no id)");
  }

  // 7 job tool without a jobRunner -> graceful failure expected
  await call("export_video (no jobRunner)", () =>
    getTool("export_video").handler({}, host), { expectFail: true });

  // 7b same job tool WITH a stub runner proves delegation works
  const stubRunnerHost = new HeadlessHost(makeProject(), {
    jobRunner: async (kind, params) => ({ ok: true, data: { kind, paramsEcho: params } }),
  });
  await call("export_video (stub jobRunner)", () =>
    getTool("export_video").handler({ format: "mp4" }, stubRunnerHost), { ok: true });

  // 8 undo via shared ActionHistory
  const beforeUndoJson = JSON.stringify(host.getProject());
  const beforeUndoTracks = host.getProject().timeline.tracks.length;
  const act = (type, params) => ({ type, id: `probe-${Math.random().toString(36).slice(2)}`, timestamp: Date.now(), params });
  // applyAction returns an ActionResult ({success}) not a ToolResult ({ok}), so
  // record this one manually instead of through call().
  const actionRes = await host.applyAction(act("track/add", { trackType: "video" }));
  const grewAfterApply = host.getProject().timeline.tracks.length === beforeUndoTracks + 1;
  results.push({
    case: ++caseNo,
    label: "host.applyAction track/add (for undo)",
    outcome: actionRes.success && grewAfterApply ? "PASS" : "FAIL",
    detail: `ActionResult.success=${actionRes.success} tracks ${beforeUndoTracks}->${host.getProject().timeline.tracks.length}`,
    errorCode: actionRes.error?.code ?? null,
  });
  console.log(`[${results[results.length - 1].outcome}] #${caseNo} applyAction track/add :: ${results[results.length - 1].detail}`);
  console.log(`[undo] canUndo=${history.canUndo()} tracks ${beforeUndoTracks}->${host.getProject().timeline.tracks.length}`);
  const inverse = history.undo();
  console.log(`[undo] inverse action: ${inverse ? inverse.type : "null"}`);
  let undoRestored = false;
  if (inverse) {
    const execRes = await host.applyAction(inverse);
    undoRestored =
      execRes.success &&
      host.getProject().timeline.tracks.length === beforeUndoTracks &&
      JSON.stringify(host.getProject()) === beforeUndoJson;
    console.log(`[undo] inverse replay success=${execRes.success} restored=${undoRestored}`);
  }

  // 9 transaction rollback restores + clears history
  const rollbackStart = structuredClone(host.getProject());
  const rbTracksBefore = host.getProject().timeline.tracks.length;
  const rbHistBefore = history.canUndo();
  const txnA = host.beginTransaction("probe-rollback");
  await host.applyAction(act("project/rename", { name: "Doomed" }));
  await host.applyAction(act("track/add", { trackType: "audio" }));
  const mutated = host.getProject().name === "Doomed" && host.getProject().timeline.tracks.length === rbTracksBefore + 1;
  await host.rollbackTransaction(txnA);
  const restored =
    JSON.stringify(host.getProject()) === JSON.stringify(rollbackStart) &&
    host.getProject().timeline.tracks.length === rbTracksBefore &&
    host.getProject().name === rollbackStart.name;
  const histCleared = history.canUndo() === false;
  results.push({
    case: ++caseNo,
    label: "transaction rollback (mutation applied -> rollback)",
    outcome: mutated && restored && histCleared ? "PASS" : "FAIL",
    detail: `mutated=${mutated} restored=${restored} historyCleared(before canUndo=${rbHistBefore}, after=${history.canUndo()})`,
  });
  console.log(`[${results[results.length - 1].outcome}] #${results[results.length - 1].case} tx-rollback :: ${results[results.length - 1].detail}`);

  // 10 commit keeps changes and drops snapshot
  const txnB = host.beginTransaction("probe-commit");
  await host.applyAction(act("project/rename", { name: "Committed" }));
  host.commitTransaction(txnB, "probe-commit");
  const commitKept = host.getProject().name === "Committed";
  results.push({
    case: ++caseNo,
    label: "transaction commit (change persists)",
    outcome: commitKept ? "PASS" : "FAIL",
    detail: `project.name="${host.getProject().name}"`,
  });
  console.log(`[${commitKept ? "PASS" : "FAIL"}] #${caseNo} tx-commit :: name persisted`);
  try {
    host.commitTransaction({ id: "txn-nonexistent" }, "double-commit-guard");
    console.log("[info] commitTransaction with unknown handle: silent no-op");
  } catch (e) {
    console.log(`[info] commitTransaction unknown handle threw: ${String(e.message).slice(0, 80)}`);
  }

  // summary ------------------------------------------------------------------
  const counts = results.reduce(
    (acc, r) => ((acc[r.outcome] = (acc[r.outcome] ?? 0) + 1), acc),
    {},
  );
  const summary = {
    generated_by: "audit/probes/headless-smoke.mjs",
    total_cases: results.length,
    outcomes: counts,
    undo_restored_byte_identical: undoRestored,
    host_prototype_methods: Object.getOwnPropertyNames(HeadlessHost.prototype)
      .filter((m) => m !== "constructor")
      .sort(),
    cases: results,
    closure: { files: closure.files.length, third_party_stubbed: [...closure.thirdParty.keys()].sort(), unresolved: closure.unresolved },
  };
  fs.mkdirSync(path.join(REPO_ROOT, "audit", "probes", "out"), { recursive: true });
  fs.writeFileSync(
    path.join(REPO_ROOT, "audit", "probes", "out", "headless-smoke.json"),
    JSON.stringify(summary, null, 2) + "\n",
  );
  console.log("\nSUMMARY:", JSON.stringify(counts), "| undo byte-identical restore:", undoRestored);
  console.log("Wrote audit/probes/out/headless-smoke.json");
}

main().catch((error) => {
  console.error("[headless-smoke] FAILED:", error);
  process.exit(1);
});
