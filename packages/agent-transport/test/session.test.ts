import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ cancel: vi.fn(), status: vi.fn(), close: vi.fn() }));
vi.mock("@reelterminal/agent-facade", () => ({
  createAgentFacade: () => ({ "job.cancel": mocks.cancel, "job.status": mocks.status }),
}));
vi.mock("@reelterminal/runtime-chromium", () => ({
  createChromiumProviders: () => ({ close: mocks.close }),
  FfmpegArtifactVerifier: class {},
}));
import { createTransportSession } from "../src/session";

afterEach(() => { vi.clearAllMocks(); });

describe("transport audio-process shutdown", () => {
  it("waits for audio cancellation cleanup before closing providers", async () => {
    const order: string[] = [];
    mocks.cancel.mockResolvedValue({ ok: true, value: { kind: "audio-process", state: "running", cancelRequested: true } });
    mocks.status.mockImplementation(async () => {
      order.push("cleanup settled");
      return { ok: true, value: { kind: "audio-process", state: "cancelled" } };
    });
    mocks.close.mockImplementation(async () => { order.push("providers closed"); });
    const session = createTransportSession({ mediaRoots: [], projectRoots: [], deliveryRoots: [], logLevel: "error" });
    session.trackJob("audio-job");
    await session.dispose("stdin-eof");
    expect(mocks.cancel).toHaveBeenCalledWith({ jobId: "audio-job" });
    expect(order).toEqual(["cleanup settled", "providers closed"]);
  });
});
