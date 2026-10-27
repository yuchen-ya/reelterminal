import { create } from "zustand";
import { persist } from "zustand/middleware";

interface ReviewSeenState {
  seen: Record<string, number>;
  markSeen: (key: string, revision: number) => void;
}

/** Reading state is local UI state, separate from decisions and their undo history. */
export const useReviewSeenStore = create<ReviewSeenState>()(persist((set) => ({
  seen: {},
  markSeen: (key, revision) => set(state => (state.seen[key] ?? 0) >= revision
    ? state : { seen: { ...state.seen, [key]: revision } }),
}), { name: "reelterminal.review.seen", partialize: state => ({ seen: state.seen }) }));

export const reviewSeenKey = (nodeId: string, kind: "node" | "batch" | "item", id = nodeId) => `${nodeId}:${kind}:${id}`;
