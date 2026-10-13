import { getPerfSink } from "./sink";
import { classifyPerfError, errorKindToOutcome } from "./types";
import type { Outcome, PerfContext, PerfDims, PerfSink, PerfSpan } from "./types";

/** A local operation retains its original sink across async boundaries. */
export interface PerfOperation {
  readonly sink: PerfSink;
  readonly context: PerfContext;
  readonly span: PerfSpan;
}

let operationSequence = 0;

export function beginPerfOperation(
  phase: string,
  parent?: PerfOperation,
  context?: Partial<PerfContext>,
): PerfOperation | undefined {
  const sink = getPerfSink();
  if (!sink.enabled) return undefined;
  const correlatedParent = parent?.sink === sink ? parent : undefined;
  const ctx: PerfContext = {
    runId: sink.runId ?? "local",
    operationId: `${phase}-${++operationSequence}`,
    ...correlatedParent?.context,
    ...context,
    ...(correlatedParent ? { parentSpanId: correlatedParent.span.id } : {}),
  };
  return { sink, context: ctx, span: sink.begin(phase, ctx) };
}

export function endPerfOperation(
  operation: PerfOperation | undefined,
  outcome: Outcome,
  dims?: PerfDims,
): void {
  operation?.sink.end(operation.span, outcome, dims);
}

export function markPerfOperation(
  operation: PerfOperation | undefined,
  phase: string,
  dims?: PerfDims,
): void {
  if (operation) operation.sink.mark(phase, operation.context, dims);
}

export function failPerfOperation(operation: PerfOperation | undefined, error: unknown): void {
  if (operation) endPerfOperation(operation, errorKindToOutcome(classifyPerfError(error)));
}
