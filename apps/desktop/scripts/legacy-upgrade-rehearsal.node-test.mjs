import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { APP_ID, KEYS, rehearse } from "./legacy-upgrade-rehearsal.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "rt-upgrade-rehearsal-"));
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir());
    assert.ok(path.basename(root).startsWith("rt-upgrade-rehearsal-"));
    assert.equal(readFileSync(path.join(root, "old-install", "keep.txt"), "utf8"), "old payload");
    assert.ok(existsSync(path.join(root, "backup", "db.fixture")));
    rmSync(root, { recursive: true, force: true });
  });
  const input = { synthetic: true, appId: APP_ID, ownerSid: "SYNTHETIC-CURRENT-USER",
    currentSid: "SYNTHETIC-CURRENT-USER", expectedOldLocation: "C:\\Synthetic\\Old" };
  const before = { machine: { x64: null, x86: null }, registry: {
    install: { key: KEYS.install, values: { InstallLocation: input.expectedOldLocation } },
    uninstall: { key: KEYS.uninstall, values: { DisplayName: "ReelTerminal", UninstallString: "NEVER-EXECUTE-OLD" } },
  }, shortcuts: { desktop: "old-desktop-bytes", startMenu: "old-start-menu-bytes" } };
  const saveInput = () => writeFileSync(path.join(root, "fixture.json"), JSON.stringify(input));
  const save = (value = before) => writeFileSync(path.join(root, "registration.json"), JSON.stringify(value));
  saveInput(); save();
  mkdirSync(path.join(root, "old-install"));
  writeFileSync(path.join(root, "old-install", "keep.txt"), "old payload");
  mkdirSync(path.join(root, "backup"));
  const data = Buffer.from("synthetic database; no private records");
  writeFileSync(path.join(root, "backup", "db.fixture"), data);
  writeFileSync(path.join(root, "backup", "manifest.json"), JSON.stringify({ restoreVerified: true,
    files: [{ name: "db.fixture", bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") }] }));
  const read = () => JSON.parse(readFileSync(path.join(root, "registration.json")));
  return { root, before, input, save, saveInput, read };
}

test("successful rehearsal retains old payload, backup and full before-state", (t) => {
  const f = fixture(t);
  assert.equal(rehearse(f.root).status, "completed");
  assert.deepEqual(JSON.parse(readFileSync(path.join(f.root, "journal", "before.json"))), f.before);
});
for (const stage of ["after-detach-uninstall", "after-detach-install", "before-install"]) {
  test(`failure at ${stage} restores only detached state`, (t) => {
    const f = fixture(t);
    const r = rehearse(f.root, { atStage: (s) => { if (s === stage) throw Error("injected"); } });
    assert.equal(r.status, "rolled-back");
    assert.deepEqual(f.read(), f.before);
  });
}
test("installer failure preserves evidence; does not guess ownership for rollback", (t) => {
  const f = fixture(t);
  assert.equal(rehearse(f.root, { installFails: true }).status, "manual-recovery-required");
  assert.ok(existsSync(path.join(f.root, "new-install")));
});
for (const stage of ["after-detach-uninstall", "before-install", "after-install"]) {
  test(`external changes at ${stage} are not overwritten`, (t) => {
    const f = fixture(t);
    const r = rehearse(f.root, { atStage: (s, io) => {
      if (s !== stage) return;
      const state = io.read();
      state.registry.uninstall = { key: KEYS.uninstall, values: { External: "keep" } };
      state.shortcuts.desktop = "external-link";
      io.write(state);
    } });
    assert.equal(r.status, "manual-recovery-required");
    assert.equal(f.read().registry.uninstall.values.External, "keep");
    assert.equal(f.read().shortcuts.desktop, "external-link");
  });
}
for (const kind of ["target", "app", "user", "machine", "key", "path", "backup"]) {
  test(`reject ${kind} before any state mutation`, (t) => {
    const f = fixture(t);
    if (kind === "target") mkdirSync(path.join(f.root, "new-install"));
    if (kind === "app") { f.input.appId = "unknown"; f.saveInput(); }
    if (kind === "user") { f.input.ownerSid = "other"; f.saveInput(); }
    if (kind === "machine") { f.before.machine.x64 = { installed: true }; f.save(); }
    if (kind === "key") { f.before.registry.install.key = "HKCU\\Other"; f.save(); }
    if (kind === "path") { f.before.registry.install.values.InstallLocation = "C:relative"; f.save(); }
    if (kind === "backup") writeFileSync(path.join(f.root, "backup", "db.fixture"), "corrupt");
    assert.throws(() => rehearse(f.root));
    assert.deepEqual(f.read(), f.before);
    assert.equal(existsSync(path.join(f.root, "journal")), false);
  });
}
test("target appearing after detach is detected and original state restored", (t) => {
  const f = fixture(t);
  const r = rehearse(f.root, { atStage: (s) => {
    if (s === "before-install") mkdirSync(path.join(f.root, "new-install"));
  } });
  assert.equal(r.status, "rolled-back");
  assert.deepEqual(f.read(), f.before);
});
