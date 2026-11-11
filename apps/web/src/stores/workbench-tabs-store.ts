import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface WorkbenchTab {
  kind: "review" | "board" | "folder";
  id: string;
  name: string;
  root?: string;
}

export const workbenchTabKey = (tab: Pick<WorkbenchTab, "kind" | "id">) => `${tab.kind}:${tab.id}`;

interface WorkbenchTabsState {
  tabs: WorkbenchTab[];
  activeKey: string | null;
  recentFolders: WorkbenchTab[];
  open: (tab: WorkbenchTab) => void;
  activate: (key: string) => void;
  close: (key: string) => void;
  move: (source: string, destination: string) => void;
  rename: (key: string, name: string) => void;
  removeFolder: (id: string) => void;
}

/** View identity only. Private board content never becomes an Agent target. */
export const useWorkbenchTabsStore = create<WorkbenchTabsState>()(persist((set) => ({
  tabs: [],
  activeKey: null,
  recentFolders: [],
  open: (tab) => set(state => {
    // Independent batch tasks are retired. This does not delete their data.
    if (tab.kind === "review") return state;
    const key = workbenchTabKey(tab);
    return { tabs: state.tabs.some(row => workbenchTabKey(row) === key)
      ? state.tabs.map(row => workbenchTabKey(row) === key ? tab : row)
      : [...state.tabs, tab], activeKey: key,
      recentFolders: tab.kind === "folder"
        ? [tab, ...state.recentFolders.filter(row => row.id !== tab.id)].slice(0, 20)
        : state.recentFolders };
  }),
  activate: (key) => set(state => state.tabs.some(tab => tab.kind !== "review" && workbenchTabKey(tab) === key) ? { activeKey: key } : state),
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
  rename: (key, name) => set(state => {
    const needsRename = (tab: WorkbenchTab) => workbenchTabKey(tab) === key && tab.name !== name;
    if (!state.tabs.some(needsRename) && !state.recentFolders.some(needsRename)) return state;
    return {
      tabs: state.tabs.map(tab => needsRename(tab) ? { ...tab, name } : tab),
      recentFolders: state.recentFolders.map(tab => needsRename(tab) ? { ...tab, name } : tab),
    };
  }),
  removeFolder: (id) => set(state => {
    const key = workbenchTabKey({ kind: "folder", id });
    const index = state.tabs.findIndex(tab => workbenchTabKey(tab) === key);
    const tabs = state.tabs.filter(tab => workbenchTabKey(tab) !== key);
    const recentFolders = state.recentFolders.filter(row => row.id !== id);
    const activeKey = state.activeKey === key
      ? (tabs[Math.min(index, tabs.length - 1)] ? workbenchTabKey(tabs[Math.min(index, tabs.length - 1)]) : null)
      : state.activeKey;
    return { tabs, activeKey, recentFolders };
  }),
}), {
  name: "reelterminal.workbench.tabs",
  partialize: ({ tabs, activeKey, recentFolders }) => ({ tabs, activeKey, recentFolders }),
  merge: (persisted, current) => {
    const saved = persisted as Partial<WorkbenchTabsState> | undefined;
    const tabs = (saved?.tabs ?? []).filter(tab => tab.kind !== "review");
    const activeKey = tabs.some(tab => workbenchTabKey(tab) === saved?.activeKey)
      ? saved!.activeKey! : null;
    const recentFolders = (saved?.recentFolders ?? tabs).filter(tab => tab.kind === "folder");
    return { ...current, tabs, activeKey, recentFolders };
  },
}));
