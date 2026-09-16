/**
 * font-bridge tests: the renderer half of the font.* live bridge —
 * envelope/validation of the forwarded request, byte-type and size guards,
 * error-code mapping to the facade taxonomy, and the list projection with
 * honest loadedInSession flags. The canonical font service is mocked; the
 * service's own behavior is covered by font-options.test.ts.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  handleFontLibraryRequest,
} from "./font-bridge";
import type { CustomFontRecord } from "../../components/editor/inspector/font-options";

const registerFontBytes = vi.fn();
const getCustomFonts = vi.fn((): string[] => []);
const listCustomFontRecords = vi.fn(
  async (): Promise<CustomFontRecord[]> => [],
);

vi.mock("../../components/editor/inspector/font-options", () => ({
  registerFontBytes: (name: string, data: ArrayBuffer) =>
    registerFontBytes(name, data),
  getCustomFonts: () => getCustomFonts(),
  listCustomFontRecords: () => listCustomFontRecords(),
}));

beforeEach(() => {
  registerFontBytes.mockReset();
  getCustomFonts.mockReset();
  getCustomFonts.mockImplementation(() => []);
  listCustomFontRecords.mockReset();
  listCustomFontRecords.mockImplementation(async () => []);
});

describe("handleFontLibraryRequest", () => {
  it("rejects an upload without ArrayBuffer bytes", async () => {
    const reply = await handleFontLibraryRequest({
      verb: "upload",
      params: { name: "Bar", data: "00 01 00 00" },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INVALID_PARAMS");
    expect(registerFontBytes).not.toHaveBeenCalled();
  });

  it("rejects bytes above the bridge budget before registration", async () => {
    const big = new ArrayBuffer(10 * 1024 * 1024 + 1);
    const reply = await handleFontLibraryRequest({
      verb: "upload",
      params: { name: "Bar", data: big },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("INVALID_PARAMS");
      expect(reply.error.message).toContain("10485760");
    }
    expect(registerFontBytes).not.toHaveBeenCalled();
  });

  it("forwards a valid upload and reports the assigned family", async () => {
    registerFontBytes.mockResolvedValue({
      success: true,
      fontFamily: "Bar",
      format: "ttf",
    });
    const data = new Uint8Array([0x00, 0x01, 0x00, 0x00]).buffer;
    const reply = await handleFontLibraryRequest({
      verb: "upload",
      params: { name: "Bar", data },
    });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({
        fontFamily: "Bar",
        format: "ttf",
        sizeBytes: 4,
      });
    }
    expect(registerFontBytes).toHaveBeenCalledWith("Bar", data);
  });

  it("maps INVALID_FONT_DATA to INVALID_PARAMS with the reason kept", async () => {
    registerFontBytes.mockResolvedValue({
      success: false,
      error: "This file is not a valid .ttf, .otf, .woff, or .woff2 font.",
      code: "INVALID_FONT_DATA",
    });
    const reply = await handleFontLibraryRequest({
      verb: "upload",
      params: { data: new ArrayBuffer(8) },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) {
      expect(reply.error.code).toBe("INVALID_PARAMS");
      expect(reply.error.message).toContain("not a valid .ttf");
    }
  });

  it("maps UNSUPPORTED_ENVIRONMENT to UNSUPPORTED", async () => {
    registerFontBytes.mockResolvedValue({
      success: false,
      error: "Custom font upload is not supported in this environment.",
      code: "UNSUPPORTED_ENVIRONMENT",
    });
    const reply = await handleFontLibraryRequest({
      verb: "upload",
      params: { data: new ArrayBuffer(8) },
    });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("UNSUPPORTED");
  });

  it("lists records with loadedInSession derived from the live set", async () => {
    listCustomFontRecords.mockResolvedValue([
      { family: "Loaded", format: "ttf", sizeBytes: 12, uploadedAt: 1 },
      { family: "Dormant", format: "woff2", sizeBytes: null, uploadedAt: null },
    ]);
    getCustomFonts.mockReturnValue(["Loaded"]);
    const reply = await handleFontLibraryRequest({ verb: "list" });
    expect(reply.ok).toBe(true);
    if (reply.ok) {
      expect(reply.result).toEqual({
        fonts: [
          { family: "Loaded", format: "ttf", sizeBytes: 12, uploadedAt: 1, loadedInSession: true },
          { family: "Dormant", format: "woff2", sizeBytes: null, uploadedAt: null, loadedInSession: false },
        ],
      });
    }
  });

  it("rejects unknown verbs with INVALID_PARAMS", async () => {
    const reply = await handleFontLibraryRequest({ verb: "remove" });
    expect(reply.ok).toBe(false);
    if (!reply.ok) expect(reply.error.code).toBe("INVALID_PARAMS");
  });
});
