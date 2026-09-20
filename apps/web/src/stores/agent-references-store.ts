import { create } from "zustand";
import type { LiveEditorReference, LiveEditorReferenceKind } from "@reelterminal/agent-facade/live-store";

/** A point-in-time target that can be marked for an agent. */
export interface AgentReferenceTarget {
  readonly kind: LiveEditorReferenceKind;
  readonly entityId: string;
  readonly label: string;
  readonly timing: LiveEditorReference["timing"];
  /** Timeline order used only to make multi-select assignment deterministic. */
  readonly trackOrder: number;
}

export interface MarkedAgentReference extends LiveEditorReference {
  /** The stable number displayed to a human and used as the map key in context. */
  readonly number: number;
}

interface AgentReferencesState {
  /** Kept as a numeric-keyed record so the serialized context is a number map. */
  readonly references: Readonly<Record<string, MarkedAgentReference>>;
  /** Never decremented except when the editor session is explicitly reset. */
  readonly nextNumber: number;
  mark: (targets: readonly AgentReferenceTarget[], revisionAtMark: number) => MarkedAgentReference[];
  syncStale: (activeTargets: readonly AgentReferenceTarget[]) => void;
  reset: () => void;
}

const identityKey = (reference: Pick<LiveEditorReference, "kind" | "entityId">): string =>
  `${reference.kind}:${reference.entityId}`;

const targetSort = (a: AgentReferenceTarget, b: AgentReferenceTarget): number => {
  const aStart = a.timing.startSeconds ?? Number.POSITIVE_INFINITY;
  const bStart = b.timing.startSeconds ?? Number.POSITIVE_INFINITY;
  return (
    aStart - bStart ||
    a.trackOrder - b.trackOrder ||
    a.entityId.localeCompare(b.entityId) ||
    a.kind.localeCompare(b.kind)
  );
};

/** De-duplicate and sort targets before assigning numbers. */
export function sortAgentReferenceTargets(
  targets: readonly AgentReferenceTarget[],
): AgentReferenceTarget[] {
  const unique = new Map<string, AgentReferenceTarget>();
  for (const target of targets) {
    if (!target.entityId.trim()) continue;
    const key = identityKey(target);
    if (!unique.has(key)) unique.set(key, target);
  }
  return [...unique.values()].sort(targetSort);
}

export const useAgentReferencesStore = create<AgentReferencesState>()((set, get) => ({
  references: {},
  nextNumber: 1,

  mark: (targets, revisionAtMark) => {
    const sortedTargets = sortAgentReferenceTargets(targets);
    if (sortedTargets.length === 0) return [];

    const state = get();
    const references: Record<string, MarkedAgentReference> = {
      ...state.references,
    };
    let nextNumber = state.nextNumber;
    let changed = false;
    const marked: MarkedAgentReference[] = [];

    for (const target of sortedTargets) {
      const existing = Object.values(references).find(
        (reference) => identityKey(reference) === identityKey(target),
      );
      if (existing) {
        marked.push(existing);
        continue;
      }

      const number = nextNumber++;
      const reference: MarkedAgentReference = {
        ref: `A${number}`,
        number,
        kind: target.kind,
        entityId: target.entityId,
        // Labels may contain user-authored media names or caption text. Keep
        // those verbatim; only built-in fallback labels are localized when
        // the target is constructed.
        label: target.label,
        timing: {
          startSeconds: target.timing.startSeconds,
          endSeconds: target.timing.endSeconds,
        },
        revisionAtMark,
        stale: false,
      };
      references[String(number)] = reference;
      marked.push(reference);
      changed = true;
    }

    if (changed) {
      set({ references, nextNumber });
    }
    return marked.sort((a, b) => a.number - b.number);
  },

  syncStale: (activeTargets) => {
    const activeKeys = new Set(
      activeTargets.map((target) => identityKey(target)),
    );
    const state = get();
    const references: Record<string, MarkedAgentReference> = {
      ...state.references,
    };
    let changed = false;

    for (const [number, reference] of Object.entries(references)) {
      if (reference.stale || activeKeys.has(identityKey(reference))) continue;
      references[number] = { ...reference, stale: true };
      changed = true;
    }

    if (changed) set({ references });
  },

  reset: () => {
    if (Object.keys(get().references).length === 0 && get().nextNumber === 1) return;
    set({ references: {}, nextNumber: 1 });
  },
}));

export function getMarkedAgentReferences(): MarkedAgentReference[] {
  return Object.values(useAgentReferencesStore.getState().references).sort(
    (a, b) => a.number - b.number,
  );
}

export function getAgentReferenceForEntity(
  kind: LiveEditorReferenceKind,
  entityId: string,
): MarkedAgentReference | undefined {
  return getMarkedAgentReferences().find(
    (reference) =>
      reference.kind === kind && reference.entityId === entityId,
  );
}
