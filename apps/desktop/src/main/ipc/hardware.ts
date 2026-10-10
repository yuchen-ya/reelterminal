import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { HardwareInfo } from "../../shared/ipc-contract";
import { probeEncoders } from "../sidecar/encoder-probe";

const run = promisify(execFile);

function numericLines(stdout: string): number[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^\d+$/.test(l))
    .map((l) => Number(l));
}

async function probeGpus(): Promise<string[]> {
  try {
    if (process.platform === "darwin") {
      const { stdout } = await run("system_profiler", ["SPDisplaysDataType", "-json"], { timeout: 4000 });
      const json = JSON.parse(stdout) as { SPDisplaysDataType?: { sppci_model?: string }[] };
      return (json.SPDisplaysDataType ?? []).map((g) => g.sppci_model ?? "GPU").filter(Boolean);
    }
    if (process.platform === "win32") {
      try {
        const { stdout } = await run("wmic", ["path", "win32_VideoController", "get", "name"], { timeout: 4000 });
        const names = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && l !== "Name");
        if (names.length > 0) return names;
      } catch {
        // wmic was removed by default in Windows 11 24H2+; fall through.
      }
      const { stdout } = await run(
        "powershell",
        ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name"],
        { timeout: 4000 },
      );
      return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    }
    const { stdout } = await run("sh", ["-c", "lspci | grep -iE 'vga|3d|display' || true"], { timeout: 4000 });
    return stdout.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Physical (not logical) core count. Only Windows lacks a cheap portable
 * source: os.cpus() there reports logical processors, so query CIM for
 * NumberOfCores (summing across sockets). Non-Windows keeps the historical
 * derivation of logical cores as the closest available approximation.
 */
async function probePhysicalCores(logicalCores: number): Promise<number> {
  if (process.platform !== "win32") return logicalCores;
  try {
    const { stdout } = await run("wmic", ["cpu", "get", "NumberOfCores"], { timeout: 4000 });
    const sum = numericLines(stdout).reduce((a, b) => a + b, 0);
    if (sum > 0) return sum;
  } catch {
    // wmic may be absent on Windows 11 24H2+; fall through to PowerShell.
  }
  try {
    const { stdout } = await run(
      "powershell",
      ["-NoProfile", "-Command", "(Get-CimInstance Win32_Processor | Measure-Object NumberOfCores -Sum).Sum"],
      { timeout: 4000 },
    );
    const sum = numericLines(stdout).reduce((a, b) => a + b, 0);
    if (sum > 0) return sum;
  } catch {
    // Keep the logical count rather than failing the whole probe.
  }
  return logicalCores;
}

export async function collectHardwareInfo(): Promise<HardwareInfo> {
  const cpus = os.cpus();
  return {
    cpu: {
      model: cpus[0]?.model?.trim() ?? "unknown",
      physicalCores: await probePhysicalCores(cpus.length),
      logicalCores: cpus.length,
    },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem() },
    gpus: await probeGpus(),
    encoders: await probeEncoders(),
    platform: process.platform as HardwareInfo["platform"],
    arch: process.arch,
  };
}
