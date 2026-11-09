import { beforeEach, expect, it } from "vitest";
import { useWorkbenchTabsStore } from "./workbench-tabs-store";

beforeEach(() => {
  useWorkbenchTabsStore.setState({ tabs: [], activeKey: null, recentFolders: [] });
  localStorage.clear();
});

it("opens each object once, focuses repeated opens, and closes views independently", () => {
  const store = useWorkbenchTabsStore.getState();
  store.open({ kind: "review", id: "a", name: "Task A" });
  store.open({ kind: "board", id: "a", name: "Private board" });
  store.open({ kind: "review", id: "a", name: "Renamed task" });
  expect(useWorkbenchTabsStore.getState().tabs.map(tab => tab.name)).toEqual(["Renamed task", "Private board"]);
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("review:a");
  store.close("review:a");
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("board:a");
  store.close("board:a");
  expect(useWorkbenchTabsStore.getState()).toMatchObject({ tabs: [], activeKey: null });
  store.open({ kind: "review", id: "a", name: "Renamed task" });
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("review:a");
});

it("restores folders and boards while leaving old review tabs behind", async () => {
  const store = useWorkbenchTabsStore.getState();
  store.open({ kind: "review", id: "a", name: "Task" });
  store.open({ kind: "board", id: "b", name: "Board" });
  store.open({ kind: "folder", id: "C:/task", root: "C:/task", name: "Folder" });
  store.rename("folder:C:/task", "Renamed folder task");
  expect(useWorkbenchTabsStore.getState().recentFolders[0].name).toBe("Renamed folder task");
  store.move("folder:C:/task", "review:a");
  store.activate("board:b");
  const saved = localStorage.getItem("reelterminal.workbench.tabs")!;
  useWorkbenchTabsStore.setState({ tabs: [], activeKey: null, recentFolders: [] });
  localStorage.setItem("reelterminal.workbench.tabs", saved);
  await useWorkbenchTabsStore.persist.rehydrate();
  expect(useWorkbenchTabsStore.getState().tabs.map(tab => `${tab.kind}:${tab.id}`)).toEqual(["folder:C:/task", "board:b"]);
  expect(useWorkbenchTabsStore.getState().recentFolders.map(tab => tab.root)).toEqual(["C:/task"]);
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("board:b");
});

 it("keeps a closed folder in recent tasks and does not restore an old active review", async () => {
  const store = useWorkbenchTabsStore.getState();
  store.open({ kind: "folder", id: "C:/task", root: "C:/task", name: "Task" });
  store.close("folder:C:/task");
  store.open({ kind: "review", id: "old", name: "Old task" });
  const saved = localStorage.getItem("reelterminal.workbench.tabs")!;
  useWorkbenchTabsStore.setState({ tabs: [], activeKey: null, recentFolders: [] });
  localStorage.setItem("reelterminal.workbench.tabs", saved);
  await useWorkbenchTabsStore.persist.rehydrate();
  expect(useWorkbenchTabsStore.getState().activeKey).toBeNull();
  expect(useWorkbenchTabsStore.getState().tabs).toEqual([]);
  expect(useWorkbenchTabsStore.getState().recentFolders.map(tab => tab.root)).toEqual(["C:/task"]);
});

it("removes folder from recent tasks and closes open folder tab cleanly", () => {
  const store = useWorkbenchTabsStore.getState();
  store.open({ kind: "board", id: "b1", name: "Board" });
  store.open({ kind: "folder", id: "folder-1", root: "C:/folder-1", name: "Folder 1" });
  store.open({ kind: "folder", id: "folder-2", root: "C:/folder-2", name: "Folder 2" });
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("folder:folder-2");
  expect(useWorkbenchTabsStore.getState().recentFolders.map(f => f.id)).toEqual(["folder-2", "folder-1"]);

  // Remove active folder tab
  store.removeFolder("folder-2");
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("folder:folder-1");
  expect(useWorkbenchTabsStore.getState().tabs.map(t => t.id)).toEqual(["b1", "folder-1"]);
  expect(useWorkbenchTabsStore.getState().recentFolders.map(f => f.id)).toEqual(["folder-1"]);

  // Close folder-1 tab but leave in recent, then removeFolder when tab is closed
  store.close("folder:folder-1");
  expect(useWorkbenchTabsStore.getState().tabs.map(t => t.id)).toEqual(["b1"]);
  expect(useWorkbenchTabsStore.getState().recentFolders.map(f => f.id)).toEqual(["folder-1"]);
  store.removeFolder("folder-1");
  expect(useWorkbenchTabsStore.getState().recentFolders).toEqual([]);
  expect(useWorkbenchTabsStore.getState().tabs.map(t => t.id)).toEqual(["b1"]);
});
