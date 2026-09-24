import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  DATA_ROOT_DIR_NAME,
  DATA_ROOT_POINTER_FILE,
  dataRootLayout,
  dataRootPointerPath,
  machineConfigDir,
  parseDataRootPointer,
  resolveDataRoot,
  serializeDataRootPointer,
  serializeUninstallInfo,
} from "./data-root";

describe("dataRootLayout", () => {
  it("spreads the four user-scoped stores under one root", () => {
    const layout = dataRootLayout(join("D:", "RT"));
    expect(layout.root).toBe(join("D:", "RT"));
    expect(layout.appData).toBe(join("D:", "RT", "app-data"));
    expect(layout.projects).toBe(join("D:", "RT", "projects"));
    expect(layout.agentWorkspace).toBe(join("D:", "RT", "agent-workspace"));
    expect(layout.logs).toBe(join("D:", "RT", "logs"));
  });
});

describe("machineConfigDir", () => {
  it("uses LOCALAPPDATA on Windows and falls back to the profile default", () => {
    expect(
      machineConfigDir("win32", { LOCALAPPData: "x", LOCALAPPDATA: "C:\\L" }, "C:\\Users\\u"),
    ).toBe(join("C:\\L", DATA_ROOT_DIR_NAME));
    expect(machineConfigDir("win32", {}, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u", "AppData", "Local", DATA_ROOT_DIR_NAME),
    );
  });

  it("uses the platform config homes elsewhere", () => {
    expect(machineConfigDir("darwin", {}, "/Users/u")).toBe(
      join("/Users/u", "Library", "Application Support", DATA_ROOT_DIR_NAME),
    );
    expect(machineConfigDir("linux", { XDG_CONFIG_HOME: "/cfg" }, "/home/u")).toBe(
      join("/cfg", DATA_ROOT_DIR_NAME),
    );
    expect(machineConfigDir("linux", {}, "/home/u")).toBe(
      join("/home/u", ".config", DATA_ROOT_DIR_NAME),
    );
  });

  it("places the pointer inside the config dir", () => {
    expect(dataRootPointerPath("win32", { LOCALAPPDATA: "C:\\L" }, "h")).toBe(
      join("C:\\L", DATA_ROOT_DIR_NAME, DATA_ROOT_POINTER_FILE),
    );
  });
});

describe("pointer serialization", () => {
  it("round-trips dataRoot, changedAt and previousRoot", () => {
    const pointer = {
      dataRoot: join("D:", "RT"),
      changedAt: 1_700_000_000_000,
      previousRoot: join("C:", "Old", "ReelTerminal"),
    };
    const parsed = parseDataRootPointer(serializeDataRootPointer(pointer));
    expect(parsed).toEqual(pointer);
  });

  it("rejects corrupt or empty pointers instead of guessing", () => {
    expect(parseDataRootPointer("not json")).toBeNull();
    expect(parseDataRootPointer("{}")).toBeNull();
    expect(parseDataRootPointer('{"dataRoot":"  "}')).toBeNull();
    expect(parseDataRootPointer('{"dataRoot":42}')).toBeNull();
  });

  it("serializes the uninstaller INI with plain values", () => {
    const ini = serializeUninstallInfo({
      dataRoot: join("D:", "RT"),
      machineConfigDir: join("C:", "Cfg"),
    });
    expect(ini).toContain("[DataRoot]");
    expect(ini).toContain(`path=${join("D:", "RT")}`);
    expect(ini).toContain(`configDir=${join("C:", "Cfg")}`);
  });
});

describe("resolveDataRoot", () => {
  const pointer = {
    dataRoot: join("D:", "Pointer", "RT"),
    changedAt: 1,
  };
  const defaultRoot = join("C:", "Videos", "ReelTerminal");

  it("prefers an absolute env override", () => {
    expect(
      resolveDataRoot({
        envDataRoot: join("E:", "EnvRT"),
        pointer,
        defaultRoot,
      }),
    ).toEqual({ root: join("E:", "EnvRT"), source: "env" });
  });

  it("ignores empty or relative env values and falls through", () => {
    expect(
      resolveDataRoot({ envDataRoot: "", pointer, defaultRoot }),
    ).toEqual({ root: pointer.dataRoot, source: "pointer" });
    expect(
      resolveDataRoot({ envDataRoot: "relative/dir", pointer, defaultRoot }),
    ).toEqual({ root: pointer.dataRoot, source: "pointer" });
    expect(
      resolveDataRoot({ envDataRoot: "   ", pointer: null, defaultRoot }),
    ).toEqual({ root: defaultRoot, source: "default" });
    expect(resolveDataRoot({ envDataRoot: undefined, pointer: null, defaultRoot })).toEqual({
      root: defaultRoot,
      source: "default",
    });
  });

  it("uses the pointer when no env override applies", () => {
    expect(resolveDataRoot({ envDataRoot: undefined, pointer, defaultRoot })).toEqual({
      root: pointer.dataRoot,
      source: "pointer",
    });
    expect(
      resolveDataRoot({
        envDataRoot: undefined,
        pointer: { ...pointer, dataRoot: "relative" },
        defaultRoot,
      }),
    ).toEqual({ root: defaultRoot, source: "default" });
  });
});
