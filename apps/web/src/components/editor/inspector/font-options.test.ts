/**
 * registerFontBytes unit tests: byte-signature validation, family
 * derivation/dedup, FontFace activation and structured error codes.
 * The IndexedDB layer is inert under jsdom (no indexedDB ⇒ persistence is
 * a no-op, exactly the "best-effort" path) and FontFace is replaced with a
 * deterministic fake.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

class FakeFontFace {
  static instances: FakeFontFace[] = [];
  readonly family: string;
  readonly data: ArrayBuffer;

  constructor(family: string, data: ArrayBuffer) {
    this.family = family;
    this.data = data;
    FakeFontFace.instances.push(this);
  }

  async load(): Promise<FakeFontFace> {
    // Deterministic failure marker: any 0xBA byte means "unparseable".
    if (new Uint8Array(this.data).includes(0xba)) {
      throw new Error("NetworkError: The font data could not be parsed");
    }
    return this;
  }
}

const fontsAdd = vi.fn();

async function loadModule() {
  return await import("./font-options");
}

beforeEach(() => {
  vi.resetModules();
  FakeFontFace.instances = [];
  fontsAdd.mockClear();
  vi.stubGlobal("FontFace", FakeFontFace);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { add: fontsAdd },
  });
  // The shared setup.ts indexedDB mock never fires onsuccess (it exists for
  // UI smoke tests), which would leave persistFont pending forever. Fonts
  // persistence is deliberately inert here: openFontsDB resolves null and
  // the "best-effort persistence" path is exercised as a no-op.
  (window as { indexedDB: unknown }).indexedDB = undefined;
  (globalThis as { indexedDB: unknown }).indexedDB = undefined;
});

function makeFile(name: string, bytes: Uint8Array): File {
  const file = new File([bytes as BlobPart], name);
  const buffer = bytes.slice().buffer as ArrayBuffer;
  Object.defineProperty(file, "arrayBuffer", {
    value: async () => buffer,
  });
  return file;
}

function fontBytes(signature: [number, number, number, number]): ArrayBuffer {
  return new Uint8Array([...signature, 0x01, 0x02]).buffer;
}

describe("detectFontFormat", () => {
  it("recognizes the four supported container signatures", async () => {
    const { detectFontFormat } = await loadModule();
    expect(detectFontFormat(fontBytes([0x00, 0x01, 0x00, 0x00]))).toBe("ttf");
    expect(detectFontFormat(fontBytes([0x4f, 0x54, 0x54, 0x4f]))).toBe("otf");
    expect(detectFontFormat(fontBytes([0x77, 0x4f, 0x46, 0x46]))).toBe("woff");
    expect(detectFontFormat(fontBytes([0x77, 0x4f, 0x46, 0x32]))).toBe("woff2");
  });

  it("rejects look-alike bytes and truncated input", async () => {
    const { detectFontFormat } = await loadModule();
    expect(detectFontFormat(fontBytes([0x74, 0x65, 0x73, 0x74]))).toBeNull(); // "test"
    expect(detectFontFormat(fontBytes([0x00, 0x02, 0x00, 0x00]))).toBeNull();
    expect(detectFontFormat(new Uint8Array([0x00, 0x01]).buffer)).toBeNull();
  });
});

describe("registerFontBytes", () => {
  it("activates a valid font under the derived family and reports the format", async () => {
    const { registerFontBytes, getCustomFonts } = await loadModule();
    const result = await registerFontBytes("Bar", fontBytes([0x00, 0x01, 0x00, 0x00]));
    expect(result).toEqual({
      success: true,
      fontFamily: "Bar",
      format: "ttf",
    });
    expect(FakeFontFace.instances).toHaveLength(1);
    expect(FakeFontFace.instances[0].family).toBe("Bar");
    expect(fontsAdd).toHaveBeenCalledTimes(1);
    expect(getCustomFonts()).toContain("Bar");
  });

  it("strips a font extension from the supplied name", async () => {
    const { registerFontBytes } = await loadModule();
    const result = await registerFontBytes("Bar.ttf", fontBytes([0x77, 0x4f, 0x46, 0x32]));
    expect(result.success && result.fontFamily).toBe("Bar");
    expect(result.success && result.format).toBe("woff2");
  });

  it("suffixes a duplicate base name instead of overwriting", async () => {
    const { registerFontBytes } = await loadModule();
    const first = await registerFontBytes("Bar", fontBytes([0x00, 0x01, 0x00, 0x00]));
    const second = await registerFontBytes("Bar", fontBytes([0x00, 0x01, 0x00, 0x00]));
    expect(first.success && first.fontFamily).toBe("Bar");
    expect(second.success && second.fontFamily).toBe("Bar 2");
    expect(FakeFontFace.instances.map((face) => face.family)).toEqual(["Bar", "Bar 2"]);
  });

  it("rejects non-font bytes before FontFace ever sees them", async () => {
    const { registerFontBytes } = await loadModule();
    const junk = new TextEncoder().encode("this is not a font at all").buffer as ArrayBuffer;
    const result = await registerFontBytes("Junk", junk);
    expect(result).toEqual({
      success: false,
      error: "This file is not a valid .ttf, .otf, .woff, or .woff2 font.",
      code: "INVALID_FONT_DATA",
    });
    expect(FakeFontFace.instances).toHaveLength(0);
    expect(fontsAdd).not.toHaveBeenCalled();
  });

  it("maps a FontFace load failure to FONT_LOAD_FAILED", async () => {
    const { registerFontBytes } = await loadModule();
    const corrupt = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0xba]);
    const result = await registerFontBytes("Broken", corrupt.buffer as ArrayBuffer);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.code).toBe("FONT_LOAD_FAILED");
      expect(result.error).toBe("Could not load this font file.");
    }
    expect(fontsAdd).not.toHaveBeenCalled();
  });

  it("reports an unsupported environment without FontFace", async () => {
    vi.stubGlobal("FontFace", undefined);
    const { registerFontBytes } = await loadModule();
    const result = await registerFontBytes("Bar", fontBytes([0x00, 0x01, 0x00, 0x00]));
    expect(result).toEqual({
      success: false,
      error: "Custom font upload is not supported in this environment.",
      code: "UNSUPPORTED_ENVIRONMENT",
    });
  });
});

describe("registerCustomFont (GUI path)", () => {
  it("keeps the extension whitelist and its original message", async () => {
    const { registerCustomFont } = await loadModule();
    const file = makeFile("notes.txt", new TextEncoder().encode("glyphs"));
    const result = await registerCustomFont(file);
    expect(result).toEqual({
      success: false,
      error: "Please upload a .ttf, .otf, .woff, or .woff2 font file.",
    });
  });

  it("registers a valid file and returns the deduped family", async () => {
    const { registerCustomFont, registerFontBytes } = await loadModule();
    await registerFontBytes("Uploaded", fontBytes([0x4f, 0x54, 0x54, 0x4f]));
    const file = makeFile("Uploaded.otf", new Uint8Array([0x4f, 0x54, 0x54, 0x4f, 0x01]));
    const result = await registerCustomFont(file);
    expect(result.success && result.fontFamily).toBe("Uploaded 2");
  });

  it("rejects a renamed text file through the shared magic check", async () => {
    const { registerCustomFont } = await loadModule();
    const file = makeFile("Fake.ttf", new TextEncoder().encode("plain text"));
    const result = await registerCustomFont(file);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("not a valid .ttf, .otf, .woff, or .woff2 font");
    }
    expect(FakeFontFace.instances).toHaveLength(0);
  });
});

describe("listCustomFontRecords", () => {
  it("lists installed fonts with metadata, honestly null when never persisted", async () => {
    const { registerFontBytes, listCustomFontRecords, removeCustomFont } = await loadModule();
    await registerFontBytes("Solo", fontBytes([0x77, 0x4f, 0x46, 0x46]));
    const records = await listCustomFontRecords();
    expect(records).toHaveLength(1);
    expect(records[0]).toEqual({
      family: "Solo",
      format: "woff",
      sizeBytes: null,
      uploadedAt: null,
    });
    await removeCustomFont("Solo");
    expect(await listCustomFontRecords()).toHaveLength(0);
  });
});
