/**
 * A one-off migration rehearsal, NOT an installer or live registry adapter.
 * Every write is confined to a caller-owned synthetic fixture directory.
 * Real handoff remains an attended, separately authorized operation.
 */
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

export const APP_ID = "video.reelterminal.desktop";
export const KEYS = {
  install: "HKCU\\Software\\028d27d5-c5ef-571c-a449-30084a704a54",
  uninstall: "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\028d27d5-c5ef-571c-a449-30084a704a54",
};
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const requireCondition = (condition, message) => { if (!condition) throw new Error(message); };

export function rehearse(root, options = {}) {
  root = path.resolve(root);
  requireCondition(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), "Invalid fixture root");
  // No CLI accepts real keys, paths, executable commands or a production adapter.
  const input = JSON.parse(readFileSync(path.join(root, "fixture.json"), "utf8"));
  requireCondition(input.synthetic === true && input.appId === APP_ID, "Unknown app or non-synthetic input");
  requireCondition(input.ownerSid === input.currentSid && input.currentSid === "SYNTHETIC-CURRENT-USER",
    "Cross-user fixture rejected");
  const stateFile = path.join(root, "registration.json");
  const read = () => JSON.parse(readFileSync(stateFile, "utf8"));
  const write = (state) => writeFileSync(stateFile, JSON.stringify(state, null, 2));
  const before = read();
  requireCondition(Object.values(before.machine).every((value) => value === null), "Machine-level registration rejected");
  requireCondition(Object.keys(before.registry).sort().join() === Object.keys(KEYS).sort().join(), "Unknown registry target");
  for (const [slot, key] of Object.entries(KEYS)) {
    requireCondition(before.registry[slot]?.key === key, "Unknown registry key");
  }
  requireCondition(before.registry.uninstall.values.DisplayName === "ReelTerminal", "Unknown product identity");
  requireCondition(/^[A-Za-z]:\\[^\\]/.test(before.registry.install.values.InstallLocation), "Abnormal installation path");
  requireCondition(before.registry.install.values.InstallLocation === input.expectedOldLocation, "Registration changed");
  requireCondition(same(Object.keys(before.shortcuts).sort(), ["desktop", "startMenu"]), "Unknown shortcut target");
  requireCondition(!existsSync(path.join(root, "new-install")), "Target already exists");
  requireCondition(!existsSync(path.join(root, "journal")), "Existing migration journal; review before retry");

  const backup = JSON.parse(readFileSync(path.join(root, "backup", "manifest.json"), "utf8"));
  requireCondition(backup.restoreVerified === true, "Restore not verified");
  requireCondition(backup.files.length > 0, "Empty backup");
  for (const file of backup.files) {
    requireCondition(/^[a-z0-9.-]+$/i.test(file.name), "Unsafe backup fixture path");
    const p = path.join(root, "backup", file.name);
    requireCondition(!lstatSync(p).isSymbolicLink(), "Backup link rejected");
    const bytes = readFileSync(p);
    requireCondition(bytes.length === file.bytes && digest(bytes) === file.sha256, "Backup integrity failure");
  }

  const journal = path.join(root, "journal");
  mkdirSync(journal);
  writeFileSync(path.join(journal, "before.json"), JSON.stringify(before, null, 2), { flag: "wx" });
  const event = (stage, details = {}) => appendFileSync(path.join(journal, "events.jsonl"),
    JSON.stringify({ time: new Date().toISOString(), stage, ...details }) + "\n");
  event("backup-and-preflight-verified");
  const detached = [];
  let installerStarted = false;
  const fault = (stage) => options.atStage?.(stage, { read, write });
  const compareAndWrite = (expected, next) => {
    requireCondition(same(read(), expected), "Concurrent state change");
    // A file-backed rehearsal only: this is NOT an atomic Windows registry CAS.
    write(next);
  };
  try {
    let expected = before;
    for (const slot of ["uninstall", "install"]) {
      fault(`before-detach-${slot}`);
      const next = structuredClone(expected);
      next.registry[slot] = null;
      event("detach-intent", { slot });
      compareAndWrite(expected, next);
      detached.push(slot);
      expected = next;
      event("detached", { slot });
      fault(`after-detach-${slot}`);
    }
    fault("before-install");
    requireCondition(same(read(), expected), "Concurrent state change before install");
    requireCondition(!existsSync(path.join(root, "new-install")), "Target appeared before install");
    event("new-install-starting");
    installerStarted = true;
    // Simulated NEW installer only. Never reads or executes an old uninstall command.
    mkdirSync(path.join(root, "new-install"));
    fault("install-started");
    requireCondition(!options.installFails, "Injected new installer failure");
    const installed = structuredClone(expected);
    installed.registry = structuredClone(before.registry);
    installed.registry.install.values.InstallLocation = "SYNTHETIC-NEW-INSTALL";
    installed.registry.install.values.DataCleanupPolicyVersion = 1;
    installed.registry.uninstall.values.UninstallString = "SYNTHETIC-NEW-UNINSTALLER";
    installed.shortcuts = { desktop: "synthetic-new-link", startMenu: "synthetic-new-link" };
    compareAndWrite(expected, installed);
    fault("after-install");
    requireCondition(same(read(), installed), "Concurrent state change after install");
    event("completed");
    return { status: "completed", synthetic: true, oldUninstallerExecuted: false };
  } catch (error) {
    const conflicts = [];
    // Once a real installer could have written state, provenance is unknown.
    // Never guess that those writes are ours: retain journal and request review.
    if (!installerStarted) {
      for (const slot of detached.reverse()) {
        const state = read();
        if (state.registry[slot] !== null) { conflicts.push(slot); continue; }
        const restored = structuredClone(state);
        restored.registry[slot] = before.registry[slot];
        compareAndWrite(state, restored);
        event("restored-detached-key", { slot });
      }
    }
    const status = installerStarted || conflicts.length ? "manual-recovery-required" : "rolled-back";
    event(status, { error: error.message, conflicts });
    return { status, synthetic: true, error: error.message, conflicts, oldUninstallerExecuted: false };
  }
}
