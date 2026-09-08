import { describe, expect, it } from "vitest";
import {
  applyMaterialJournalUndo,
  applyMaterialUpdate,
  buildMaterialJournalEntry,
  buildMaterialListResult,
  buildMaterialRecord,
  collapseMaterialChanges,
  collectMaterialTags,
  isValidSegmentRange,
  matchesMaterialQuery,
  normalizeMaterialJournalEntry,
  normalizeMaterialRecord,
  sanitizeMaterialTags,
  validateMaterialBuildInput,
  type MaterialBuildInput,
  type MaterialUpdatePatch,
} from "./logic";
import type {
  MaterialJournalChange,
  MaterialRecord,
  SegmentMaterialRecord,
} from "./types";

const NOW = "2026-09-08T10:00:00.000Z";

function mediaInput(overrides: Partial<MaterialBuildInput> = {}): MaterialBuildInput {
  return {
    kind: "media",
    actor: "user",
    mediaType: "video",
    fileRef: {
      type: "path",
      path: "/Users/demo/Movies/clip.mp4",
      fileName: "clip.mp4",
    },
    ...overrides,
  };
}

function linkInput(overrides: Partial<MaterialBuildInput> = {}): MaterialBuildInput {
  return {
    kind: "link",
    actor: "user",
    url: "https://example.com/tutorial",
    ...overrides,
  };
}

function methodInput(overrides: Partial<MaterialBuildInput> = {}): MaterialBuildInput {
  return {
    kind: "method",
    actor: "user",
    prompt: "Build a highlight reel: analyze beats, pick top 5 moments.",
    skillName: "highlight-reel",
    steps: ["Inspect sources", "Pick anchors", "Assemble timeline"],
    inputs: ["one or more videos"],
    ...overrides,
  };
}

describe("buildMaterialRecord", () => {
  it("builds a media record with path defaults", () => {
    const record = buildMaterialRecord(mediaInput({ nowIso: NOW }));
    expect(record.kind).toBe("media");
    expect(record.title).toBe("clip.mp4");
    expect(record.organizeStatus).toBe("inbox");
    expect(record.revision).toBe(1);
    if (record.kind !== "media") throw new Error("unreachable");
    expect(record.fileRef.type).toBe("path");
    expect(record.source.addedBy).toBe("user");
    expect(record.updatedBy).toBe("user");
    expect(record.lastAgentEditAt).toBeUndefined();
  });

  it("marks agent-created records with lastAgentEditAt", () => {
    const record = buildMaterialRecord(linkInput({ actor: "agent", nowIso: NOW }));
    expect(record.source.addedBy).toBe("agent");
    expect(record.updatedBy).toBe("agent");
    expect(record.lastAgentEditAt).toBe(NOW);
  });

  it("derives link titles from the host and method titles from the skill", () => {
    expect(buildMaterialRecord(linkInput({ nowIso: NOW })).title).toBe("example.com");
    expect(buildMaterialRecord(methodInput({ nowIso: NOW })).title).toBe("highlight-reel");
  });

  it("rejects invalid segment ranges", () => {
    const issues = validateMaterialBuildInput({
      kind: "segment",
      actor: "user",
      parentMaterialId: "mat_x",
      startSec: 5,
      endSec: 5,
    });
    expect(issues.some((issue) => issue.field === "startSec/endSec")).toBe(true);
  });

  it("rejects non-http link URLs and media without fileRef", () => {
    expect(
      validateMaterialBuildInput(linkInput({ url: "ftp://example.com/x" })),
    ).toHaveLength(1);
    expect(
      validateMaterialBuildInput(mediaInput({ fileRef: undefined, mediaType: "video" })),
    ).toHaveLength(1);
  });

  it("rejects method without prompt", () => {
    expect(validateMaterialBuildInput(methodInput({ prompt: "" }))).toHaveLength(1);
  });
});

describe("isValidSegmentRange", () => {
  it("accepts 0 <= start < end within parent duration", () => {
    expect(isValidSegmentRange(0, 10, 10)).toBe(true);
    expect(isValidSegmentRange(2, 4, 10)).toBe(true);
  });

  it("rejects inverted, zero-length, negative, and beyond-parent ranges", () => {
    expect(isValidSegmentRange(5, 5)).toBe(false);
    expect(isValidSegmentRange(6, 5)).toBe(false);
    expect(isValidSegmentRange(-1, 5)).toBe(false);
    expect(isValidSegmentRange(0, 11, 10)).toBe(false);
    expect(isValidSegmentRange(Number.NaN, 5)).toBe(false);
  });

  it("tolerates end-of-file rounding within the epsilon", () => {
    expect(isValidSegmentRange(0, 10.02, 10)).toBe(true);
    expect(isValidSegmentRange(0, 10.5, 10)).toBe(false);
  });
});

