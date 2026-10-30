import { afterEach, expect, it } from "vitest";
import { dispatchBoardHistory } from "./history";
afterEach(() => document.body.replaceChildren());
it.each(["Win32", "Linux x86_64", "MacIntel"])("focuses the board and dispatches native undo/redo on %s", platform => {
  const target = document.createElement("div"); target.tabIndex = 0; document.body.append(target);
  const events: KeyboardEvent[] = [];
  const listener = (event: KeyboardEvent) => events.push(event);
  document.body.addEventListener("keydown", listener);
  dispatchBoardHistory(target, "undo", platform);
  dispatchBoardHistory(target, "redo", platform);
  expect(document.activeElement).toBe(target);
  expect(events).toHaveLength(2);
  for (const event of events) {
    expect(event.key).toBe("z"); expect(event.cancelable).toBe(true);
    expect(event.metaKey).toBe(platform === "MacIntel"); expect(event.ctrlKey).toBe(platform !== "MacIntel");
  }
  expect(events.map(event => event.shiftKey)).toEqual([false, true]);
  document.body.removeEventListener("keydown", listener);
});
