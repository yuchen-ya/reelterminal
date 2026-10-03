import { afterEach, describe, expect, it, vi } from "vitest";
import type { Project } from "@reelterminal/core";
import { createEmptyProject } from "./project-helpers";

const { loadFileHandle, loadDirectoryHandle, getFile, replaceMediaAsset } =
  vi.hoisted(() => ({
    loadFileHandle: vi.fn(),
    loadDirectoryHandle: vi.fn(),
    getFile: vi.fn(),
    replaceMediaAsset: vi.fn(),
  }));

vi.mock("../../services/media-storage", () => ({
  loadFileHandle,
  loadDirectoryHandle,
}));

vi.mock("../../services/project-media-gc", () => ({
  attachProjectMediaGc: vi.fn(),
  flushProjectMediaBytes: vi.fn(),
  sweepOrphanProjectMedia: vi.fn(),
}));

vi.mock("../../services/project-manager", () => ({
  projectManager: { clearCurrentFileHandle: vi.fn() },
}));

vi.mock("../engine-store", () => ({
  useEngineStore: {
    getState: () => ({
      getTitleEngine: () => null,
      getGraphicsEngine: () => null,
    }),
  },
}));

describe("project lifecycle media relinking", () => {
  const hadFileHandleConstructor = "FileSystemFileHandle" in window;
  const previousFileHandleConstructor = window.FileSystemFileHandle;

  afterEach(() => {
    if (hadFileHandleConstructor) {
      Object.defineProperty(window, "FileSystemFileHandle", {
        configurable: true,
        value: previousFileHandleConstructor,
      });
    } else {
      Reflect.deleteProperty(window, "FileSystemFileHandle");
    }
    vi.clearAllMocks();
  });

  it("does not relink a file after the project session changes while getFile is pending", async () => {
    Object.defineProperty(window, "FileSystemFileHandle", {
      configurable: true,
      value: class FileSystemFileHandle {},
    });

    let finishGetFile!: (file: File) => void;
    const getFileGate = new Promise<File>((resolve) => {
      finishGetFile = resolve;
    });
    getFile.mockReturnValueOnce(getFileGate);
    loadFileHandle.mockResolvedValueOnce({ getFile });
    replaceMediaAsset.mockResolvedValue({ success: true, actionId: "replacement" });

    const mediaId = "shared-media-id";
    const placeholder = {
      id: mediaId,
      name: "source.mp4",
      type: "video" as const,
      fileHandle: null,
      blob: null,
      metadata: {
        duration: 1,
        width: 640,
        height: 360,
        frameRate: 30,
        codec: "h264",
        sampleRate: 0,
        channels: 0,
        fileSize: 100,
      },
      thumbnailUrl: null,
      waveformData: null,
      isPlaceholder: true,
      sourceFile: {
        name: "source.mp4",
        size: 100,
        lastModified: 1,
        folder: "Assets",
      },
    };
    const incoming: Project = {
      ...createEmptyProject("Project A"),
      mediaLibrary: { items: [placeholder] },
    };
    const nextProject: Project = {
      ...createEmptyProject("Reopened project"),
      id: incoming.id,
      mediaLibrary: { items: [placeholder] },
    };

    let state: {
      project: Project;
      actionExecutor: unknown;
      replaceMediaAsset: typeof replaceMediaAsset;
    } = {
      project: incoming,
      actionExecutor: {},
      replaceMediaAsset,
    };
    const get = () => state;
    const set = (update: Partial<typeof state>) => {
      state = { ...state, ...update };
    };
    const { createProjectLifecycleSlice } = await import("./lifecycle-slice");
    const slice = createProjectLifecycleSlice(
      set as Parameters<typeof createProjectLifecycleSlice>[0],
      get as unknown as Parameters<typeof createProjectLifecycleSlice>[1],
      {
        syncProjectEffectsBridge: vi.fn(),
        syncProjectTransitionsBridge: vi.fn(),
      },
    );

    slice.loadProject(incoming);
    await vi.waitFor(() => expect(getFile).toHaveBeenCalledTimes(1));

    state = { ...state, project: nextProject, actionExecutor: {} };
    finishGetFile(new File(["source"], "source.mp4", { type: "video/mp4" }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(state.project.id).toBe(nextProject.id);
    expect(replaceMediaAsset).not.toHaveBeenCalled();
  });
});
