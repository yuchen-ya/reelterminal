import { beforeEach, expect, it } from "vitest";
import { useWorkbenchTabsStore } from "./workbench-tabs-store";

beforeEach(() => {
  useWorkbenchTabsStore.setState({ tabs: [], activeKey: null });
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

it("restores the mixed tab order and active object from the saved session", async () => {
  const store = useWorkbenchTabsStore.getState();
  store.open({ kind: "review", id: "a", name: "Task" });
  store.open({ kind: "board", id: "b", name: "Board" });
  store.open({ kind: "review", id: "c", name: "Other task" });
  store.move("review:c", "review:a");
  store.activate("board:b");
  const saved = localStorage.getItem("reelterminal.workbench.tabs")!;
  useWorkbenchTabsStore.setState({ tabs: [], activeKey: null });
  localStorage.setItem("reelterminal.workbench.tabs", saved);
  await useWorkbenchTabsStore.persist.rehydrate();
  expect(useWorkbenchTabsStore.getState().tabs.map(tab => `${tab.kind}:${tab.id}`)).toEqual(["review:c", "review:a", "board:b"]);
  expect(useWorkbenchTabsStore.getState().activeKey).toBe("board:b");
});
