import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  useCollabStore,
  installCollabEventListener,
  type CollabStatus,
} from "./collab-store";
import { useUIStore } from "./ui-store";
import { useExternalConversationStore } from "./external-conversation-store";

const status = (over: Partial<CollabStatus> = {}): CollabStatus => ({
  enabled: true,
  externalConnected: false,
  writer: "external",
  workMode: "collaborative",
  access: "write",
  currentAction: null,
  ...over,
  sequence: over.sequence ?? 1,
});

const mockDesktop = () => {
  const collabControl = {
    enable: vi.fn(async () => status()),
    disable: vi.fn(async () => status({ enabled: false, writer: null })),
    getStatus: vi.fn(async () => status({ enabled: false, writer: null })),
    setWorkMode: vi.fn(async (workMode: string) => status({ workMode: workMode as never })),
    setAccess: vi.fn(async (access: "read-only" | "write") => status({ access })),
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
    liveEvents,
    emit: (evt: Record<string, unknown>) => listener?.(evt),
  };
};

describe("collab-store (ADR 0004 Decisions 6+7)", () => {
  beforeEach(() => {
    useCollabStore.setState({
      sequence: 0,
      enabled: false,
      externalConnected: false,
      writer: null,
      workMode: "collaborative",
      access: "write",
      currentAction: null,
    });
  });

  afterEach(() => {
    delete (window as { reelterminal?: unknown }).reelterminal;
    vi.restoreAllMocks();
  });

  it("defaults to disabled/Collaborative and is a no-op off desktop", async () => {
    const s = useCollabStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.workMode).toBe("collaborative");
    expect(s.access).toBe("write");
    await expect(s.refresh()).resolves.toBeUndefined();
    await expect(s.enable()).resolves.toBeUndefined();
    expect(useCollabStore.getState().enabled).toBe(false);
    expect(() => installCollabEventListener()).not.toThrow();
  });

  it("enable/disable/mode/access changes route to main and mirror status", async () => {
    const { collabControl } = mockDesktop();
    await useCollabStore.getState().enable();
    expect(collabControl.enable).toHaveBeenCalledOnce();
    expect(useCollabStore.getState().enabled).toBe(true);
    expect(useCollabStore.getState().writer).toBe("external");

    await useCollabStore.getState().setWorkMode("autonomous");
    expect(collabControl.setWorkMode).toHaveBeenCalledWith("autonomous");
    expect(useCollabStore.getState().workMode).toBe("autonomous");

    await useCollabStore.getState().setAccess("read-only");
    expect(collabControl.setAccess).toHaveBeenCalledWith("read-only");
    expect(useCollabStore.getState().access).toBe("read-only");

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

  it("shows inspection evidence and lets the user dismiss it without changing collaboration status", () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();
    const before = useCollabStore.getState().sequence;
    emit({ type: "inspection", title: "Source", range: "3–8 s", images: ["data:image/png;base64,AA=="], limitations: ["Frames only"] });
    expect(useCollabStore.getState().inspection?.range).toBe("3–8 s");
    expect(useCollabStore.getState().sequence).toBe(before);
    useCollabStore.getState().dismissInspection();
    expect(useCollabStore.getState().inspection).toBeNull();
    off();
  });

  it("applies liveEvents status + action pushes", async () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();

    emit({
      type: "status",
      sequence: 1,
      enabled: true,
      externalConnected: true,
      writer: "external",
      workMode: "guided",
      access: "read-only",
    });
    expect(useCollabStore.getState().externalConnected).toBe(true);
    expect(useCollabStore.getState().writer).toBe("external");
    expect(useCollabStore.getState().workMode).toBe("guided");
    expect(useCollabStore.getState().access).toBe("read-only");

    emit({ type: "action", action: "edit.apply" });
    expect(useCollabStore.getState().currentAction).toBe("edit.apply");
    emit({ type: "action", action: null });
    expect(useCollabStore.getState().currentAction).toBeNull();

    off();
    emit({ type: "action", action: "job.status" });
    expect(useCollabStore.getState().currentAction).toBeNull();
  });

  it("ignores a stale status push that arrives after a newer disable acknowledgement", () => {
    const { emit } = mockDesktop();
    const off = installCollabEventListener();

    useCollabStore.getState().applyStatus(
      status({ sequence: 12, enabled: false, writer: null }),
    );
    emit({
      type: "status",
      ...status({ sequence: 11, enabled: true, writer: "external" }),
    });

    expect(useCollabStore.getState()).toMatchObject({
      sequence: 12,
      enabled: false,
      writer: null,
    });
    off();
  });

  it("switches work mode without touching floating geometry or conversation display", async () => {
    mockDesktop();
    useUIStore.getState().setPanelGeometry("externalAgent", {
      x: 48,
      y: 72,
      width: 520,
      height: 640,
    });
    const conversation = useExternalConversationStore.getState().state;

    await useCollabStore.getState().setWorkMode("guided");

    expect(useUIStore.getState().panels.externalAgent).toMatchObject({
      x: 48,
      y: 72,
      width: 520,
      height: 640,
    });
    expect(useExternalConversationStore.getState().state).toBe(conversation);
  });
});
