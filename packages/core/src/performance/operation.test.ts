import { afterEach, describe, expect, it, vi } from "vitest";
import { beginPerfOperation, endPerfOperation, failPerfOperation, markPerfOperation } from "./operation";
import { setPerfSink } from "./sink";
import type { PerfSink } from "./types";

function testSink(runId: string): PerfSink {
  return {
    enabled: true, mode: "light", runId,
    begin: vi.fn(() => ({ id: 1, startedUs: 100 })),
    end: vi.fn(), mark: vi.fn(), count: vi.fn(),
  };
}

afterEach(() => setPerfSink(null));

describe("product performance operations", () => {
  it("is inert with the default sink and preserves undefined handles", () => {
    setPerfSink(null);
    const operation = beginPerfOperation("product.operation");
    expect(operation).toBeUndefined();
    expect(() => { endPerfOperation(operation, "ok"); markPerfOperation(operation, "done"); failPerfOperation(operation, new Error("secret")); }).not.toThrow();
  });

  it("correlates child phases and never ends an old operation in a new capture", () => {
    const first = testSink("first");
    setPerfSink(first);
    const parent = beginPerfOperation("product.operation")!;
    const child = beginPerfOperation("product.phase", parent)!;
    expect(child.context).toMatchObject({ runId: "first", operationId: parent.context.operationId, parentSpanId: parent.span.id });
    const second = testSink("second");
    setPerfSink(second);
    endPerfOperation(child, "ok");
    expect(first.end).toHaveBeenCalledWith(child.span, "ok", undefined);
    expect(second.end).not.toHaveBeenCalled();
    expect(beginPerfOperation("product.phase", parent)!.context.runId).toBe("second");
  });

  it("classifies failure without reading or outputting its message", () => {
    const sink = testSink("error-run");
    setPerfSink(sink);
    const operation = beginPerfOperation("product.operation")!;
    const error = { name: "AbortError", get message() { throw new Error("message must not be read"); } };
    failPerfOperation(operation, error);
    expect(sink.end).toHaveBeenCalledWith(operation.span, "cancelled", undefined);
  });
});
