import { describe, it, expect, vi } from "vitest";

// resolveFfmpegPath reads electron's app.isPackaged; vitest runs in plain Node
// where the electron import has no app object.
vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

import { collectHardwareInfo } from "../src/main/ipc/hardware";
import { hardwareInfoSchema } from "../src/shared/ipc-contract";

describe("collectHardwareInfo", () => {
  it("returns a schema-valid object with real CPU/memory", async () => {
    const info = await collectHardwareInfo();
    expect(hardwareInfoSchema.safeParse(info).success).toBe(true);
    expect(info.cpu.logicalCores).toBeGreaterThan(0);
    expect(info.memory.totalBytes).toBeGreaterThan(0);
  });
});
