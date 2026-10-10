/**
 * Shared renderer reply-ledger contract: replay of the committed reply,
 * payload comparison at the call site, per-scope bucket isolation, and
 * oldest-first eviction past the per-bucket cap. The live, material, and
 * preset bridges each run their own regression suites against this ledger
 * through their real handlers.
 */
import { describe, expect, it } from "vitest";
import { createReplyLedger, REPLY_LEDGER_MAX_ENTRIES } from "./reply-ledger";

describe("createReplyLedger", () => {
  it("replays the committed result for the same scope and key", () => {
    const ledger = createReplyLedger<{ n: number }>();
    expect(ledger.lookup("scope-a", "k1")).toBeUndefined();

    ledger.commit("scope-a", "k1", { payload: '{"n":1}', result: { n: 1 } });

    const prior = ledger.lookup("scope-a", "k1");
    expect(prior).toEqual({ payload: '{"n":1}', result: { n: 1 } });
    // The caller's replay contract: same payload spreads replayed onto the
    // stored result; a different payload for a committed key is a conflict.
    expect({ ...prior!.result, replayed: true }).toEqual({ n: 1, replayed: true });
    expect(prior!.payload).not.toBe('{"n":2}');
  });

  it("isolates buckets by scope so a key never replays across projects", () => {
    const ledger = createReplyLedger<{ project: string }>();
    ledger.commit("project-a:ws:epoch", "shared-key", {
      payload: '{"p":"a"}',
      result: { project: "A" },
    });

    expect(ledger.lookup("project-a:ws:epoch", "shared-key")?.result).toEqual({ project: "A" });
    expect(ledger.lookup("project-b:ws:epoch", "shared-key")).toBeUndefined();

    // Committing the same key in another bucket leaves A's entry intact.
    ledger.commit("project-b:ws:epoch", "shared-key", {
      payload: '{"p":"b"}',
      result: { project: "B" },
    });
    expect(ledger.lookup("project-a:ws:epoch", "shared-key")?.result).toEqual({ project: "A" });
    expect(ledger.lookup("project-b:ws:epoch", "shared-key")?.result).toEqual({ project: "B" });
  });

  it("evicts the oldest entry past the cap in one bucket without touching another", () => {
    const ledger = createReplyLedger<{ i: number }>();
    const scopeA = "a:ws:epoch";
    const scopeB = "b:ws:epoch";
    ledger.commit(scopeB, "b-early", { payload: "b", result: { i: -1 } });

    for (let i = 0; i <= REPLY_LEDGER_MAX_ENTRIES; i += 1) {
      ledger.commit(scopeA, `k${i}`, { payload: `p${i}`, result: { i } });
    }

    // The bucket holds exactly the newest 500 entries: k0 (the 501st-most-
    // recent insertion) was evicted oldest-first, k1 survived.
    expect(ledger.lookup(scopeA, "k0")).toBeUndefined();
    expect(ledger.lookup(scopeA, "k1")).toEqual({ payload: "p1", result: { i: 1 } });
    expect(ledger.lookup(scopeA, `k${REPLY_LEDGER_MAX_ENTRIES}`)).toEqual({
      payload: `p${REPLY_LEDGER_MAX_ENTRIES}`,
      result: { i: REPLY_LEDGER_MAX_ENTRIES },
    });

    // Eviction in A never touched B's lone entry.
    expect(ledger.lookup(scopeB, "b-early")).toEqual({ payload: "b", result: { i: -1 } });
  });

  it("re-commits replace the stored reply for the same key", () => {
    const ledger = createReplyLedger<{ v: string }>();
    ledger.commit("scope", "k", { payload: "same", result: { v: "first" } });
    ledger.commit("scope", "k", { payload: "same", result: { v: "second" } });
    expect(ledger.lookup("scope", "k")?.result).toEqual({ v: "second" });
  });
});
