import { describe, expect, it } from "vitest";
import type {
  WorkbenchFeedback,
  WorkbenchTextContent,
} from "@reelterminal/core";
import { buildTextRangeComments } from "./text-range-comments";

const TEXT_V1 = "第一段落包含重复短语。第二段落也有重复短语。";
const TEXT_V2 = `${TEXT_V1}修订版`;

function textContent(): WorkbenchTextContent {
  return {
    type: "text",
    entryId: "entry-1",
    title: "语料",
    speakerOrContext: "旁白",
    versions: [
      { version: 1, text: TEXT_V1, createdAt: 1, origin: "ingest" },
      { version: 2, text: TEXT_V2, createdAt: 2, origin: "human-revision" },
    ],
  };
}

function rangeComment(
  id: string,
  version: number,
  startOffset: number,
  endOffset: number,
  suggestion: string,
): WorkbenchFeedback {
  return {
    id,
    itemId: "txt-1",
    itemVersion: version,
    text: suggestion,
    referencedTagIds: ["tag-1"],
    target: {
      kind: "text-range",
      entryId: "entry-1",
      version,
      startOffset,
      endOffset,
    },
    state: "confirmed",
    createdAt: 1,
    updatedAt: 1,
  };
}

describe("text range comment readback", () => {
  it("quotes the bound version's original text, not the suggestion", () => {
    const start = TEXT_V1.lastIndexOf("重复短语");
    const views = buildTextRangeComments(textContent(), [
      rangeComment("fb-1", 1, start, start + 4, "第二处重复短语建议压缩"),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].quotedText).toBe("重复短语");
    expect(views[0].suggestion).toBe("第二处重复短语建议压缩");
    expect(views[0].referencedTags).toEqual(["tag-1"]);
    expect(views[0].startOffset).toBe(start);
  });

  it("keeps reading the old quote after a new text version exists", () => {
    const start = TEXT_V1.lastIndexOf("重复短语");
    const views = buildTextRangeComments(textContent(), [
      rangeComment("fb-old", 1, start, start + 4, "旧版本建议"),
    ]);
    expect(views[0].version).toBe(1);
    expect(views[0].quotedText).toBe("重复短语");
    expect(views[0].suggestion).toBe("旧版本建议");
  });

  it("marks an unavailable bound version instead of inventing a quote", () => {
    const views = buildTextRangeComments(textContent(), [
      rangeComment("fb-missing", 9, 0, 4, "建议"),
    ]);
    expect(views[0].quotedText).toBe("（绑定版本原文不可用）");
  });

  it("ignores non-text-range feedback", () => {
    const other: WorkbenchFeedback = {
      id: "fb-ann",
      itemId: "txt-1",
      itemVersion: 1,
      text: "圈注",
      referencedTagIds: [],
      target: { kind: "pixel-region", annotationId: "ann-1", x: 0, y: 0 },
      state: "confirmed",
      createdAt: 1,
      updatedAt: 1,
    };
    expect(buildTextRangeComments(textContent(), [other])).toEqual([]);
  });
});
