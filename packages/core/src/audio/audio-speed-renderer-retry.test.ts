import { expect, it, vi } from "vitest";
import { prepareAudioSpeed } from "./audio-speed-renderer";

const createEngine = vi.hoisted(() => vi.fn());
vi.mock("signalsmith-stretch-js", () => ({ createSignalsmithStretch: createEngine }));

it("retries stretch initialization after failure and shares the recovered engine", async () => {
  const buffer = (channels: number, length: number, sampleRate: number) => {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { numberOfChannels: channels, length, sampleRate, duration: length / sampleRate,
      getChannelData: (channel: number) => data[channel] } as AudioBuffer;
  };
  const process = vi.fn(async () => ({ channels: [new Float32Array(4000)] }));
  createEngine.mockRejectedValueOnce(new Error("WASM initialization failed")).mockResolvedValue({ process });
  const source = buffer(1, 8000, 8000);
  const context = { createBuffer: buffer } as unknown as BaseAudioContext;
  const timing = { id: "retry", inPoint: 0, outPoint: 1, speed: 2 };
  await expect(prepareAudioSpeed(context, source, timing)).rejects.toThrow("WASM initialization failed");
  expect((await prepareAudioSpeed(context, source, timing)).buffer.duration).toBe(0.5);
  await prepareAudioSpeed(context, source, { ...timing, id: "second-clip" });
  expect(createEngine).toHaveBeenCalledTimes(2);
  expect(process).toHaveBeenCalledTimes(2);
});
