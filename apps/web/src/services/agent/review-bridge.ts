import { REVIEW_SCHEMAS, reviewIngestInput, type ReviewIngestItem, type ReviewVerb } from "@reelterminal/agent-facade/review";
import { validateObject } from "@reelterminal/agent-facade/validate";
import { validateWorkbenchContentUpdateOp } from "@reelterminal/agent-facade/workbench";
import { workbenchOpActions, type WorkbenchAgentOp } from "@reelterminal/agent-facade/workbench-op-actions";
import type { WorkbenchIngestParams } from "@reelterminal/agent-facade";
import { buildWorkbenchIngestActions } from "@reelterminal/core/actions/workbench-actions";
import type { ReviewContext, ReviewStep } from "@reelterminal/core/review/types";
import type { WorkbenchProjectState } from "@reelterminal/core/types/workbench";
import { reduceReviewActions } from "@reelterminal/core/review/reducer";
import type { Action } from "@reelterminal/core/types/actions";
import { reviewError, reviewService, type ReviewReadScope } from "../review-workspace/service";
import { prepareReviewFiles, type ReviewSourceFile } from "../review-workspace/files";
import { prepareReviewExport, reviewExportStatus, cancelReviewExport, copyReviewExport } from "../review-workspace/export";
import { inspectReviewPackage, restoreReviewPackage } from "../review-workspace/package";
import { attachReviewMedia, type ReviewAttachRequest } from "../review-workspace/attach";

function reviewOps(ops: readonly WorkbenchAgentOp[], state: WorkbenchProjectState): Action[] {
  let draft = state;
  const actions: Action[] = [];
  for (const op of ops) {
    if (op.op === "workbench.content.update") validateWorkbenchContentUpdateOp(op, "review output");
    const next = workbenchOpActions(op, draft);
    draft = reduceReviewActions(draft, next).state;
    actions.push(...next);
  }
  return actions;
}

function reviewOpsReadScope(ops: readonly WorkbenchAgentOp[]): ReviewReadScope | undefined {
  const itemIds = new Set<string>();
  for (const op of ops) {
    switch (op.op) {
      case "workbench.decide": for (const decision of op.decisions) itemIds.add(decision.itemId); break;
      case "workbench.feedback.save": itemIds.add(op.feedback.itemId); break;
      case "workbench.content.update": itemIds.add(op.itemId); break;
      // These builders inspect handoffs and global publication state.
      case "workbench.handoff.ack":
      case "workbench.rework": return undefined;
    }
  }
  return { itemIds: [...itemIds] };
}

function completedReports(valid: Record<string, unknown>, nodeId: string): ReviewStep[] {
  return ((valid.steps ?? []) as Extract<ReviewStep, { state: "completed" }>[]).map(step => ({ ...step, parameters: step.parameters ?? {}, nodeId, state: "completed", actor: "agent", method: { ...step.method, verification: "declared" } }));
}

