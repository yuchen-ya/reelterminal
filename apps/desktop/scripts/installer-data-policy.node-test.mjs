import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const policy = path.join(desktop, "build/installer-data-policy.nsh");
const integration = readFileSync(path.join(desktop, "build/installer.nsh"), "utf8");
const compiler = process.env.REELTERMINAL_NSIS_MAKENSIS;
const native = process.platform === "win32";
if (native) {
  assert.ok(compiler && existsSync(compiler),
    "Windows installer regressions require REELTERMINAL_NSIS_MAKENSIS pointing to the cached makensis.exe; refusing to skip.");
}
const roots = [];
const registryFixtures = [];
const quote = (s) => `"${s.replaceAll("$", "$$").replaceAll('"', '$\\"')}"`;

function fixture() {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "rt-installer-policy-")));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const key of registryFixtures.splice(0)) {
    assert.match(key, /^HKCU\\Software\\ReelTerminal-Installer-Test\\[a-f0-9-]+$/);
    const result = spawnSync("reg.exe", ["delete", key, "/f"], { windowsHide: true });
    assert.equal(result.status, 0, "remove only the synthetic test registry key");
  }
  for (const dir of roots.splice(0)) {
    assert.equal(path.dirname(dir).toLowerCase(), realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(dir).startsWith("rt-installer-policy-"));
    rmSync(dir, { recursive: true, force: true });
  }
});

function runNsis(dir, body) {
  const source = path.join(dir, "fixture.nsi");
  const exe = path.join(dir, "fixture.exe");
  writeFileSync(source, [
    "Unicode true", "RequestExecutionLevel user", "SilentInstall silent",
    "AutoCloseWindow true", `OutFile ${quote(exe)}`, `!include ${quote(policy)}`, body,
  ].join("\n"));
  execFileSync(compiler, ["/V2", source], { timeout: 30_000, windowsHide: true, stdio: "pipe" });
  // A synthetic policy executable, NOT an installed app's uninstaller.
  return spawnSync(exe, [], { timeout: 15_000, windowsHide: true, encoding: "utf8" });
}

function cleanupFixture({ mode = "interactive", custom = false, invalid, junction = false } = {}) {
  const dir = fixture();
  const data = path.join(dir, custom ? "custom-data" : "Videos/ReelTerminal");
  const config = path.join(dir, "machine-config");
  mkdirSync(config);
  const layers = ["app-data", "projects", "agent-workspace", "review", "logs"];
  for (const layer of layers) {
    mkdirSync(path.join(data, layer), { recursive: true });
    writeFileSync(path.join(data, layer, "owned.txt"), layer);
  }
  writeFileSync(path.join(data, "unselected.txt"), "retain root and unrelated files");
  const outside = path.join(dir, "unrelated");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "keep.txt"), "never delete");
  if (junction) {
    if (junction === "nested") {
      symlinkSync(outside, path.join(data, "agent-workspace", "linked"), "junction");
    } else {
      rmSync(path.join(data, "agent-workspace"), { recursive: true });
      symlinkSync(outside, path.join(data, "agent-workspace"), "junction");
    }
  }
  const pointer = JSON.stringify({ version: 1, dataRoot: data });
  writeFileSync(path.join(config, "data-root.json"), pointer);
  let root = data;
  if (invalid === "relative") root = "relative-data";
  if (invalid === "traversal") root = `${data}\\..\\${path.basename(data)}`;
  if (invalid === "missing-root") root = path.join(dir, "does-not-exist");
  if (invalid === "root-junction") {
    root = path.join(dir, "root-link");
    symlinkSync(data, root, "junction");
  }
  if (invalid === "deep-wide") {
    const deep = path.join(data, ...Array(24).fill("d"));
    mkdirSync(deep, { recursive: true });
    writeFileSync(path.join(deep, "keep.txt"), "deep");
    for (let n = 0; n < 100; n++) writeFileSync(path.join(data, `wide-${n}`), "wide");
  }
  const ini = `[DataRoot]\r\npath=${root}\r\n`;
  if (invalid !== "missing-ini") writeFileSync(path.join(config, "uninstall-info.ini"), ini);
  const result = runNsis(dir, `
!macro FixtureNotice
  FileOpen $0 ${quote(path.join(dir, "notice.txt"))} w
  FileWrite $0 "preserved"
  FileClose $0
!macroend
Section
  !insertmacro RT_PRESERVE_DATA "${mode}" FixtureNotice
SectionEnd
`);
  assert.equal(result.status, 0, result.error?.message);
  assert.equal(readFileSync(path.join(config, "data-root.json"), "utf8"), pointer);
  if (invalid !== "missing-ini") assert.equal(readFileSync(path.join(config, "uninstall-info.ini"), "utf8"), ini);
  assert.equal(readFileSync(path.join(data, "unselected.txt"), "utf8"), "retain root and unrelated files");
  assert.equal(readFileSync(path.join(outside, "keep.txt"), "utf8"), "never delete");
  assert.equal(existsSync(path.join(dir, "notice.txt")), mode === "interactive");
  if (invalid === "deep-wide") {
    assert.equal(readFileSync(path.join(data, ...Array(24).fill("d"), "keep.txt"), "utf8"), "deep");
    for (let n = 0; n < 100; n++) assert.equal(readFileSync(path.join(data, `wide-${n}`), "utf8"), "wide");
  }
  for (const layer of layers) {
    if (junction === true && layer === "agent-workspace") {
      assert.ok(existsSync(path.join(data, layer, "keep.txt")));
      continue;
    }
    assert.equal(readFileSync(path.join(data, layer, "owned.txt"), "utf8"), layer);
  }
}

