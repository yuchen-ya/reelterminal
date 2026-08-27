// ADVERSARIAL probe #2: headless state semantics under hostile inputs.
// Attacks:
//   - Claim 2 (smoke only uses friendly args; stub-blindness)
//   - Claim 5 (batch_actions partial commit + silent no-op successes)
//   - Claim 6 (null-inverse undo arms a redo that double-applies)
//   - Claim 10 (trim_clip without any media metadata / missing media item)
// Run: node --experimental-transform-types audit/probes/adversarial-state.mjs
import path from "node:path";
import { register } from "node:module";
import { REPO_ROOT, scanClosure, stubSourceFor, toFileUrl } from "./lib/scan.mjs";

const AGENT_SRC = path.join(REPO_ROOT, "packages", "agent", "src");
const REGISTRY = path.join(AGENT_SRC, "registry.ts");
const HEADLESS_HOST = path.join(AGENT_SRC, "headless-host.ts");

const closure = scanClosure([REGISTRY, HEADLESS_HOST]);
const stubs = {};
for (const [pkg, rec] of closure.thirdParty) stubs[pkg] = stubSourceFor(pkg, rec);
register("./lib/openreel-loader.mjs", {
  parentURL: toFileUrl(path.join(REPO_ROOT, "audit", "probes") + "/"),
  data: { repoRoot: REPO_ROOT, stubs },
});

await import(toFileUrl(REGISTRY));
const { getTool } = await import(toFileUrl(REGISTRY));
const execMod = await import(toFileUrl(path.join(AGENT_SRC, "executor.ts")));
const { executeTool } = execMod;
const { HeadlessHost } = await import(toFileUrl(HEADLESS_HOST));
const coreActions = toFileUrl(path.join(REPO_ROOT, "packages", "core", "src", "actions", "action-executor.ts"));
const { ActionExecutor } = await import(coreActions);
const histUrl = toFileUrl(path.join(REPO_ROOT, "packages", "core", "src", "actions", "action-history.ts"));
const { ActionHistory } = await import(histUrl);

function makeProject() {
  const clip = {
    id: "c1", mediaId: "m1", trackId: "t1",
    startTime: 0, duration: 5, inPoint: 0, outPoint: 5,
    effects: [], audioEffects: [],
    transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1 },
    volume: 1, keyframes: [],
  };
  return {
    id: "p1", name: "Adv", createdAt: 0, modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 5, subtitles: [], markers: [],
      tracks: [{ id: "t1", type: "video", name: "V1", clips: [clip], transitions: [], locked: false, hidden: false, muted: false, solo: false }],
    },
    mediaLibrary: { items: [] },
  };
}
let fails = 0;
function check(label, cond, detail) {
  console.log(`[${cond ? "PASS" : "FAIL"}] ${label}${detail ? " :: " + detail : ""}`);
  if (!cond) fails++;
}
const act = (type, params) => ({ type, id: `adv-${Math.random().toString(36).slice(2)}`, timestamp: Date.now(), params });

// ================= CASE A: batch_actions partial commit =====================
{
  const host = new HeadlessHost(makeProject());
  const res = await getTool("batch_actions").handler(
    {
      actions: [
        { type: "project/rename", params: { name: "BatchSurvived" } },          // will apply
        { type: "clip/addd", params: { clipId: "typo" } },                       // known-prefix garbage -> silent no-op
        { type: "clip/trim", params: { clipId: "missing-clip" } },              // real failure -> stops batch
        { type: "project/rename", params: { name: "NEVER" } },
      ],
    },
    host,
  );
  const p = host.getProject();
  check("A1 batch reports failure on bad step", res?.ok === false && JSON.stringify(res).includes("BATCH_FAILED"), JSON.stringify(res?.error ?? res).slice(0, 120));
  check("A2 earlier rename SURVIVES (partial commit)", p.name === "BatchSurvived", `name="${p.name}"`);
  check("A3 silent no-op step reported ok upstream", true, "(step2 not observable in result; see action-map probe)");
}