describe("sanitizeMaterialTags", () => {
  it("trims, drops empties, dedupes case-insensitively, caps counts", () => {
    expect(sanitizeMaterialTags([" a ", "A", "", "b"])).toEqual(["a", "b"]);
    expect(sanitizeMaterialTags(["x".repeat(100)])).toEqual(["x".repeat(64)]);
    const many = Array.from({ length: 40 }, (_, i) => `tag${i}`);
    expect(sanitizeMaterialTags(many)).toHaveLength(32);
  });
});

describe("applyMaterialUpdate", () => {
  it("bumps revision and records agent provenance", () => {
    const record = buildMaterialRecord(methodInput({ nowIso: NOW }));
    const patch: MaterialUpdatePatch = {
      aiSummary: "Agent summary",
      tags: ["intro", "color"],
      organizeStatus: "organized",
    };
    const next = applyMaterialUpdate(record, patch, "agent", "2026-09-08T11:00:00.000Z");
    expect(next.revision).toBe(2);
    expect(next.updatedBy).toBe("agent");
    expect(next.lastAgentEditAt).toBe("2026-09-08T11:00:00.000Z");
    expect(next.aiSummary).toBe("Agent summary");
    expect(next.organizeStatus).toBe("organized");
  });

  it("never moves userNotes on agent writes even if asked", () => {
    const record = buildMaterialRecord(mediaInput({ userNotes: "my note", nowIso: NOW }));
    const next = applyMaterialUpdate(record, { userNotes: "agent overwrite" }, "agent");
    expect(next.userNotes).toBe("my note");
    const userEdit = applyMaterialUpdate(next, { userNotes: "updated" }, "user");
    expect(userEdit.userNotes).toBe("updated");
  });

  it("rejects description updates on non-link records", () => {
    const record = buildMaterialRecord(mediaInput({ nowIso: NOW }));
    expect(() => applyMaterialUpdate(record, { description: "x" }, "user")).toThrow();
  });
});

describe("search and filtering", () => {
  const records: MaterialRecord[] = [
    buildMaterialRecord(
      mediaInput({ title: "Drone footage", tags: ["outdoor"], nowIso: NOW }),
    ),
    buildMaterialRecord(
      linkInput({ title: "Color grading guide", tags: ["color"], nowIso: NOW }),
    ),
    buildMaterialRecord(
      methodInput({ title: "Highlight method", prompt: "pick best moments", nowIso: NOW }),
    ),
  ];

  it("matches all whitespace tokens across kind-specific text", () => {
    expect(matchesMaterialQuery(records[2], "highlight moments")).toBe(true);
    expect(matchesMaterialQuery(records[2], "highlight missing")).toBe(false);
    expect(matchesMaterialQuery(records[1], "color guide")).toBe(true);
    expect(matchesMaterialQuery(records[0], "clip.mp4")).toBe(true);
  });

  it("searches user notes and AI summaries", () => {
    const withNotes = applyMaterialUpdate(
      records[0],
      { userNotes: "sunset beach trip" },
      "user",
    );
    expect(matchesMaterialQuery(withNotes, "beach")).toBe(true);
    const withSummary = applyMaterialUpdate(
      records[0],
      { aiSummary: "aerial city scan" },
      "agent",
    );
    expect(matchesMaterialQuery(withSummary, "aerial")).toBe(true);
  });

  it("filters, paginates, and reports tags across the whole library", () => {
    const page1 = buildMaterialListResult(records, {
      page: 1,
      pageSize: 2,
    });
    expect(page1.items).toHaveLength(2);
    expect(page1.total).toBe(3);
    expect(page1.totalPages).toBe(2);
    expect(page1.allTags).toEqual(["color", "outdoor"]);

    const onlyLinks = buildMaterialListResult(records, {
      kind: "link",
      page: 1,
      pageSize: 10,
    });
    expect(onlyLinks.items).toHaveLength(1);
    expect(onlyLinks.items[0].kind).toBe("link");

    const tagged = buildMaterialListResult(records, {
      tag: "COLOR",
      page: 1,
      pageSize: 10,
    });
    expect(tagged.total).toBe(1);

    const searched = buildMaterialListResult(records, {
      query: "moments",
      page: 1,
      pageSize: 10,
    });
    expect(searched.total).toBe(1);
    expect(searched.items[0].title).toBe("Highlight method");
  });

  it("clamps out-of-range pages to the last page", () => {
    const result = buildMaterialListResult(records, { page: 99, pageSize: 2 });
    expect(result.page).toBe(2);
    expect(result.items).toHaveLength(1);
  });

  it("collects tags case-insensitively deduped and sorted", () => {
    expect(collectMaterialTags(records)).toEqual(["color", "outdoor"]);
  });
});