test("production wiring preserves configuration and blocks unsafe upgrades before install", () => {
  assert.match(integration, /!macro customInit\s+!insertmacro RT_REQUIRE_SAFE_UPGRADE HKCU\s+!insertmacro RT_REQUIRE_SAFE_UPGRADE HKLM/);
  assert.match(integration, /WriteRegDWORD SHELL_CONTEXT "\$\{INSTALL_REGISTRY_KEY\}" DataCleanupPolicyVersion 1/);
  assert.match(integration, /\$\{Silent\}[\s\S]*"silent"/);
  assert.match(integration, /\$\{isUpdated\}[\s\S]*"upgrade"/);
  assert.match(integration, /RT_DATA_PRESERVED_NOTICE/);
  assert.match(integration, /!insertmacro RT_PRESERVE_DATA "\$rtCleanupMode" RT_DATA_PRESERVED_NOTICE/);
  assert.doesNotMatch(integration, /RT_CLEANUP_DATA|RT_CONFIRM_DATA_LAYER/);
  assert.doesNotMatch(integration, /ReadEnvStr|RMDir/);
  const text = readFileSync(policy, "utf8");
  assert.doesNotMatch(text, /CopyFiles|Rename|WriteINIStr|WriteReg|DeleteReg/);
  assert.doesNotMatch(text, /^\s*(RMDir|Delete|FindFirst|FindNext|ReadINIStr|System::Call)\b/m);
});

for (const custom of [false, true]) {
  for (const mode of ["interactive", "silent", "upgrade"]) {
    test(`native preservation: ${custom ? "custom" : "default-layout"} root, ${mode}`, { skip: !native }, () => cleanupFixture({ custom, mode }));
  }
}
for (const invalid of ["relative", "traversal", "missing-root", "missing-ini", "root-junction", "deep-wide"]) {
  test(`native cleanup: ${invalid} preserves data instead of guessing`, { skip: !native }, () => cleanupFixture({ invalid }));
}
test("native cleanup: a layer junction never deletes its external target", { skip: !native }, () => cleanupFixture({ junction: true }));
test("native cleanup: a nested junction never deletes its external target", { skip: !native }, () => cleanupFixture({ junction: "nested" }));

for (const state of ["new", "legacy", "location-only", "safe", "unknown", "wrong-type"]) {
  test(`native upgrade gate: ${state}`, { skip: !native }, () => {
    const dir = fixture();
    const key = `Software\\ReelTerminal-Installer-Test\\${randomUUID()}`;
    registryFixtures.push(`HKCU\\${key}`);
    const passed = path.join(dir, "gate-passed.txt");
    const result = runNsis(dir, `
!define UNINSTALL_REGISTRY_KEY "${key}\\Uninstall"
!define INSTALL_REGISTRY_KEY "${key}\\Install"
Section
  WriteRegStr HKCU "${key}" Fixture "owned"
  ${state === "new" ? "" : `WriteRegStr HKCU "\${UNINSTALL_REGISTRY_KEY}" UninstallString "fixture-only-never-executed"`}
  ${state === "location-only" ? `DeleteRegValue HKCU "\${UNINSTALL_REGISTRY_KEY}" UninstallString\n  WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" InstallLocation "fixture-only"` : ""}
  ${state === "wrong-type" ? `WriteRegStr HKCU "\${INSTALL_REGISTRY_KEY}" DataCleanupPolicyVersion "1"` : ""}
  ${state === "safe" || state === "unknown" ? `WriteRegDWORD HKCU "\${INSTALL_REGISTRY_KEY}" DataCleanupPolicyVersion ${state === "safe" ? 1 : 99}` : ""}
  !insertmacro RT_REQUIRE_SAFE_UPGRADE HKCU
  FileOpen $0 ${quote(passed)} w
  FileWrite $0 "passed"
  FileClose $0
SectionEnd
`);
    const allow = state === "new" || state === "safe";
    assert.equal(result.status, allow ? 0 : 2);
    assert.equal(existsSync(passed), allow);
  });
}
