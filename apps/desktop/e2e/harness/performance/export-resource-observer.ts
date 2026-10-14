import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import type { LaunchedApp } from "../launch";

/** Limit process observations to the isolated app and its current descendants. */
export function ownedProcessRows(table: string, rootPid: number): { pid: number; ppid: number; rss_kib: number }[] {
  const rows = table.split("\n").flatMap(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rss_kib: Number(match[3]) }] : [];
  });
  const owned = new Set([rootPid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); changed = true; }
  }
  return rows.filter(row => owned.has(row.pid));
}

/** Opt-in idle checkpoints; never requests GC or changes application resources. */
export async function createExportResourceObserver(launched: LaunchedApp, artifact: string) {
  const cdp = await launched.page.context().newCDPSession(launched.page);
  await cdp.send("Performance.enable");
  const appPid = launched.app.process().pid!;
  return {
    async sample(phase: string): Promise<void> {
      const metrics = await cdp.send("Performance.getMetrics");
      const heap = Object.fromEntries(metrics.metrics.map(value => [value.name, value.value]));
      const main = await launched.app.evaluate(async ({ app }) => ({
        memory: process.memoryUsage(), process_memory_info_kib: await process.getProcessMemoryInfo(),
        processes: app.getAppMetrics().map(value => ({ pid: value.pid, epoch: value.creationTime, type: value.type, rss_bytes: value.memory.workingSetSize * 1024 })),
      }));
      const renderer = await launched.page.evaluate(async () => ({ visible: !document.hidden, resources: await (globalThis as any).__reelterminalPerformanceCapture.readResources() }));
      if (!renderer.visible) throw new Error("export resource observation window hidden");
      const processes = ownedProcessRows(execFileSync("ps", ["-axo", "pid,ppid,rss"], { encoding: "utf8" }), appPid);
      const pids = new Set(processes.map(row => row.pid));
      const platform = process.platform === "darwin" ? {
        // macOS top MEM includes compressed/accounted memory; keep its label
        // and units. This is additional evidence, never relabelled as RSS.
        top_mem_owned_rows: execFileSync("top", ["-l", "1", "-n", "80", "-o", "mem", "-stats", "pid,command,mem"], { encoding: "utf8" }).split("\n").filter(line => pids.has(Number(line.trim().split(/\s+/)[0]))),
        pressure: execFileSync("sysctl", ["kern.memorystatus_vm_pressure_level"], { encoding: "utf8" }).trim(),
        swap: execFileSync("sysctl", ["vm.swapusage"], { encoding: "utf8" }).trim(),
      } : null;
      await appendFile(artifact, JSON.stringify({ epoch_ms: Date.now(), phase, forced_gc: false, heap, main, ...renderer, owned_process_rss: processes, platform }) + "\n");
    },
    close: () => cdp.detach(),
  };
}
