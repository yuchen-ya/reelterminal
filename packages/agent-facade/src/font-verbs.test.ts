/**
 * font.* verb tests: headless honesty, live bridge forwarding, param
 * validation (exactly-one-of inputs, decoded size budget, path
 * containment), read/write gating, dedup disclosure, and renderer error
 * mapping. The GUI-visible registration itself lives renderer-side
 * (font-options.ts) and is covered by the web package's own tests.
 */
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";
import { createLiveFacade, type LiveAgentFacade } from "./live-session";
import { LiveWriterLease } from "./live-lease";
import type { LiveProjectStore } from "./live-store";
import type {
  FontLibraryBridge,
  FontLibraryBridgeRequest,
  FontLibraryBridgeReply,
} from "./font-library";
import type { Project } from "@openreel/core/types/project";
import { createEmptyProject } from "./project-factory";

/* ------------------------- fakes ------------------------- */

class FakeStore implements LiveProjectStore {
  project: Project = createEmptyProject("Live Demo");
  revision = 3;

  async getIdentity() {
    return { projectId: this.project.id, projectName: this.project.name, windowId: "w" };
  }
  async getState() {
    return { project: structuredClone(this.project), revision: this.revision };
  }
  async getContext(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async getProjectChanges(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async getHistory(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async historyControl(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async editorControl(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async applyActions(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async importMedia(): Promise<never> {
    throw new Error("not needed in these tests");
  }
  async requestSave() {
    return { revision: this.revision };
  }
}

/** Records every request; replies from a scripted map or a default. */
class FakeFontBridge {
  readonly requests: FontLibraryBridgeRequest[] = [];
  reply: (req: FontLibraryBridgeRequest) => FontLibraryBridgeReply = () => ({
    ok: true,
    result: { fontFamily: "Bar", format: "ttf", sizeBytes: 12 },
  });

  asBridge(): FontLibraryBridge {
    return async (request) => {
      this.requests.push(request);
      return this.reply(request);
    };
  }
}

let artifactRoot: string;
let store: FakeStore;
let lease: LiveWriterLease;
let bridge: FakeFontBridge;

function facade(opts?: {
  fontLibrary?: FontLibraryBridge;
  mediaRoots?: readonly string[];
  access?: "read-only" | "write";
}): LiveAgentFacade {
  return createLiveFacade({
    store,
    lease,
    sessionId: "agent-1",
    workMode: "collaborative",
    access: opts?.access ?? "write",
    artifactRoot,
    ...(opts?.mediaRoots ? { mediaRoots: opts.mediaRoots } : {}),
    ...(opts?.fontLibrary ? { fontLibrary: opts.fontLibrary } : {}),
  });
}

beforeEach(async () => {
  artifactRoot = await mkdtemp(path.join(tmpdir(), "facade-font-"));
  store = new FakeStore();
  lease = new LiveWriterLease();
  bridge = new FakeFontBridge();
});

afterEach(async () => {
  await rm(artifactRoot, { recursive: true, force: true });
});

/* ------------------------- tests ------------------------- */

describe("font.* headless honesty", () => {
  it("reports UNSUPPORTED for font.list after accepting empty params", async () => {
    const headless = createAgentFacade();
    const res = await headless["font.list"]();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNSUPPORTED");
      expect(res.error.message).toContain("live desktop sessions");
    }
  });

  it("reports UNSUPPORTED for font.upload with valid params", async () => {
    const headless = createAgentFacade();
    const res = await headless["font.upload"]({ dataBase64: "AAAA" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNSUPPORTED");
      expect(res.error.message).toContain("live desktop sessions");
    }
  });

  it("validates params BEFORE the honesty error", async () => {
    const headless = createAgentFacade();
    const res = await headless["font.upload"]({ filePath: "" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
  });
});

describe("font.* live bridge forwarding", () => {
  it("reports UNSUPPORTED when the host provides no font bridge", async () => {
    const live = facade({ mediaRoots: [] });
    const res = await live["font.list"]();
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("UNSUPPORTED");
      expect(res.error.message).toContain("font-library bridge");
    }
  });

  it("font.list forwards no params and relays the renderer reply", async () => {
    bridge.reply = () => ({
      ok: true,
      result: {
        fonts: [
          {
            family: "Bar",
            format: "ttf",
            sizeBytes: 12,
            uploadedAt: 1,
            loadedInSession: true,
          },
        ],
      },
    });
    const live = facade({ fontLibrary: bridge.asBridge() });
    const res = await live["font.list"]();
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.fonts).toHaveLength(1);
      expect(res.value.fonts[0].family).toBe("Bar");
    }
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0]).toEqual({ verb: "list", params: {} });
  });

  it("font.upload reads a media-root file and forwards its bytes", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    // Signature bytes are the renderer's concern; the facade forwards them.
    const bytes = new Uint8Array([0x00, 0x01, 0x00, 0x00, 0x11, 0x22]);
    const fontPath = path.join(mediaRoot, "Bar.ttf");
    await writeFile(fontPath, bytes);

    const live = facade({ fontLibrary: bridge.asBridge(), mediaRoots: [mediaRoot] });
    const res = await live["font.upload"]({ filePath: fontPath });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.fontFamily).toBe("Bar");
      expect(res.value.deduped).toBe(false);
    }
    expect(bridge.requests).toHaveLength(1);
    expect(bridge.requests[0].verb).toBe("upload");
    const uploadParams = bridge.requests[0].params as {
      name?: string;
      data?: ArrayBuffer;
    };
    const data = uploadParams.data as ArrayBuffer;
    expect(data).toBeInstanceOf(ArrayBuffer);
    expect(data.byteLength).toBe(bytes.byteLength);
    expect(new Uint8Array(data)[0]).toBe(0x00);
    // The family base name is pre-stripped, so the renderer and the
    // deduped flag agree on the same string.
    expect(uploadParams.name).toBe("Bar");
  });

  it("reports deduped when the renderer assigned a suffixed family", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const fontPath = path.join(mediaRoot, "Bar.ttf");
    await writeFile(fontPath, new Uint8Array([0x00, 0x01, 0x00, 0x00]));
    bridge.reply = () => ({
      ok: true,
      result: { fontFamily: "Bar 2", format: "ttf", sizeBytes: 4 },
    });
    const live = facade({ fontLibrary: bridge.asBridge(), mediaRoots: [mediaRoot] });
    const res = await live["font.upload"]({ filePath: fontPath });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.value.fontFamily).toBe("Bar 2");
      expect(res.value.deduped).toBe(true);
    }
  });

  it("font.upload accepts dataBase64 bytes and an explicit name", async () => {
    const live = facade({ fontLibrary: bridge.asBridge() });
    const res = await live["font.upload"]({ name: "Baz", dataBase64: "AAEAAAAB" });
    expect(res.ok).toBe(true);
    const params = bridge.requests[0].params as { name: string; data: ArrayBuffer };
    expect(params.name).toBe("Baz");
    expect(params.data.byteLength).toBe(6);
  });

  it("maps renderer INVALID_PARAMS errors verbatim", async () => {
    bridge.reply = () => ({
      ok: false,
      error: { code: "INVALID_PARAMS", message: "not a valid .ttf font" },
    });
    const live = facade({ fontLibrary: bridge.asBridge() });
    const res = await live["font.upload"]({ dataBase64: "AAAA" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_PARAMS");
      expect(res.error.message).toContain("not a valid .ttf font");
    }
  });
});

