import { useProjectStore } from "../../stores/project-store";
export interface ProjectGuard {
  readonly expectedProjectId?: string;
  readonly expectedProjectEpoch?: string;
  readonly targetProjectId?: string;
  readonly targetWorkspaceId?: string;
  readonly targetWorkspaceInstanceId?: string;
}
// One renderer-runtime generation: foreground switches do not change it, but
// reloading the renderer creates a new value and rejects stale requests.
const rendererEpoch = crypto.randomUUID();
export function currentProjectEpoch(): string {
  return rendererEpoch;
}
export function projectGuardError(req: ProjectGuard): { ok: false; error: {code: "CONFLICT"; message: string} } | null {
  const store = useProjectStore.getState();
  if ((req.expectedProjectId !== undefined && (!store.hasOpenProject || req.expectedProjectId !== store.project.id)) ||
      (req.expectedProjectEpoch !== undefined && req.expectedProjectEpoch !== currentProjectEpoch())) {
    return { ok: false, error: { code: "CONFLICT", message: "The open project changed; read context and rebuild the request." } };
  }
  return null;
}


export function projectLedgerScope(target?: { readonly projectId?: string; readonly workspaceId?: string }): string {
  const store = useProjectStore.getState();
  const projectId = target?.projectId ?? (store.hasOpenProject ? store.project.id : "unresolved");
  const workspaceId = target?.workspaceId ?? store.workspaceId ?? "default";
  return `${projectId}:${workspaceId}:${currentProjectEpoch()}`;
}
