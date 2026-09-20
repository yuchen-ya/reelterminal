import { describe, expect, it } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { FacadeResult } from "@reelterminal/agent-facade";
import { appendVisualImageContent } from "../src/serve";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("stdio visual MCP content", () => {
  it("appends only a real facade-contained PNG image block", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "ave-stdio-visual-"));
    try {
      const sheetPath = path.join(artifactRoot, "visual", "contact-sheet.png");
      await mkdir(path.dirname(sheetPath), { recursive: true });
      await writeFile(sheetPath, ONE_PIXEL_PNG);
      const result: FacadeResult<unknown> = {
        ok: true,
        value: {
          revision: 1,
          sourceRevision: 1,
          frames: [],
          contactSheet: { path: sheetPath, format: "png", sizeBytes: ONE_PIXEL_PNG.length },
        },
      };
      const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(result) }];
      await appendVisualImageContent(content, result, artifactRoot);
      expect(content).toHaveLength(2);
      expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
      if (content[1]?.type === "image") {
        expect(Buffer.from(content[1].data, "base64")).toEqual(await readFile(sheetPath));
      }
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });

  it("falls back to a valid frame when the contact sheet is missing", async () => {
    const artifactRoot = await mkdtemp(path.join(tmpdir(), "ave-stdio-visual-fallback-"));
    try {
      const framePath = path.join(artifactRoot, "visual", "frame-1.png");
      await mkdir(path.dirname(framePath), { recursive: true });
      await writeFile(framePath, ONE_PIXEL_PNG);
      const result: FacadeResult<unknown> = {
        ok: true,
        value: {
          revision: 1,
          sourceRevision: 1,
          contactSheet: { path: path.join(artifactRoot, "visual", "missing-sheet.png") },
          frames: [{ artifact: { path: framePath } }],
        },
      };
      const content: CallToolResult["content"] = [{ type: "text", text: JSON.stringify(result) }];
      await appendVisualImageContent(content, result, artifactRoot);
      const image = content.find((block) => block.type === "image");
      expect(image?.type).toBe("image");
      if (image?.type === "image") {
        expect(Buffer.from(image.data, "base64")).toEqual(await readFile(framePath));
      }
      expect(content.some((block) => block.type === "text" && block.text.includes("not embedded"))).toBe(true);
    } finally {
      await rm(artifactRoot, { recursive: true, force: true });
    }
  });
});
