import { test, expect } from "vitest";
import { ownedProcessRows } from "./export-resource-observer";

test("export resource ownership includes grandchildren in arbitrary ps order and excludes other sessions", () => {
  const table = "PID PPID RSS\n 9 8 300\n8 5 200\n5 1 100\n11 1 400\n12 11 500\n";
  expect(ownedProcessRows(table, 5)).toEqual([{ pid: 9, ppid: 8, rss_kib: 300 }, { pid: 8, ppid: 5, rss_kib: 200 }, { pid: 5, ppid: 1, rss_kib: 100 }]);
  expect(ownedProcessRows(table, 999)).toEqual([]);
});
