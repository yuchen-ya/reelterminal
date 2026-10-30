import { describe, expect, it } from "vitest";
import { documentPreviewSource } from "./documents";

describe("board document preview", () => {
  it("keeps malformed percent references missing while rendering available assets", () => {
    expect(documentPreviewSource({
      kind: "markdown", name: "notes.md", documentPath: "notes.md",
      source: "![missing](100%.png)\n![available](100%25.png)",
      assets: [{ path: "100%.png", missing: "无效路径编码" }, { path: "100%.png", resourceId: "image-resource" }],
    })).toBe("![missing](100%.png)\n![available](app://reelterminal/review-media/image-resource)");
  });
});
