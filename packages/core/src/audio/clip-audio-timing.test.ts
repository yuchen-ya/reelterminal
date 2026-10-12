import { describe, expect, it } from "vitest";
import { getConstantSpeedAudioRange } from "./clip-audio-timing";

describe("constant-speed audio source ranges", () => {
  it.each([0.5, 1, 2, 20])("consumes the whole trim at %sx without applying speed twice", (speed) => {
    expect(getConstantSpeedAudioRange({ inPoint: 3, outPoint: 11, speed }, 0, 8 / speed))
      .toEqual({ sourceTime: 3, sourceDuration: 8, playbackDuration: 8 / speed, speed });
  });

  it("maps a partial timeline range through the canonical speed kernel", () => {
    expect(getConstantSpeedAudioRange({ inPoint: 3, outPoint: 11, speed: 2 }, 1, 2))
      .toEqual({ sourceTime: 5, sourceDuration: 4, playbackDuration: 2, speed: 2 });
  });

  it("bounds consumption at the source trim and rejects an ended range", () => {
    expect(getConstantSpeedAudioRange({ inPoint: 3, outPoint: 11, speed: 2 }, 3, 2))
      .toEqual({ sourceTime: 9, sourceDuration: 2, playbackDuration: 1, speed: 2 });
    expect(getConstantSpeedAudioRange({ inPoint: 3, outPoint: 11, speed: 2 }, 4, 1)).toBeNull();
  });

  it("enters a reversed trim from its high edge, including a seek", () => {
    expect(getConstantSpeedAudioRange({ inPoint: 3, outPoint: 11, speed: 2, reversed: true }, 1, 2))
      .toEqual({ sourceTime: 9, sourceDuration: 4, playbackDuration: 2, speed: 2 });
  });
});
