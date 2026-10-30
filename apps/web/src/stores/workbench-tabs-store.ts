import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface WorkbenchTab {
  kind: "review" | "board";
  id: string;
  name: string;
}

export const workbenchTabKey = (tab: Pick<WorkbenchTab, "kind" | "id">) => `${tab.kind}:${tab.id}`;

interface WorkbenchTabsState {
  tabs: WorkbenchTab[];
  activeKey: string | null;
  open: (tab: WorkbenchTab) => void;
  activate: (key: string) => void;
  close: (key: string) => void;
  move: (source: string, destination: string) => void;
  rename: (key: string, name: string) => void;
}

/** View identity only. Private board content never becomes an Agent target. */
export const useWorkbenchTabsStore = create<WorkbenchTabsState>()(persist((set) => ({
  tabs: [],
  activeKey: null,
  open: (tab) => set(state => {
    const key = workbenchTabKey(tab);
    return { tabs: state.tabs.some(row => workbenchTabKey(row) === key)
      ? state.tabs.map(row => workbenchTabKey(row) === key ? tab : row)
      : [...state.tabs, tab], activeKey: key };
  }),
  activate: (key) => set(state => state.tabs.some(tab => workbenchTabKey(tab) === key) ? { activeKey: key } : state),
  close: (key) => set(state => {
    const index = state.tabs.findIndex(tab => workbenchTabKey(tab) === key);
    const tabs = state.tabs.filter(tab => workbenchTabKey(tab) !== key);
    return { tabs, activeKey: state.activeKey === key ? (tabs[Math.min(index, tabs.length - 1)] ? workbenchTabKey(tabs[Math.min(index, tabs.length - 1)]) : null) : state.activeKey };
  }),
  move: (source, destination) => set(state => {
    const from = state.tabs.findIndex(tab => workbenchTabKey(tab) === source);
    const to = state.tabs.findIndex(tab => workbenchTabKey(tab) === destination);
    if (from < 0 || to < 0 || from === to) return state;
    const tabs = [...state.tabs];
    tabs.splice(to, 0, tabs.splice(from, 1)[0]);
    return { tabs };
  }),
  rename: (key, name) => set(state => ({ tabs: state.tabs.map(tab => workbenchTabKey(tab) === key ? { ...tab, name } : tab) })),
}), { name: "reelterminal.workbench.tabs", partialize: ({ tabs, activeKey }) => ({ tabs, activeKey }) }));
