import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useCollabStore,
  installCollabEventListener,
  type CollabStatus,
} from "./collab-store";

const status = (over: Partial<CollabStatus> = {}): CollabStatus => ({
  sequence: 1,
  enabled: true,
  externalConnected: false,
  writer: null,
  access: "write",
  currentAction: null,
  ...over,
});

const mockDesktop = () => {
  const collabControl = {
    enable: vi.fn(async () => status()),
    disable: vi.fn(async () => status({ enabled: false })),
    getStatus: vi.fn(async () => status({ sequence: 2, enabled: false })),
    setAccess: vi.fn(async (access: "read-only" | "write") =>
      status({ sequence: 3, access }),
    ),
  };
  let listener: ((evt: Record<string, unknown>) => void) | null = null;
  const liveEvents = {
    onEvent: vi.fn((cb: (evt: Record<string, unknown>) => void) => {
      listener = cb;
      return () => {
        listener = null;
      };
    }),
  };
  (window as { reelterminal?: unknown }).reelterminal = {
    platform: "desktop",
    collabControl,
    liveEvents,
  };
  return {
    collabControl,
    emit: (evt: Record<string, unknown>) => listener?.(evt),
  };
};

describe("collab-store access status", () => {
  beforeEach(() => {
    useCollabStore.setState({
      sequence: 0,
      enabled: false,
      externalConnected: false,
      writer: null,
      access: "write",
      currentAction: null,
      taskProgress: {},
    });
  });

  it("keeps background task progress and completion separate from the current command", () => {
    const desktop = mockDesktop();
    const unsubscribe = installCollabEventListener();
    desktop.emit({ type: "action", phase: "start", verb: "node.save" });
    desktop.emit({ type: "task", jobId: "export-b", kind: "export", projectId: "project-b", workspaceId: "trial-b", sourceRevision: 4, state: "running", progress: { phase: "rendering", percent: 35 } });
    expect(useCollabStore.getState().taskProgress["export-b"]).toMatchObject({ projectId: "project-b", workspaceId: "trial-b", sourceRevision: 4, progress: { percent: 35 } });
    expect(useCollabStore.getState().currentAction).toBe("node.save");
    desktop.emit({ type: "task", jobId: "export-b", kind: "export", projectId: "project-b", workspaceId: "trial-b", sourceRevision: 4, state: "done", progress: { phase: "complete", percent: 100 } });
    expect(useCollabStore.getState().taskProgress["export-b"].state).toBe("done");
    expect(useCollabStore.getState().currentAction).toBe("node.save");
    unsubscribe();
  });

  afterEach(() => {
    delete (window as { reelterminal?: unknown }).reelterminal;
    vi.restoreAllMocks();
  });

  it("defaults to unavailable and is a no-op off desktop", async () => {
    const state = useCollabStore.getState();
    expect(state.enabled).toBe(false);
    expect(state.access).toBe("write");
    await expect(state.refresh()).resolves.toBeUndefined();
    await expect(state.enable()).resolves.toBeUndefined();
    expect(useCollabStore.getState().enabled).toBe(false);
    expect(() => installCollabEventListener()).not.toThrow();
  });

  it("refreshes status and applies access changes from the desktop bridge", async () => {
    const { collabControl } = mockDesktop();
    await useCollabStore.getState().refresh();
    expect(collabControl.getStatus).toHaveBeenCalledOnce();
    expect(useCollabStore.getState()).toMatchObject({
      sequence: 2,
      enabled: false,
      access: "write",
    });

    await useCollabStore.getState().setAccess("read-only");
    expect(collabControl.setAccess).toHaveBeenCalledWith("read-only");
    expect(useCollabStore.getState().access).toBe("read-only");
  });

  it("ignores inspection pushes so agent evidence never notifies the UI", () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();
    expect(() =>
      emit({
        type: "inspection",
        title: "Source",
        range: "3–8 s",
        images: ["data:image/png;base64,AA=="],
        limitations: ["Frames only"],
      }),
    ).not.toThrow();
    const state = useCollabStore.getState();
    expect(state).not.toHaveProperty("inspection");
    // The unknown push must not leak into access status either.
    expect(state.enabled).toBe(false);
    expect(state.sequence).toBe(0);
    off();
  });

  it("tracks command activity and clears it when the operation ends", () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();
    emit({ type: "action", phase: "start", verb: "edit.apply" });
    expect(useCollabStore.getState().currentAction).toBe("edit.apply");
    emit({ type: "action", phase: "end", verb: "edit.apply", ok: true, summary: "Applied" });
    expect(useCollabStore.getState().currentAction).toBeNull();
    off();
    emit({ type: "action", phase: "start", verb: "job.status" });
    expect(useCollabStore.getState().currentAction).toBeNull();
  });

  it("ignores a stale status push that arrives after a newer reply", () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();
    useCollabStore.getState().applyStatus(status({ sequence: 12, enabled: false }));
    emit({ type: "status", ...status({ sequence: 11, enabled: true }) });
    expect(useCollabStore.getState()).toMatchObject({ sequence: 12, enabled: false });
    off();
  });
});