export async function handleReviewCommand(verb: ReviewVerb, params: Record<string, unknown>): Promise<unknown> {
  const valid = validateObject<Record<string, unknown>>(params, REVIEW_SCHEMAS[verb], `${verb} params`);
  const target = valid.target as ReviewContext["target"];
  switch (verb) {
    case "review.branches.create": return reviewService.createBranch(valid as unknown as Parameters<typeof reviewService.createBranch>[0]);
    case "review.branches.compare": return reviewService.compareBranch(target);
    case "review.branches.submit": {
      const results = valid.results as Array<{ itemId: string; expectedItemVersion: number; content: ReviewIngestItem["content"] }>;
      // Reuse the existing validated content conversion without ingesting a synthetic batch.
      const normalized = reviewIngestInput({ batchId: valid.requestId as string, name: "Branch results", items: results.map(result => ({
        id: result.itemId, title: "Result", type: result.content.type, content: result.content,
      })) }, Date.now());
      const files = valid.files as ReviewSourceFile[] | undefined;
      return reviewService.submitBranch({ target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
        request: { kind: "branch.submit", results, files: valid.files, stepId: valid.stepId }, results: results.map((result, index) => ({ itemId: result.itemId, expectedItemVersion: result.expectedItemVersion, content: normalized.items[index].content })),
        stepId: valid.stepId as string | undefined, ...(files?.length ? { prepareResources: () => prepareReviewFiles(files, valid.requestId as string, "agent") } : {}) });
    }
    case "review.media.inspect":
    case "review.frames.extract": {
      const plan = await reviewService.freezeExport({ target, expectedNodeRevision: valid.expectedNodeRevision as number, exportId: crypto.randomUUID(),
        mode: "version", scope: "selected", reference: valid.reference as Parameters<typeof reviewService.freezeExport>[0]["reference"] });
      const resourceId = plan.entries[0].resourceId;
      if (!resourceId) throw reviewError("UNSUPPORTED", "Shared media processing requires a file resource");
      const { storage: _storage, ...resource } = (await reviewService.getResources([resourceId]))[0];
      return { target, nodeRevision: plan.nodeRevision, resource };
    }
    case "review.attach": return attachReviewMedia(valid as unknown as ReviewAttachRequest, "agent");
    case "review.package.inspect": return inspectReviewPackage(target, valid.directory as string, "agent");
    case "review.package.restore": return restoreReviewPackage(valid as Parameters<typeof restoreReviewPackage>[0], "agent");
    case "review.steps.list": return reviewService.listSteps(target, valid);
    case "review.steps.start": {
      const { stepId, runId, label, inputs, method, parameters, supersedesStepId, mapping } = valid;
      const step: ReviewStep = { id: stepId as string, nodeId: target.nodeId!, runId: runId as string, label: label as string,
        inputs: inputs as ReviewStep["inputs"], parameters: (parameters ?? {}) as ReviewStep["parameters"], ...(supersedesStepId ? { supersedesStepId: supersedesStepId as string } : {}),
        ...(mapping ? { mapping: mapping as NonNullable<ReviewStep["mapping"]> } : {}), method: { ...method as ReviewStep["method"], verification: "declared" }, actor: "agent", state: "running", startedAt: Date.now(), outputs: [] };
      return reviewService.commit({ target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
        actor: "agent", label: "Start review processing", request: valid, readScope: { itemIds: [] }, build: () => [], steps: [step] });
    }
    case "review.steps.complete":
    case "review.steps.fail": {
      if (valid.ingest && valid.ops) throw reviewError("INVALID_PARAMS", "Processing completion accepts either ingest or ops");
      const files = valid.files as ReviewSourceFile[] | undefined;
      const ingest = valid.ingest ? reviewIngestInput(valid.ingest as Parameters<typeof reviewIngestInput>[0], Date.now()) : undefined;
      return reviewService.commit({ target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
        actor: "agent", label: verb === "review.steps.complete" ? "Complete review processing" : "Record processing failure", request: valid,
        readScope: ingest ? undefined : reviewOpsReadScope((valid.ops ?? []) as WorkbenchAgentOp[]),
        ...(files?.length ? { prepareResources: () => prepareReviewFiles(files, valid.requestId as string, "agent") } : {}),
        build: state => {
          if (ingest) {
            if (ingest.items.some(item => state.items.some(existing => existing.id === item.id))) throw reviewError("CONFLICT", "Output item ID already exists");
            const built = buildWorkbenchIngestActions(state, ingest);
            if (!built.ok) throw reviewError(built.code, built.message);
            return built.actions;
          }
          return valid.ops ? reviewOps(valid.ops as WorkbenchAgentOp[], state) : [];
        },
        buildSteps: (_before, _after, _resources, steps) => {
          const step = steps.find(step => step.id === valid.stepId);
          if (!step || step.state !== "running") throw reviewError("CONFLICT", "Complete or fail an existing running step; terminal steps are immutable");
          const finishedAt = Math.max(Date.now(), step.startedAt);
          return [verb === "review.steps.complete" ? { ...step, state: "completed", finishedAt, outputs: valid.outputs } as ReviewStep :
            { ...step, state: (valid.state ?? "failed") as "failed" | "cancelled", finishedAt, outputs: [], error: valid.error as string }];
        },
      });
    }
    case "review.export.prepare": return prepareReviewExport(valid as unknown as Parameters<typeof prepareReviewExport>[0]);
    case "review.export.status":
    case "review.export.cancel":
    case "review.export.copy": {
      await reviewService.getNodeMetadata(target);
      const exportId = valid.exportId as string;
      if (verb === "review.export.status") return reviewExportStatus(exportId, target.nodeId!);
      if (verb === "review.export.cancel") return cancelReviewExport(exportId, target.nodeId!);
      return copyReviewExport(exportId, target.nodeId!, valid.directory as string, "agent");
    }
    case "review.nodes.list": return reviewService.listNodes(target, valid as { limit?: number; cursor?: string });
    case "review.nodes.create": return reviewService.createNode({ ...valid as unknown as Parameters<typeof reviewService.createNode>[0], actor: "agent" });
    case "review.directory.get": return reviewService.directory.get(target);
    case "review.directory.apply": return reviewService.directory.commit({ ...valid as unknown as Parameters<typeof reviewService.directory.commit>[0], actor: "agent" });
    case "review.directory.history.control": return reviewService.directory.history({ ...valid as unknown as Parameters<typeof reviewService.directory.history>[0], actor: "agent" });
    case "review.get": return valid.itemId
      ? reviewService.getItem(target, valid.itemId as string)
      : reviewService.listItems(target, valid as { limit?: number; cursor?: string });
    case "review.handoff.get": return reviewService.getHandoff(target, valid.handoffId as string);
    case "review.versions.get": return reviewService.getVersion(target, valid.itemId as string, valid.version as number);
    case "review.changes": return reviewService.changes(target, valid as unknown as { afterSequence: number; limit?: number });
    case "review.apply": {
      const ops = valid.ops as WorkbenchAgentOp[];
      const files = valid.files as ReviewSourceFile[] | undefined;
      return reviewService.commit({ target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
        actor: "agent", label: "Agent review changes", request: { ops, files },
        readScope: reviewOpsReadScope(ops),
        ...(files?.length ? { prepareResources: () => prepareReviewFiles(files, valid.requestId as string, "agent") } : {}),
        build: state => reviewOps(ops, state),
      });
    }
    case "review.history.control": return reviewService.history({
      target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
      direction: valid.direction as "undo" | "redo", actor: "agent",
    });
    case "review.ingest": {
      const input = reviewIngestInput(valid as unknown as WorkbenchIngestParams & { items: readonly ReviewIngestItem[] }, Date.now());
      const files = valid.files as ReviewSourceFile[] | undefined;
      return reviewService.commit({ target, expectedNodeRevision: valid.expectedNodeRevision as number, requestId: valid.requestId as string,
        actor: "agent", label: `Ingest ${input.name}`, request: { batchId: valid.batchId, name: valid.name, items: valid.items, files: valid.files, steps: valid.steps },
        steps: completedReports(valid, target.nodeId!),
        ...(files?.length ? { prepareResources: () => prepareReviewFiles(files, valid.requestId as string, "agent") } : {}),
        build: state => {
          // A retained identity is only replayed through its original durable request receipt.
          // Do not silently skip a different input under an already occupied item ID.
          if (input.items.some(item => state.items.some(existing => existing.id === item.id))) throw reviewError("CONFLICT", "Review item ID already exists; retry the original requestId or create a new identity");
          const built = buildWorkbenchIngestActions(state, input);
          if (!built.ok) throw reviewError(built.code, built.message);
          return built.actions;
        },
      });
    }
  }
}
