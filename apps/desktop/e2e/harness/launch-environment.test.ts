import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isolatedLaunchEnvironment } from "./launch";

const runDir = path.join(tmpdir(), "isolated-launch-environment-test");
const paths = {
  runDir,
  userDataDir: path.join(runDir, "user-data"),
  endpointFile: path.join(runDir, "live-endpoint.json"),
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isolated launch environment", () => {
  it("does not inherit user delivery, fixed-port, or crash-report targets", () => {
    vi.stubEnv("REELTERMINAL_LIVE_DELIVERY_ROOTS", "C:/user-delivery");
    vi.stubEnv("REELTERMINAL_LIVE_PORT", "4567");
    vi.stubEnv("REELTERMINAL_CRASH_ENDPOINT", "https://collector.example/report");

    expect(isolatedLaunchEnvironment(paths)).toMatchObject({
      REELTERMINAL_LIVE_DELIVERY_ROOTS: "",
      REELTERMINAL_LIVE_PORT: "0",
      REELTERMINAL_CRASH_ENDPOINT: "",
      REELTERMINAL_USER_DATA_DIR: paths.userDataDir,
      REELTERMINAL_LIVE_ENDPOINT_FILE: paths.endpointFile,
      REELTERMINAL_AGENT_WORKSPACE_ROOT: path.join(runDir, "agent-workspace"),
    });
  });

  it("allows explicit hermetic overrides while isolation paths always win", () => {
    const environment = isolatedLaunchEnvironment(paths, {
      REELTERMINAL_LIVE_DELIVERY_ROOTS: "C:/fixture-delivery",
      REELTERMINAL_LIVE_PORT: "5678",
      REELTERMINAL_CRASH_ENDPOINT: "https://fixture.invalid/report",
      REELTERMINAL_USER_DATA_DIR: "C:/not-isolated",
      REELTERMINAL_LIVE_ENDPOINT_FILE: "C:/not-isolated-endpoint",
    });

    expect(environment).toMatchObject({
      REELTERMINAL_LIVE_DELIVERY_ROOTS: "C:/fixture-delivery",
      REELTERMINAL_LIVE_PORT: "5678",
      REELTERMINAL_CRASH_ENDPOINT: "https://fixture.invalid/report",
      REELTERMINAL_USER_DATA_DIR: paths.userDataDir,
      REELTERMINAL_LIVE_ENDPOINT_FILE: paths.endpointFile,
    });
  });
});
