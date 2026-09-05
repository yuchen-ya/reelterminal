import { afterEach, describe, expect, it } from "vitest";
import {
  sortAgentReferenceTargets,
  useAgentReferencesStore,
  type AgentReferenceTarget,
} from "./agent-references-store";

const target = (
  entityId: string,
  startSeconds: number | null,
  trackOrder: number,
): AgentReferenceTarget => ({
  kind: "video",
  entityId,
  label: entityId,
  timing: {
    startSeconds,
    endSeconds: startSeconds === null ? null : startSeconds + 1,
  },
  trackOrder,
});

describe("agent reference numbering", () => {
  afterEach(() => {
    useAgentReferencesStore.getState().reset();
  });

  it("sorts multi-selection by timeline start, then track order", () => {
    const sorted = sortAgentReferenceTargets([
      target("track-2-late", 2, 0),
      target("track-1-early", 1, 1),
      target("track-0-early", 1, 0),
    ]);
    expect(sorted.map((item) => item.entityId)).toEqual([
      "track-0-early",
      "track-1-early",
      "track-2-late",
    ]);

    const marked = useAgentReferencesStore
      .getState()
      .mark(sorted, 12);
    expect(marked.map((item) => item.number)).toEqual([1, 2, 3]);
    expect(marked.map((item) => item.ref)).toEqual(["A1", "A2", "A3"]);
    expect(marked.map((item) => item.entityId)).toEqual([
      "track-0-early",
      "track-1-early",
      "track-2-late",
    ]);
  });

  it("returns an existing number when an entity is marked again", () => {
    const first = useAgentReferencesStore.getState().mark([target("clip", 0, 0)], 4);
    const repeated = useAgentReferencesStore.getState().mark([target("clip", 0, 0)], 99);
    expect(first[0]?.number).toBe(1);
    expect(repeated[0]).toEqual(first[0]);
    expect(useAgentReferencesStore.getState().nextNumber).toBe(2);
  });

  it("keeps deleted references stale and never rebinds or reuses their number", () => {
    const original = target("clip", 0, 0);
    useAgentReferencesStore.getState().mark([original], 2);
    useAgentReferencesStore.getState().syncStale([]);

    const stale = useAgentReferencesStore.getState().mark([original], 8);
    expect(stale[0]).toMatchObject({ number: 1, entityId: "clip", stale: true });

    const next = useAgentReferencesStore
      .getState()
      .mark([target("replacement", 0, 0)], 9);
    expect(next[0]?.number).toBe(2);
    expect(useAgentReferencesStore.getState().references).toMatchObject({
      "1": { entityId: "clip", stale: true },
      "2": { entityId: "replacement", stale: false },
    });
  });
});
