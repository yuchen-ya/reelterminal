import type { DesktopLiveEvent } from "@reelterminal/agent-facade/desktop-protocol";
import { create } from "zustand";
import type {
  OpenReelAgentAccessMode,
  OpenReelCollabStatus,
} from "../types/global";
import { toast } from "./notification-store";
import { t } from "../i18n";

/**
 * Mirrors the desktop main-process collaboration
 * status (writer lease, access level, current action) for the access bar.
 * All IPC access is guarded so the store is a
 * harmless no-op off desktop.
 */

export type CollabStatus = OpenReelCollabStatus;
export type BackgroundTaskProgress = Extract<DesktopLiveEvent, { type: "task" }>;

interface CollabState extends CollabStatus {
  startupHintShown: boolean;
  taskProgress: Record<string, BackgroundTaskProgress>;
  applyTaskProgress: (task: BackgroundTaskProgress) => void;
  refresh: () => Promise<void>;
  enable: () => Promise<void>;
  disable: () => Promise<void>;
  setAccess: (access: OpenReelAgentAccessMode) => Promise<void>;
  applyStatus: (status: CollabStatus) => void;
  setCurrentAction: (action: string | null) => void;
}

const collabControl = () =>
  typeof window !== "undefined" && window.reelterminal?.platform === "desktop"
    ? window.reelterminal?.collabControl
    : undefined;

export const useCollabStore = create<CollabState>()((set, get) => ({
  startupHintShown: false,
  taskProgress: {},
  applyTaskProgress: (task) => {
    const previous = get().taskProgress[task.jobId];
    set((state) => ({ taskProgress: { ...state.taskProgress, [task.jobId]: task } }));
    if (previous && (previous.state === "queued" || previous.state === "running")) {
      if (task.state === "done") toast.success(t("versioning.taskDone"));
      else if (task.state === "error") toast.error(t("versioning.taskFailed"), task.error);
    }
  },
  sequence: 0,
  enabled: false,
  externalConnected: false,
  writer: null,
  access: "read-only",
  currentAction: null,

  applyStatus: (status) => {
    set((state) => {
      // IPC replies and pushes share the same main-owned sequence space.
      // Promise/event delivery may reorder them, so only captured order is
      // authoritative.
      if (status.sequence < state.sequence) {
        return state;
      }
      return { ...state, ...status };
    });
  },

  setCurrentAction: (action) => set({ currentAction: action }),

  refresh: async () => {
    const control = collabControl();
    if (!control) return;
    try {
      get().applyStatus(await control.getStatus());
    } catch {
      // Main side not up yet — keep the honest "Disabled" defaults.
    }
  },

  enable: async () => {
    const control = collabControl();
    if (!control) return;
    try {
      get().applyStatus(await control.enable());
    } catch {
      /* surfaced by the status bar staying disabled */
    }
  },

  disable: async () => {
    const control = collabControl();
    if (!control) return;
    try {
      get().applyStatus(await control.disable());
    } catch {
      /* ignore */
    }
  },

  setAccess: async (access) => {
    const control = collabControl();
    if (!control) return;
    try {
      get().applyStatus(await control.setAccess(access));
    } catch {
      /* the status remains read-only if persistence or IPC rejects */
    }
  },
}));

/**
 * Subscribes to main→renderer pushes (access status and active command
 * activity). Agent inspection evidence is intentionally not mirrored into
 * renderer state — it stays in tool responses and existing records. Unknown
 * event types (including "inspection") are safely ignored. Returns an
 * unsubscribe. No-op off desktop.
 */
export function installCollabEventListener(): () => void {
  if (typeof window === "undefined" || window.reelterminal?.platform !== "desktop") {
    return () => {};
  }
  const events = window.reelterminal?.liveEvents;
  if (!events?.onEvent) return () => {};
  return events.onEvent((evt) => {
    if (evt.type === "status") {
      const { type: _type, ...status } = evt;
      useCollabStore.getState().applyStatus(status);
    } else if (evt.type === "task") {
      useCollabStore.getState().applyTaskProgress(evt);
    } else if (evt.type === "action") {
      useCollabStore
        .getState()
        .setCurrentAction(evt.phase === "start" ? evt.verb : null);
    }
  });
}
