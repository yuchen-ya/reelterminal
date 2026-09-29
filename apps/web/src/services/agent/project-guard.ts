import { useProjectStore } from "../../stores/project-store";
export interface ProjectGuard { readonly expectedProjectId?: string; readonly expectedProjectEpoch?: string; }
// A new ActionHistory is installed for every create/load, including the same project ID.
const projectEpochs = new WeakMap<object, string>();
export function currentProjectEpoch(): string {
  const history = useProjectStore.getState().actionHistory;
  let epoch = projectEpochs.get(history);
  if (!epoch) { epoch = crypto.randomUUID(); projectEpochs.set(history, epoch); }
  return epoch;
}
export function projectGuardError(req: ProjectGuard): { ok: false; error: {code: "CONFLICT"; message: string} } | null {
  const store = useProjectStore.getState();
  if ((req.expectedProjectId !== undefined && (!store.hasOpenProject || req.expectedProjectId !== store.project.id)) ||
      (req.expectedProjectEpoch !== undefined && req.expectedProjectEpoch !== currentProjectEpoch())) {
    return { ok: false, error: { code: "CONFLICT", message: "The open project changed; read context and rebuild the request." } };
  }
  return null;
}


export function projectLedgerScope(): string {
  return `${useProjectStore.getState().project.id}:${currentProjectEpoch()}`;
}
