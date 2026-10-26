import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { ExportRunnerState } from "../services/export-runner";
import type { ArtifactOwnership } from "../services/artifact-ownership";

export interface DesktopExportTarget {
  projectId: string;
  workspaceId: string;
  exportId: string;
  revision: number;
}

export interface DesktopExportSession {
  target: DesktopExportTarget;
  projectName: string;
  outputPath?: string;
  startedAt: number;
  state: ExportRunnerState;
  ownership: ArtifactOwnership;
}

interface DesktopExportStore {
  session: DesktopExportSession | null;
  outputs: DesktopExportSession[];
  cancel: (() => void) | null;
  begin(session: DesktopExportSession, cancel: () => void): void;
  update(exportId: string, state: ExportRunnerState): void;
}

export const useDesktopExportStore = create<DesktopExportStore>()(
  persist(
    (set) => ({
      session: null,
      outputs: [],
      cancel: null,
      begin: (session, cancel) =>
        set((state) => ({
          session,
          cancel,
          outputs: [session, ...state.outputs],
        })),
      update: (exportId, state) =>
        set((current) => {
          if (current.session?.target.exportId !== exportId) return {};
          const unsuccessful = Boolean(state.error) || state.phase === "已取消";
          const session = {
            ...current.session,
            state,
            ownership: {
              ...current.session.ownership,
              ...(state.complete ? { kind: "output" as const, purpose: "Video export" } : {}),
              ...(unsuccessful
                ? {
                    kind: "work" as const,
                    purpose: state.error
                      ? "Failed video export attempt"
                      : "Cancelled video export attempt",
                  }
                : {}),
              deliveryStatus: state.complete
                ? ("delivered" as const)
                : ("pending" as const),
            },
          };
          return {
            session,
            ...(!state.isExporting
              ? {
                  outputs: [
                    session,
                    ...current.outputs.filter(
                      (item) => item.target.exportId !== exportId,
                    ),
                  ],
                }
              : {}),
          };
        }),
    }),
    {
      name: "reelterminal-export-deliveries",
      partialize: (state) => ({ outputs: state.outputs }),
    },
  ),
);
