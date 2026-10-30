import { expect, it } from "vitest";
import { boardTransferInput, documentPreviewSource, singleBoardUrl } from "./documents";

function transfer(values: Record<string, string>, files: File[] = []) {
  return { files: files as unknown as FileList, getData: (format: string) => values[format] ?? "" };
}

it("recognizes a single HTTP URL and native URI drop while retaining paragraphs as text", () => {
  expect(singleBoardUrl(" https://example.com/page ")).toBe("https://example.com/page");
  expect(boardTransferInput(transfer({ "text/plain": "https://example.com/page" }))).toMatchObject({ entries: [{ document: { kind: "webpage", url: "https://example.com/page" } }] });
  expect(boardTransferInput(transfer({ "text/uri-list": "# native URL\r\nhttps://example.com/page\r\n" }), true)).toMatchObject({ entries: [{ document: { kind: "webpage" } }] });
  const paragraph = "Please read https://example.com/page\nthen keep these notes.";
  expect(boardTransferInput(transfer({ "text/plain": paragraph, "text/uri-list": "https://example.com/page" }), true)).toEqual({ text: paragraph });
  expect(boardTransferInput(transfer({ "text/plain": "javascript:alert(1)" }))).toEqual({ text: "javascript:alert(1)" });
});

it("prioritizes real image files and browser image markup over the containing page URL", () => {
  const file = new File([new Uint8Array([1])], "paste.png", { type: "image/png" });
  expect(boardTransferInput(transfer({ "text/plain": "https://example.com" }, [file]), true)).toEqual({ files: [file] });
  expect(boardTransferInput(transfer({ "text/plain": "https://example.com", "text/html": '<a href="https://example.com"><img src="https://example.com/actual.png"></a>' }), true)).toEqual({ imageUrl: "https://example.com/actual.png" });
});

it("leaves Excalidraw clipboard structures to Excalidraw and never creates JSON text objects", () => {
  for (const text of [
    '{"type":"excalidraw/clipboard","elements":[]}',
    '{ "elements": [], "type": "excalidraw/clipboard" }',
    '{"type":"excalidraw-api/clipboard","elements":[]}',
  ]) expect(boardTransferInput(transfer({ "text/plain": text }))).toBeUndefined();
  expect(boardTransferInput(transfer({ "text/plain": "{plain notes}" }))).toEqual({ text: "{plain notes}" });
});

it("projects managed local images without changing the saved Markdown source", () => {
  const source = '# Original\n\n![A](images/a.png)\n<img src="images/a.png" alt="B">\n[Next](next.md)';
  const binding = { kind: "markdown" as const, name: "Original", source,
    assets: [{ path: "images/a.png", resourceId: "resource-a" }, { path: "next.md", resourceId: "resource-next" }] };
  const preview = documentPreviewSource(binding);
  expect(preview).toContain('![A](app://reelterminal/review-media/resource-a)');
  expect(preview).toContain('src="app://reelterminal/review-media/resource-a"');
  expect(preview).toContain("[Next](next.md)");
  expect(binding.source).toBe(source);
});
