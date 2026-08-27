// Mechanical action-map probe.
//
// Loads the core action system for real (executor module side-effect imports
// ./handlers, which registers all registry handlers), then for every action
// type found in ANY dispatch layer records:
//   - registry handler? invert/validate presence?
//   - executor switch case? validator switch case? inverse-generator case?
//   - live probe: ActionValidator.validate(dummy) and invert(dummy) outcomes
//
// Outputs:
//   audit/action-map.jsonl                     one JSON object per action type
//   audit/probes/out/action-map-summary.json   counts + coverage evidence
//
// Run from the repo root:
//   node --experimental-transform-types audit/probes/dump-action-map.mjs

import fs from "node:fs";
import path from "node:path";
import { register } from "node:module";
import {
  REPO_ROOT,
  scanClosure,
  stubSourceFor,
  stripComments,
  toFileUrl,
} from "./lib/scan.mjs";

const CORE_ACTIONS = path.join(REPO_ROOT, "packages", "core", "src", "actions");
const EXECUTOR = path.join(CORE_ACTIONS, "action-executor.ts");
const VALIDATOR = path.join(CORE_ACTIONS, "action-validator.ts");
const INVERSE = path.join(CORE_ACTIONS, "inverse-action-generator.ts");
const REGISTRY_MOD = path.join(CORE_ACTIONS, "registry.ts");
const HISTORY = path.join(CORE_ACTIONS, "action-history.ts");
const OUT_DIR = path.join(REPO_ROOT, "audit", "probes", "out");
const ACTION_MAP = path.join(REPO_ROOT, "audit", "action-map.jsonl");

function caseLabels(file) {
  const src = stripComments(fs.readFileSync(file, "utf8"));
  const labels = new Set();
  for (const m of src.matchAll(/\bcase\s+"([^"]+)"\s*:/g)) labels.add(m[1]);
  return labels;
}

function makeProject() {
  const clip = {
    id: "c1", mediaId: "m1", trackId: "t1",
    startTime: 0, duration: 5, inPoint: 0, outPoint: 5,
    effects: [], audioEffects: [],
    transform: {
      position: { x: 0, y: 0 }, scale: { x: 1, y: 1 },
      anchor: { x: 0.5, y: 0.5 }, rotation: 0, opacity: 1,
    },
    volume: 1, keyframes: [],
  };
  return {
    id: "p1", name: "probe", createdAt: 0, modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    timeline: {
      duration: 5, subtitles: [], markers: [],
      tracks: [{
        id: "t1", type: "video", name: "V1", clips: [clip],
        transitions: [], locked: false, hidden: false, muted: false, solo: false,
      }],
    },
    mediaLibrary: { items: [{ id: "m1", name: "probe.mp4", type: "video", duration: 5, url: "blob:probe" }] },
  };
}

async function main() {
  const closure = scanClosure([EXECUTOR]);
  const stubs = {};
  for (const [pkg, rec] of closure.thirdParty) stubs[pkg] = stubSourceFor(pkg, rec);
  register("./lib/openreel-loader.mjs", {
    parentURL: toFileUrl(path.join(REPO_ROOT, "audit", "probes") + "/"),
    data: { repoRoot: REPO_ROOT, stubs },
  });

  await import(toFileUrl(EXECUTOR)); // side-effect: registers ./handlers
  const registryMod = await import(toFileUrl(REGISTRY_MOD));
  const { ActionValidator } = await import(toFileUrl(VALIDATOR));
  const { InverseActionGenerator } = await import(toFileUrl(INVERSE));
  const { ActionHistory } = await import(toFileUrl(HISTORY));

  const registryTypes = registryMod.listRegisteredActionTypes().sort();
  const executorCases = caseLabels(EXECUTOR);
  const validatorCases = caseLabels(VALIDATOR);
  const inverseCases = caseLabels(INVERSE);

  const allTypes = [...new Set([
    ...registryTypes, ...executorCases, ...validatorCases, ...inverseCases,
  ])].sort();

  const validator = new ActionValidator();
  const inverseGen = new InverseActionGenerator();
  const history = new ActionHistory();

  const lines = [];
  let nullInverts = 0, throwInverts = 0, actionInverts = 0;
  for (const type of allTypes) {
    const handler = registryMod.getActionHandler(type);
    const dummy = { type, id: "probe-1", timestamp: 0, params: {} };

    let validateProbe;
    try {
      const v = validator.validate(dummy, makeProject());
      validateProbe = {
        valid: v.valid,
        errors: (v.errors ?? []).slice(0, 3).map((e) => String(e?.message ?? e)),
      };
    } catch (err) {
      validateProbe = { threw: String(err?.message ?? err).slice(0, 160) };
    }

    let invertProbe;
    try {
      const inv = handler
        ? handler.invert(dummy, makeProject())
        : inverseGen.generate(dummy, makeProject());
      if (inv && typeof inv === "object" && "type" in inv) {
        invertProbe = { result: "action", inverse_type: inv.type };
        actionInverts++;
      } else if (inv === null) {
        invertProbe = { result: "null" };
        nullInverts++;
      } else {
        invertProbe = { result: typeof inv };
      }
    } catch (err) {
      invertProbe = { result: "throw", error: String(err?.message ?? err).slice(0, 160) };
      throwInverts++;
    }

    lines.push(JSON.stringify({
      action_type: type,
      dispatch: handler ? (executorCases.has(type) ? "registry+executor-switch" : "registry")
        : executorCases.has(type) ? "executor-switch" : "none",
      registry_handler: Boolean(handler),
      handler_has_validate: handler ? typeof handler.validate === "function" : null,
      handler_has_invert: handler ? typeof handler.invert === "function" : null,
      executor_switch_case: executorCases.has(type),
      validator_switch_case: validatorCases.has(type),
      inverse_generator_case: inverseCases.has(type),
      validate_probe: validateProbe,
      invert_probe: invertProbe,
      evidence: ["runtime:registry+validator+inverse probes", "static:case-labels"],
    }));
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(ACTION_MAP, lines.join("\n") + "\n");

  // sanity: history accepts a push/undo cycle
  let historyProbe = "untested";
  try {
    const proj = makeProject();
    const action = { type: "project.rename", id: "h1", timestamp: 0, params: { name: "x" } };
    history.push(action, null);
    historyProbe = history.canUndo() ? "push+canUndo ok" : "push failed";
    history.clear();
  } catch (err) { historyProbe = `throw: ${String(err?.message ?? err).slice(0, 80)}`; }

  const summary = {
    generated_by: "audit/probes/dump-action-map.mjs",
    total_action_types: allTypes.length,
    registry_registered: registryTypes.length,
    executor_switch_cases: executorCases.size,
    validator_switch_cases: validatorCases.size,
    inverse_generator_cases: inverseCases.size,
    invert_probe: { action: actionInverts, null: nullInverts, throw: throwInverts },
    history_probe: historyProbe,
    closure: {
      files_in_closure: closure.files.length,
      third_party_stubbed: [...closure.thirdParty.keys()].sort(),
      unresolved: closure.unresolved,
    },
  };
  fs.writeFileSync(path.join(OUT_DIR, "action-map-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  console.log(JSON.stringify({ ok: true, actionTypes: allTypes.length, registry: registryTypes.length, invertNull: nullInverts, invertThrow: throwInverts }, null, 2));
}

main().catch((err) => {
  console.error("[dump-action-map] FAILED:", err);
  process.exit(1);
});