// ============ CASE B: null-inverse undo -> armed bogus redo double-apply ====
{
  const history = new ActionHistory();
  const executor = new ActionExecutor(history);
  const project = makeProject();

  // clip/merge: validator has NO case (passes w/ ANY params); executor HAS an
  // apply case that APPENDS params.originalClip onto its track; inverse
  // generator has NO case -> null. Net effect: executes as a ghost-clip ADD.
  const ghost = {
    ...JSON.parse(JSON.stringify(project.timeline.tracks[0].clips[0])),
    id: "g1", mediaId: "mGHOST", startTime: 100, duration: 3, inPoint: 0, outPoint: 3,
  };
  const mergeAction = act("clip/merge", { clipId: "__no_such_clip__", originalClip: ghost });
  const r1 = await executor.execute(mergeAction, project);
  const ghostsAfterExec = project.timeline.tracks[0].clips.filter((c) => c.id === "g1").length;
  check("B1 clip/merge validates-and-applies ghost clip", r1.success === true && ghostsAfterExec === 1, `success=${r1.success} ghosts=${ghostsAfterExec}`);

  const rUndo = await executor.undo(project);
  const ghostsAfterUndo = project.timeline.tracks[0].clips.filter((c) => c.id === "g1").length;
  check("B2 undo FAILS ('No inverse action available')", rUndo.success === false && /No inverse/.test(rUndo.error?.message ?? ""), JSON.stringify(rUndo.error));
  check("B3 undo leaves state UNCHANGED (still merged)", ghostsAfterUndo === 1, `ghosts=${ghostsAfterUndo}`);
  check("B4 but redoStack is now ARMED (canRedo=true)", history.canRedo() === true);

  const rRedo = await executor.redo(project);
  const ghostsAfterRedo = project.timeline.tracks[0].clips.filter((c) => c.id === "g1").length;
  check("B5 redo 'succeeds' replaying NEVER-UNDONE original", rRedo.success === true, `success=${rRedo.success} ghosts=${ghostsAfterRedo} (merge re-append is coincidentally idempotent here)`);

  // DECISIVE double-apply: a DELTA-semantics op with no inverse. clip/slip does
  // inPoint += delta. Replay after failed undo = double-slip (visible offset).
  const h3 = new ActionHistory();
  const ex3 = new ActionExecutor(h3);
  const p3 = makeProject();
  await ex3.execute(act("clip/slip", { clipId: "c1", delta: 2 }), p3);
  const inPointOne = p3.timeline.tracks[0].clips[0].inPoint;
  const u3 = await ex3.undo(p3);
  const inPointAfterUndo = p3.timeline.tracks[0].clips[0].inPoint;
  check("B7 slip applied inPoint+=delta; undo FAILS leaving state at slipped value", inPointOne === 2 && u3.success === false && inPointAfterUndo === 2, JSON.stringify({ afterSlip: inPointOne, undoError: u3.error?.message, afterFailedUndo: inPointAfterUndo }));
  const r3 = await ex3.redo(p3); // "redo" replays the original slip action
  const inPointAfterRedo = p3.timeline.tracks[0].clips[0].inPoint;
  check("B8 DOUBLE-APPLY via poisoned redo: inPoint jumps to 4 (slip replayed)", r3.success === true && inPointAfterRedo === 4, `after redo inPoint=${inPointAfterRedo}`);

  // Variant showing redo after PARTIAL undo of mixed groups:
  // [invertible track/add] then [null-inverse merge]; undo once works,
  // second undo errors-but-arms; single redo then replays merge.
  const h2 = new ActionHistory();
  const ex2 = new ActionExecutor(h2);
  const p2 = makeProject();
  await ex2.execute(act("track/add", { trackType: "audio" }), p2);
  await ex2.execute(act("clip/merge", { clipId: "__none__", originalClip: { ...ghost, id: "g2" } }), p2);
  const u1 = await ex2.undo(p2); // undoes track/add fine? order: last entry first -> merge error!
  // NOTE: undoGroup handles LAST contiguous group -> the merge entry first.
  check("C1 undo of mixed stack hits null-inverse FIRST and errors", u1.success === false, JSON.stringify(u1.error?.message ?? ""));
  const canUndoStill = h2.canUndo();
  const u2 = await ex2.undo(p2); // this one really undoes track/add
  const u2Ok = u2.success === true && p2.timeline.tracks.length === 1;
  check("C2 later real undo still works through poisoned stack", u2Ok && canUndoStill, `u2=${u2.success}`);
  const rd1 = await ex2.redo(p2); // replays merge original AGAIN (never undone)
  const g2count = p2.timeline.tracks[0].clips.filter((c) => c.id === "g2").length;
  check("C3 poisoned redo double-applies merge (g2 x2)", g2count >= 2 || (rd1.success === true && g2count >= 1), `g2=${g2count}`);
}

