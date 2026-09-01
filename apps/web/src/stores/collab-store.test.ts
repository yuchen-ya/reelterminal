import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useCollabStore,
  installCollabEventListener,
  type CollabStatus,
} from "./collab-store";

const status = (over: Partial<CollabStatus> = {}): CollabStatus => ({
  enabled: true,
  externalConnected: false,
  writer: "embedded",
  mode: "assist",
  currentAction: null,
  ...over,
});

const mockDesktop = () => {
  const collabControl = {
    enable: vi.fn(async () => status()),
    disable: vi.fn(async () => status({ enabled: false, writer: null })),
    getStatus: vi.fn(async () => status({ enabled: false, writer: null })),
    setMode: vi.fn(async (mode: string) => status({ mode: mode as never })),
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
  (window as { openreel?: unknown }).openreel = {
    platform: "desktop",
    collabControl,
    liveEvents,
  };
  return {
    collabControl,
    liveEvents,
    emit: (evt: Record<string, unknown>) => listener?.(evt),
  };
};

describe("collab-store (ADR 0004 Decisions 6+7)", () => {
  beforeEach(() => {
    useCollabStore.getState().applyStatus({
      enabled: false,
      externalConnected: false,
      writer: null,
      mode: "assist",
      currentAction: null,
    });
  });

  afterEach(() => {
    delete (window as { openreel?: unknown }).openreel;
    vi.restoreAllMocks();
  });

  it("defaults to disabled/assist and is a no-op off desktop", async () => {
    const s = useCollabStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.mode).toBe("assist");
    await expect(s.refresh()).resolves.toBeUndefined();
    await expect(s.enable()).resolves.toBeUndefined();
    expect(useCollabStore.getState().enabled).toBe(false);
    expect(() => installCollabEventListener()).not.toThrow();
  });

  it("enable/disable/setMode route to collabControl and mirror the status", async () => {
    const { collabControl } = mockDesktop();
    await useCollabStore.getState().enable();
    expect(collabControl.enable).toHaveBeenCalledOnce();
    expect(useCollabStore.getState().enabled).toBe(true);
    expect(useCollabStore.getState().writer).toBe("embedded");

    await useCollabStore.getState().setMode("autonomous");
    expect(collabControl.setMode).toHaveBeenCalledWith("autonomous");
    expect(useCollabStore.getState().mode).toBe("autonomous");

    await useCollabStore.getState().disable();
    expect(useCollabStore.getState().enabled).toBe(false);
    expect(useCollabStore.getState().writer).toBeNull();
  });

  it("refresh mirrors getStatus", async () => {
    const { collabControl } = mockDesktop();
    await useCollabStore.getState().refresh();
    expect(collabControl.getStatus).toHaveBeenCalledOnce();
    expect(useCollabStore.getState().enabled).toBe(false);
  });

  it("applies liveEvents status + action pushes", async () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();

    emit({
      type: "status",
      enabled: true,
      externalConnected: true,
      writer: "external",
      mode: "observe",
    });
    expect(useCollabStore.getState().externalConnected).toBe(true);
    expect(useCollabStore.getState().writer).toBe("external");
    expect(useCollabStore.getState().mode).toBe("observe");

    emit({ type: "action", action: "edit.apply" });
    expect(useCollabStore.getState().currentAction).toBe("edit.apply");
    emit({ type: "action", action: null });
    expect(useCollabStore.getState().currentAction).toBeNull();

    off();
    emit({ type: "action", action: "job.status" });
    expect(useCollabStore.getState().currentAction).toBeNull();
  });
});
