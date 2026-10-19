import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@reelterminal/core";
import { CaptureController } from "../performance/capture-controller";
import { editableProjectKey } from "./workspace-record-transforms";

const fontStorage = vi.hoisted(() => ({
  families: new Set<string>(),
  bytes: new Map<string, ArrayBuffer>(),
  unreadableFamilies: new Set<string>(),
  familyQueryFails: false,
}));

vi.mock("./custom-font-storage", () => ({
  getCustomFontBytes: async (family: string) => {
    if (fontStorage.unreadableFamilies.has(family)) throw new DOMException("Font cache read failed", "UnknownError");
    return fontStorage.bytes.get(family)?.slice(0) ?? null;
  },
  listPersistedCustomFontFamilies: async () => {
    if (fontStorage.familyQueryFails) throw new DOMException("Font family query failed", "UnknownError");
    return fontStorage.families;
  },
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
  fontStorage.unreadableFamilies = new Set();
  fontStorage.familyQueryFails = false;
});

describe("project render dependencies", () => {
  it("continues other font sources after custom-cache read failures and still reports unavailable fonts", async () => {
    setFontSources();
    fontStorage.unreadableFamilies = new Set(["Inter", "Local Font", "Unavailable Font"]);
    fontStorage.familyQueryFails = true;
    fontStorage.bytes.set("Working Custom", new Uint8Array([0, 1, 0, 0]).buffer);
    vi.stubGlobal("reelterminal", { platform: "desktop" });
    vi.stubGlobal("queryLocalFonts", vi.fn().mockResolvedValue([
      { family: "Local Font", style: "Regular", blob: async () => ({ arrayBuffer: async () => new Uint8Array([0, 1, 0, 0]).buffer }) },
    ]));
    const project = projectWith({
      textClips: ["Inter", "Local Font", "Unavailable Font", "Working Custom"].map((fontFamily) => ({ style: { fontFamily } })),
    });

    const prepared = await prepareProjectRenderFonts(project);

    expect(prepared.renderFonts?.map((font) => font.family).sort()).toEqual(["Inter", "Local Font", "Working Custom"]);
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual([
      "font-render:Unavailable Font", "font:Unavailable Font",
    ]);
  });

  it("persists partial local-face diagnostics and retries missing weights without rereading captured bytes", async () => {
    setFontSources();
    vi.stubGlobal("reelterminal", { platform: "desktop" });
    const regular = vi.fn(async () => ({ arrayBuffer: async () => new Uint8Array([0, 1, 0, 0, 1]).buffer }));
    const bold = vi.fn().mockRejectedValue(new DOMException("Bold font read failed", "NotReadableError"));
    const query = vi.fn().mockResolvedValue([
      { family: "Partial Font", style: "Regular", blob: regular },
      { family: "Partial Font", style: "Bold", blob: bold },
    ]);
    vi.stubGlobal("queryLocalFonts", query);
    const original = projectWith({ textClips: [{ style: { fontFamily: "Partial Font", fontWeight: "bold" } }] });
    const prepared = await prepareProjectRenderFonts(original);
    // Exercise the on-disk representation, not just an in-memory retry cache.
    const reloaded = JSON.parse(JSON.stringify(prepared)) as Project;

    expect(reloaded.renderFonts).toEqual([expect.objectContaining({ weight: "400" })]);
    expect(reloaded.renderFontMissingFaces).toEqual([{ family: "Partial Font", style: "normal", weight: "700" }]);
    expect(editableProjectKey(reloaded)).toBe(editableProjectKey(original));
    query.mockRejectedValueOnce(new DOMException("Page needs to be visible.", "SecurityError"));
    await expect(getMissingProjectRenderDependencyIds(reloaded)).resolves.toEqual(["font-render:Partial Font"]);

    bold.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([0, 1, 0, 0, 2]).buffer });
    const completed = await prepareProjectRenderFonts(reloaded);

    expect(completed.renderFonts?.map((font) => font.weight)).toEqual(["400", "700"]);
    expect(completed.renderFontMissingFaces).toBeUndefined();
    await expect(getMissingProjectRenderDependencyIds(completed)).resolves.toEqual([]);
    expect(regular).toHaveBeenCalledTimes(1);
    expect(bold).toHaveBeenCalledTimes(2);
    expect(query).toHaveBeenCalledTimes(3);
  });

  it("retries a failed bundled weight while retaining the captured regular face", async () => {
    let boldAvailable = false;
    const fetchFont = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("google-fonts.css")) return response(`
        @font-face { font-family: 'Inter'; font-weight: 400; src: url(./regular.woff2); }
        @font-face { font-family: 'Inter'; font-weight: 700; src: url(./bold.woff2); }
      `);
      if (url.endsWith("bold.woff2") && !boldAvailable) return { ok: false } as Response;
      return response(new Uint8Array([0x77, 0x4f, 0x46, 0x32]).buffer);
    });
    vi.stubGlobal("fetch", fetchFont);
    const prepared = await prepareProjectRenderFonts(projectWith({ textClips: [{ style: { fontFamily: "Inter" } }] }));

    expect(prepared.renderFonts).toHaveLength(1);
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual(["font-render:Inter"]);
    boldAvailable = true;
    const completed = await prepareProjectRenderFonts(JSON.parse(JSON.stringify(prepared)));

    expect(completed.renderFonts?.map((font) => font.weight)).toEqual(["400", "700"]);
    expect(completed.renderFontMissingFaces).toBeUndefined();
    await expect(getMissingProjectRenderDependencyIds(completed)).resolves.toEqual([]);
    expect(fetchFont.mock.calls.filter(([url]) => String(url).endsWith("regular.woff2"))).toHaveLength(1);
  });

  it("clears a failed bundled Unicode subset when a full local face supplies its bytes", async () => {
    vi.stubGlobal("reelterminal", { platform: "desktop" });
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) =>
      String(input).endsWith("google-fonts.css")
        ? response("@font-face { font-family: 'Inter'; font-weight: 700; src: url(./bold.woff2); unicode-range: U+0000-00FF; }")
        : { ok: false } as Response));
    vi.stubGlobal("queryLocalFonts", vi.fn().mockResolvedValue([
      { family: "Inter", style: "Bold", blob: async () => ({ arrayBuffer: async () => new Uint8Array([0, 1, 0, 0]).buffer }) },
    ]));

    const prepared = await prepareProjectRenderFonts(projectWith({ textClips: [{ style: { fontFamily: "Inter" } }] }));

    expect(prepared.renderFonts).toEqual([expect.objectContaining({ family: "Inter", weight: "700" })]);
    expect(prepared.renderFontMissingFaces).toBeUndefined();
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual([]);
  });

  it.each([
    ["SecurityError", "Page needs to be visible."],
    ["NotAllowedError", "Local font access was denied."],
  ])("keeps captured fonts and missing-family diagnostics when local enumeration fails with %s", async (name, message) => {
    setFontSources();
    vi.stubGlobal("reelterminal", { platform: "desktop" });
    vi.stubGlobal("queryLocalFonts", vi.fn().mockRejectedValue(new DOMException(message, name)));
    const savedFont = {
      family: "Saved Font", style: "normal", weight: "400", dataUrl: "data:font/ttf;base64,AAEAAA==",
    };
    const project = projectWith({
      textClips: ["Arial", "Missing Local Font", "Inter", "Saved Font"].map((fontFamily) => ({ style: { fontFamily } })),
      renderFonts: [savedFont],
    });

    const prepared = await prepareProjectRenderFonts(project);

    expect(prepared.textClips).toEqual(project.textClips);
    expect(prepared.renderFonts).toEqual([
      savedFont,
      expect.objectContaining({ family: "Inter" }),
    ]);
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual([
      "font-render:Arial",
      "font-render:Missing Local Font",
      "font:Missing Local Font",
    ]);
  });

  it.each(["blob", "arrayBuffer"])("continues capturing other local fonts when a font's %s read fails", async (failureStage) => {
    setFontSources();
    vi.stubGlobal("reelterminal", { platform: "desktop" });
    const failedRead = vi.fn().mockRejectedValue(new DOMException("Font cannot be read.", "NotReadableError"));
    vi.stubGlobal("queryLocalFonts", vi.fn().mockResolvedValue([
      {
        family: "Broken Local Font", style: "Regular",
        blob: failureStage === "blob" ? failedRead : async () => ({ arrayBuffer: failedRead }),
      },
      {
        family: "Working Local Font", style: "Regular",
        blob: async () => ({ arrayBuffer: async () => new Uint8Array([0, 1, 0, 0]).buffer }),
      },
    ]));
    const project = projectWith({
      textClips: ["Broken Local Font", "Working Local Font"].map((fontFamily) => ({ style: { fontFamily } })),
    });

    const prepared = await prepareProjectRenderFonts(project);

    expect(prepared.renderFonts).toEqual([
      { family: "Working Local Font", style: "normal", weight: "400", dataUrl: "data:font/ttf;base64,AAEAAA==" },
    ]);
    await expect(getMissingProjectRenderDependencyIds(prepared)).resolves.toEqual([
      "font-render:Broken Local Font", "font:Broken Local Font",
    ]);
  });

  it("captures the requested installed family and its real regular/bold faces", async () => {
    setFontSources();
    const regular = new Uint8Array([0, 1, 0, 0, 1]);
    const bold = new Uint8Array([0, 1, 0, 0, 2]);
    Object.assign(window, {
      reelterminal: { platform: "desktop" },
      queryLocalFonts: async () => [
        { family: "Microsoft YaHei", style: "Regular", blob: async () => ({ arrayBuffer: async () => regular.buffer }) },
        { family: "Microsoft YaHei", style: "Bold", blob: async () => ({ arrayBuffer: async () => bold.buffer }) },
        { family: "Unreferenced font", style: "Regular", blob: vi.fn() },
      ],
    });
    try {
      const prepared = await prepareProjectRenderFonts(projectWith({ textClips: [{ style: { fontFamily: "Microsoft YaHei" } }] }));
      expect(prepared.renderFonts).toEqual([
        { family: "Microsoft YaHei", style: "normal", weight: "400", dataUrl: "data:font/ttf;base64,AAEAAAE=" },
        { family: "Microsoft YaHei", style: "normal", weight: "700", dataUrl: "data:font/ttf;base64,AAEAAAI=" },
      ]);
      expect(await getMissingProjectRenderDependencyIds(prepared)).toEqual([]);
    } finally {
      delete (window as unknown as Record<string, unknown>).queryLocalFonts;
      delete (window as unknown as Record<string, unknown>).reelterminal;
    }
  });
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
    expect(prepared.renderFonts).toBe(original.renderFonts);

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

  it("reuses validation and an owner's installed faces for the same immutable font resources", async () => {
    class MockFontFace {
      async load() { return this as unknown as FontFace; }
    }
    const added: FontFace[] = [];
    vi.stubGlobal("FontFace", MockFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: (face: FontFace) => added.push(face), delete: () => true },
    });
    const project = projectWith({
      renderFonts: [{
        family: "Cached Project Font",
        style: "normal",
        weight: "400",
        dataUrl: `data:font/woff2;base64,${"A".repeat(1024)}`,
      }],
    });
    const ownerId = "font-cache-owner";
    const controller = new CaptureController();
    controller.startCapture({ mode: "trace" });
    try {
      await installProjectRenderFonts(project, ownerId);
      await installProjectRenderFonts(project, ownerId);

      const report = controller.stopCapture();
      const validations = report.events.filter((event) =>
        event.kind === "span_end" && event.phase === "font.validate",
      );
      expect(validations).toHaveLength(2);
      expect(validations[0]).toMatchObject({ dims: { candidates: 1, valid: 1, invalid: 0 } });
      expect(validations[1]).toMatchObject({ dims: {
        candidates: 1,
        valid: 1,
        invalid: 0,
        cacheHit: true,
        fullValidations: 0,
      } });
      expect(added).toHaveLength(1);
    } finally {
      releaseProjectRenderFonts(ownerId);
      if (controller.activeRunId) controller.stopCapture();
    }
  });

  it("records privacy-safe font validation, loading and lease stages", async () => {
    class MockFontFace {
      constructor(readonly family: string) {}
      async load() { return this as unknown as FontFace; }
    }
    vi.stubGlobal("FontFace", MockFontFace);
    Object.defineProperty(document, "fonts", {
      configurable: true,
      value: { add: () => undefined, delete: () => true },
    });
    const project = projectWith({
      renderFonts: [
        { family: "Sensitive Family Name", style: "normal", weight: "400", dataUrl: "data:font/woff2;base64,AAAA" },
        { family: "Broken", style: "normal", weight: "400", dataUrl: "file:///outside/font.ttf" },
      ],
    });
    const controller = new CaptureController();
    controller.startCapture({ mode: "trace" });
    try {
      await installProjectRenderFonts(project, "perf-owner");
      releaseProjectRenderFonts("perf-owner");
      const report = controller.stopCapture();
      expect(report.openSpans).toBe(0);
      const phases = report.events.map((event) => event.phase);
      expect(phases).toEqual(expect.arrayContaining([
        "font.install",
        "font.validate",
        "font.lease-acquire",
        "font.load",
        "font.lease-release",
      ]));
      expect(JSON.stringify(report.events)).not.toContain("Sensitive Family Name");
      expect(report.events.find((event) =>
        event.kind === "span_end" && event.phase === "font.validate",
      )).toMatchObject({ dims: { candidates: 2, valid: 1, invalid: 1 } });
    } finally {
      releaseProjectRenderFonts("perf-owner");
      if (controller.activeRunId) controller.stopCapture();
    }
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
