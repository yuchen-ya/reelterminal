import type { ReviewStep } from "@reelterminal/core/review/types";
import type { WorkbenchProjectState } from "@reelterminal/core/types/workbench";

/** Only actual saved content changes produce a step; selection, notes and decisions do not. */
export function manualReviewSteps(nodeId: string, before: WorkbenchProjectState, after: WorkbenchProjectState): ReviewStep[] {
  const steps: ReviewStep[] = [];
  for (const item of after.items) {
    const previous = before.items.find(candidate => candidate.id === item.id);
    if (!previous || previous.version === item.version) continue;
    const revision = item.revisions.find(entry => entry.producedVersion === item.version);
    if (!revision || revision.kind === "agent-rework") continue;
    const name = revision.kind === "image-repair" ? "Canvas 2D pixel repair" : revision.kind === "text" ? "ReelTerminal text editor" : "ReelTerminal cell patch";
    let inputVersion = previous.version;
    if (revision.kind === "image-repair" && revision.base) {
      const base = revision.base;
      if (base.kind === "source") inputVersion = 1;
      else {
        const retained = previous.revisions.find(entry => entry.id === base.revisionId);
        if (retained) inputVersion = retained.producedVersion;
      }
    }
    const finishedAt = Date.now();
    steps.push({ id: crypto.randomUUID(), nodeId, runId: crypto.randomUUID(), label: name, actor: "user", state: "completed",
      startedAt: revision.createdAt, finishedAt: Math.max(finishedAt, revision.createdAt),
      method: { kind: "algorithm", name, verification: "measured" }, parameters: { revisionKind: revision.kind },
      ...(revision.kind === "image-repair" ? { mapping: { kind: "image-bounds" as const, inputIndex: 0, outputIndex: 0 } } : {}),
      inputs: [{ nodeId, itemId: item.id, version: inputVersion, role: "working-source" }],
      outputs: [{ nodeId, itemId: item.id, version: item.version, role: "result" }],
    });
  }
  return steps;
}