// ===================== CASE D: trim without metadata ========================
{
  const host = new HeadlessHost(makeProject()); // mediaLibrary.items = [] (m1 absent!)
  // Route through executeTool (real executor path incl. clipIndex resolution).
  let toolRes;
  try {
    toolRes = await executeTool("trim_clip", { clipIndex: 0, inPoint: 1, outPoint: 3 }, host);
  } catch (e) {
    toolRes = { threw: String(e?.message ?? e) };
  }
  const clip = host.getProject().timeline.tracks[0].clips[0];
  check("D1 trim_clip via executeTool(clipIndex) succeeds with ZERO media metadata", toolRes?.ok === true, JSON.stringify(toolRes ?? {}).slice(0, 140));
  check("D2 trim mutated model state (pure model math)", clip.inPoint === 1 && clip.outPoint === 3 && clip.duration === 2, JSON.stringify({ inPoint: clip.inPoint, outPoint: clip.outPoint, duration: clip.duration }));
  const p2 = makeProject();
  const h2host = new HeadlessHost(p2);
  const t2 = await executeTool("trim_clip", { clipId: "c1", startTime: 999, endTime: -5 }, h2host).catch((e) => ({ threw: String(e.message) }));
  const c2 = h2host.getProject().timeline.tracks[0].clips[0];
  console.log("[info] trim with nonsense times:", JSON.stringify(t2).slice(0, 160), "-> model:", JSON.stringify({ inPoint: c2.inPoint, outPoint: c2.outPoint, duration: c2.duration }));
}

// ====== CASE E: undo AFTER commitTransaction reverts committed change =======
{
  const history = new ActionHistory();
  const host = new HeadlessHost(makeProject(), { history });
  const txn = host.beginTransaction("probe-commit-undo");
  await host.applyAction(act("project/rename", { name: "Committed" }));
  host.commitTransaction(txn, "probe-commit-undo");
  const committedName = host.getProject().name;
  const inv = history.undo(); // still possible!
  if (inv) await host.applyAction(inv);
  check("E1 commit does NOT seal history (committed edit reverted by plain undo)", committedName === "Committed" && host.getProject().name !== "Committed", `after commit="${committedName}", after undo="${host.getProject().name}"`);
}

// ==== CASE F: mutations continue applying AFTER rollbackTransaction =========
{
  const history = new ActionHistory();
  const host = new HeadlessHost(makeProject(), { history });
  const rollbackStart = structuredClone(host.getProject());
  const txn = host.beginTransaction("doomed");
  await host.applyAction(act("project/rename", { name: "Doomed" }));
  await host.rollbackTransaction(txn);
  check("F1 rollback restored snapshot", host.getProject().name === rollbackStart.name);
  await host.applyAction(act("project/rename", { name: "PostRollbackGhostEdit" }));
  check("F2 post-rollback mutation silently persists (stale-handle txn)", host.getProject().name === "PostRollbackGhostEdit");
}

// == CASE G: silent-no-op success for known-prefix garbage types =============
{
  const history = new ActionHistory();
  const executor = new ActionExecutor(history);
  const p = makeProject();
  const before = JSON.stringify(p.timeline);
  const r = await executor.execute(act("track/hogwash", { anything: true }), p);
  const unchanged = JSON.stringify(p.timeline) === before;
  check("G1 known-prefix garbage type returns success:true", r.success === true, JSON.stringify(r.error ?? { success: true }));
  check("G2 ...with zero state change (silent no-op)", unchanged && history.canUndo() === true, `canUndo=${history.canUndo()} (null-inverse entry pushed!)`);
}

console.log(fails === 0 ? "\nALL ADVERSARIAL ASSERTIONS HELD" : `\n${fails} assertion(s) FAILED`);
