import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@reelterminal/core";

const fontStorage = vi.hoisted(() => ({
  families: new Set<string>(),
  bytes: new Map<string, ArrayBuffer>(),
}));

vi.mock("./custom-font-storage", () => ({
  getCustomFontBytes: async (family: string) => fontStorage.bytes.get(family)?.slice(0) ?? null,
  listPersistedCustomFontFamilies: async () => fontStorage.families,
}));

import {
  getMissingProjectRenderDependencyIds,
  installProjectRenderFonts,
  prepareProjectRenderFonts,
  releaseProjectRenderFonts,
} from "./project-render-dependencies";

function projectWith(value: Record<string, unknown>): Project {
  return {
    id: "project",
    name: "Dependencies",
    createdAt: 0,
    modifiedAt: 0,
    settings: { width: 1920, height: 1080, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: { tracks: [] },
    ...value,
  } as unknown as Project;
}

function response(body: string | ArrayBuffer): Response {
  return {
    ok: true,
    text: async () => body as string,
    arrayBuffer: async () => body as ArrayBuffer,
  } as Response;
}

function setFontSources(): void {
  const bundledCss = `
    @font-face {
      font-family: 'Inter'; font-style: normal; font-weight: 400;
      src: url(./inter.woff2) format('woff2'); unicode-range: U+0000-00FF;
    }
  `;
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("google-fonts.css")) return response(bundledCss);
    if (url.endsWith("inter.woff2")) return response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer);
    return { ok: false } as Response;
  }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  fontStorage.families = new Set();
  fontStorage.bytes = new Map();
});

describe("project render dependencies", () => {
  it("captures bundled and persisted font bytes, while reporting unavailable faces", async () => {
    setFontSources();
    fontStorage.families = new Set(["Persisted Custom"]);
    fontStorage.bytes.set("Persisted Custom", new Uint8Array([0x77, 0x4f, 0x46, 0x32, 1]).buffer);
    const project = projectWith({
      textClips: [
        { style: { fontFamily: "Inter" } },
        { style: { fontFamily: "Persisted Custom" } },
        { style: { fontFamily: "Lost Custom" } },
      ],
      motionCompositions: [{
        layers: [{ type: "text", style: { fontFamily: "Another Missing Font" } }],
      }],
    });

    const prepared = await prepareProjectRenderFonts(project);
    expect(prepared.renderFonts).toEqual(expect.arrayContaining([
      expect.objectContaining({ family: "Inter", style: "normal", weight: "400", unicodeRange: "U+0000-00FF" }),
      expect.objectContaining({ family: "Persisted Custom", dataUrl: "data:font/woff2;base64,d09GMgE=" }),
    ]));
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual([
      "font-render:Another Missing Font",
      "font-render:Lost Custom",
      "font:Another Missing Font",
      "font:Lost Custom",
    ]);
  });

  it("preserves saved font bytes and installs snapshot faces in the GUI renderer", async () => {
    const original = projectWith({
      textClips: [{ style: { fontFamily: "Project Font" } }],
      renderFonts: [{
        family: "Project Font",
        style: "italic",
        weight: "500",
        dataUrl: "data:font/woff2;base64,AAAA",
      }],
    });
    const prepared = await prepareProjectRenderFonts(original);
    expect(prepared.renderFonts).toEqual(original.renderFonts);

    const loaded: Array<{ family: string; source: string; descriptors: FontFaceDescriptors }> = [];
    class MockFontFace {
      constructor(
        readonly family: string,
        readonly source: string,
        readonly descriptors: FontFaceDescriptors,
      ) {
        loaded.push({ family, source, descriptors });
      }
      async load() { return this as unknown as FontFace; }
    }
    const added: FontFace[] = [];
    vi.stubGlobal("FontFace", MockFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: (face: FontFace) => added.push(face), delete: () => true },
    });
    await installProjectRenderFonts(prepared);
    expect(loaded).toEqual([{
      family: "Project Font",
      source: 'url("data:font/woff2;base64,AAAA")',
      descriptors: { style: "italic", weight: "500" },
    }]);
    expect(added).toHaveLength(1);
  });

  it("releases only managed faces after the last workspace stops using them", async () => {
    const project = projectWith({
      textClips: [{ style: { fontFamily: "Shared Project Font" } }],
      renderFonts: [{
        family: "Shared Project Font",
        style: "normal",
        weight: "400",
        dataUrl: "data:font/woff2;base64,BBBB",
      }],
    });
    class MockFontFace {
      async load() { return this as unknown as FontFace; }
    }
    const added: FontFace[] = [];
    const deleted: FontFace[] = [];
    vi.stubGlobal("FontFace", MockFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: {
        add: (face: FontFace) => added.push(face),
        delete: (face: FontFace) => { deleted.push(face); return true; },
      },
    });

    await installProjectRenderFonts(project, "workspace-a");
    await installProjectRenderFonts(project, "workspace-b");
    expect(added).toHaveLength(1);

    releaseProjectRenderFonts("workspace-a");
    expect(deleted).toHaveLength(0);
    releaseProjectRenderFonts("workspace-b");
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toBe(added[0]);
  });

  it("reports SVG and motion image URLs without embedded or media-backed bytes", async () => {
    fontStorage.families = new Set();
    const project = projectWith({
      svgClips: [{
        svgContent: '<svg><image href="assets/logo.png"/><image href="#inline"/><image href="data:image/png;base64,AAAA"/><use href="assets/sprite.svg#icon"/></svg>',
      }],
      stickerClips: [{ imageUrl: "https://example.test/sticker.png" }],
      motionCompositions: [{
        assets: [
          { type: "image", url: "/outside/wallpaper.png" },
          { type: "image", mediaId: "media-owned-by-project", url: "/media/image.png" },
        ],
      }],
    });

    await expect(getMissingProjectRenderDependencyIds(project)).resolves.toEqual([
      "image:/outside/wallpaper.png",
      "image:assets/logo.png",
      "image:assets/sprite.svg#icon",
      "image:https://example.test/sticker.png",
    ]);
  });
});