describe("font.* param validation and containment", () => {
  it("rejects missing and duplicate inputs with INVALID_PARAMS", async () => {
    const live = facade({ fontLibrary: bridge.asBridge() });
    for (const params of [{ name: "x" }, { filePath: "/a.ttf", dataBase64: "AA" }]) {
      const res = await live["font.upload"](params as never);
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe("INVALID_PARAMS");
        expect(res.error.message).toContain("exactly one of filePath or dataBase64");
      }
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it("rejects malformed base64", async () => {
    const live = facade({ fontLibrary: bridge.asBridge() });
    const res = await live["font.upload"]({ dataBase64: "not!!base64" });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_PARAMS");
      expect(res.error.message).toContain("base64");
    }
  });

  it("rejects files above the decoded byte budget", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const bigPath = path.join(mediaRoot, "Huge.ttf");
    await writeFile(bigPath, new Uint8Array(10 * 1024 * 1024 + 1));
    const live = facade({ fontLibrary: bridge.asBridge(), mediaRoots: [mediaRoot] });
    const res = await live["font.upload"]({ filePath: bigPath });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe("INVALID_PARAMS");
      expect(res.error.message).toContain("limit is 10485760 bytes");
    }
    expect(bridge.requests).toHaveLength(0);
  });

  it("rejects paths outside the configured media roots", async () => {
    const mediaRoot = await mkdtemp(path.join(artifactRoot, "media-"));
    const outside = await mkdtemp(path.join(artifactRoot, "outside-"));
    const fontPath = path.join(outside, "Evil.ttf");
    await writeFile(fontPath, new Uint8Array([0x00, 0x01, 0x00, 0x00]));
    const live = facade({ fontLibrary: bridge.asBridge(), mediaRoots: [mediaRoot] });
    const res = await live["font.upload"]({ filePath: fontPath });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    expect(bridge.requests).toHaveLength(0);
  });

  it("rejects non-absolute paths and missing files", async () => {
    const live = facade({ fontLibrary: bridge.asBridge(), mediaRoots: [artifactRoot] });
    for (const filePath of ["relative.ttf", path.join(artifactRoot, "absent.ttf")]) {
      const res = await live["font.upload"]({ filePath });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("INVALID_PARAMS");
    }
  });
});

describe("font.* gating", () => {
  it("font.upload is a write verb: read-only access is FORBIDDEN", async () => {
    const live = facade({ fontLibrary: bridge.asBridge(), access: "read-only" });
    const res = await live["font.upload"]({ dataBase64: "AAAA" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.code).toBe("FORBIDDEN");
    expect(bridge.requests).toHaveLength(0);
  });

  it("font.list is readable without the writer lease", async () => {
    const live = facade({ fontLibrary: bridge.asBridge(), access: "read-only" });
    const res = await live["font.list"]();
    expect(res.ok).toBe(true);
  });
});