describe("journal", () => {
  it("collapses repeated touches of one record into a single change", () => {
    const record = buildMaterialRecord(mediaInput({ nowIso: NOW }));
    const updated = applyMaterialUpdate(record, { tags: ["a"] }, "agent", NOW);
    const updatedAgain = applyMaterialUpdate(updated, { aiSummary: "s" }, "agent", NOW);
    const changes: MaterialJournalChange[] = [
      { materialId: record.id, before: null, after: record },
      { materialId: record.id, before: record, after: updated },
      { materialId: record.id, before: updated, after: updatedAgain },
    ];
    const collapsed = collapseMaterialChanges(changes);
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0].before).toBeNull();
    expect(collapsed[0].after).toBe(updatedAgain);
  });

  it("undoing an agent batch restores the exact prior state", () => {
    const media = buildMaterialRecord(mediaInput({ title: "Original", nowIso: NOW }));
    const link = buildMaterialRecord(linkInput({ nowIso: NOW }));
    const taggedMedia = applyMaterialUpdate(media, { tags: ["agent-tag"] }, "agent", NOW);
    const entry = buildMaterialJournalEntry({
      actor: "agent",
      label: "agent: material.batch_update (2 items)",
      verb: "material.batch_update",
      changes: [
        { materialId: media.id, before: media, after: taggedMedia },
        { materialId: link.id, before: null, after: link },
      ],
      nowIso: NOW,
    });
    const outcome = applyMaterialJournalUndo([taggedMedia, link], entry);
    expect(outcome.records.map((r) => r.id)).toEqual([media.id]);
    const restored = outcome.records[0];
    expect(restored.tags).toEqual([]);
    expect(restored.revision).toBe(1);
    expect(outcome.removed).toEqual([link.id]);
  });

  it("undo removes records the batch created and restores removed ones", () => {
    const media = buildMaterialRecord(mediaInput({ nowIso: NOW }));
    const entry = buildMaterialJournalEntry({
      actor: "user",
      label: "remove",
      changes: [{ materialId: media.id, before: media, after: null }],
      nowIso: NOW,
    });
    const outcome = applyMaterialJournalUndo([], entry);
    expect(outcome.records[0].id).toBe(media.id);
    expect(outcome.restored).toEqual([media.id]);
  });
});

describe("normalizeMaterialRecord", () => {
  it("round-trips records through JSON with optional fields dropped", () => {
    const record = buildMaterialRecord(
      methodInput({ nowIso: NOW, aiSummary: "sum", userNotes: "note" }),
    );
    const normalized = normalizeMaterialRecord(JSON.parse(JSON.stringify(record)));
    expect(normalized).toEqual(record);
  });

  it("fills defaults for legacy-shaped rows", () => {
    const raw = {
      id: "mat_1",
      kind: "segment",
      title: "Intro",
      parentMaterialId: "mat_0",
      startSec: 1,
      endSec: 2,
    };
    const normalized = normalizeMaterialRecord(raw);
    expect(normalized).not.toBeNull();
    const segment = normalized as SegmentMaterialRecord;
    expect(segment.tags).toEqual([]);
    expect(segment.userNotes).toBe("");
    expect(segment.revision).toBe(1);
    expect(segment.usages).toEqual([]);
  });

  it("returns null for corrupt rows", () => {
    expect(normalizeMaterialRecord({ id: "mat_1", kind: "nope" })).toBeNull();
    expect(normalizeMaterialRecord(null)).toBeNull();
    expect(
      normalizeMaterialRecord({ id: "mat_1", kind: "media", mediaType: "video" }),
    ).toBeNull();
    expect(
      normalizeMaterialRecord({ id: "mat_1", kind: "segment", parentMaterialId: "x", startSec: 5, endSec: 1 }),
    ).toBeNull();
  });

  it("normalizes journal entries defensively", () => {
    const record = buildMaterialRecord(mediaInput({ nowIso: NOW }));
    const entry = buildMaterialJournalEntry({
      actor: "agent",
      label: "batch",
      changes: [{ materialId: record.id, before: null, after: record }],
      nowIso: NOW,
    });
    const normalized = normalizeMaterialJournalEntry(JSON.parse(JSON.stringify(entry)));
    expect(normalized?.changes[0].after?.id).toBe(record.id);
    expect(
      normalizeMaterialJournalEntry({ id: "x", changes: "no" }),
    ).toBeNull();
  });
});
