import type { Scene, Subject } from "../effect/scene";
import type { FilterDoc } from "../filter/types";
import { getBehavior } from "../effect/behaviors/registry";

export interface PublishInput {
  kind: "effect" | "filter";
  name: string;
  doc: Scene | FilterDoc;
}

export type ValidateResult = { ok: true } | { ok: false; errors: string[] };

export function validatePublishable(input: PublishInput): ValidateResult {
  const errors: string[] = [];
  if (input.name.trim().length === 0) errors.push("Project must have a name.");

  if (input.kind === "effect") {
    const scene = input.doc as Scene;
    // Mirror sceneToGraph (effect/compile.ts) semantics: invisible subjects
    // are skipped entirely, invisible behaviors contribute nothing, and
    // duplicate subject kinds are rejected — otherwise a scene that compiles
    // to a no-op graph would pass this gate.
    const seenKinds = new Set<Subject["kind"]>();
    const visibleSubjects = scene.subjects.filter((s) => {
      if (!s.visible) return false;
      if (seenKinds.has(s.kind)) {
        errors.push(`Duplicate subject kind: ${s.kind}.`);
        return false;
      }
      seenKinds.add(s.kind);
      return true;
    });
    const totalBehaviors = visibleSubjects.reduce(
      (sum, s) => sum + s.behaviors.filter((b) => b.visible).length,
      0,
    );
    if (totalBehaviors === 0) errors.push("Effect must have at least one behavior.");
    for (const subject of visibleSubjects) {
      for (const b of subject.behaviors) {
        if (!b.visible) continue;
        const def = getBehavior(b.kind === "preset" ? b.presetId : `atomic.${b.atomicKind}`);
        if (!def) {
          errors.push(`Unknown behavior in ${subject.name}.`);
          continue;
        }
        const parsed = def.paramSchema.safeParse(b.params);
        if (!parsed.success) errors.push(`Behavior ${b.name} has invalid params.`);
        if (!def.acceptsSubjects.includes(subject.kind)) {
          errors.push(`Behavior ${b.name} cannot be applied to ${subject.kind}.`);
        }
      }
    }
  } else {
    const doc = input.doc as FilterDoc;
    if (doc.adjustments.length === 0) errors.push("Filter must have at least one adjustment.");
    for (const a of doc.adjustments) {
      const def = getBehavior(a.kind === "preset" ? a.presetId : `atomic.${a.atomicKind}`);
      if (!def) {
        errors.push(`Unknown adjustment: ${a.name}.`);
        continue;
      }
      if (!def.acceptsSubjects.includes("full_frame")) {
        errors.push(`Adjustment ${a.name} is not valid in a Filter (no full_frame support).`);
      }
      const parsed = def.paramSchema.safeParse(a.params);
      if (!parsed.success) errors.push(`Adjustment ${a.name} has invalid params.`);
    }
  }

  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
