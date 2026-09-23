import { describe, expect, it } from "vitest";
import {
  buildPcm16WavHeader,
  encodeFloat32Wav,
  encodePcm16Wav,
  encodePcm16WavRounded,
} from "./wav-encode";

/** Minimal AudioBuffer stand-in: the encoders only read these members. */
function fakeBuffer(
  channels: Float32Array[],
  sampleRate = 48000,
): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    length: channels[0]?.length ?? 0,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

async function wavBytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

function ascii(view: DataView, offset: number, length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) {
    out += String.fromCharCode(view.getUint8(offset + i));
  }
  return out;
}

describe("wav-encode headers", () => {
  it("buildPcm16WavHeader writes a 44-byte PCM header with the streamed size", () => {
    const header = buildPcm16WavHeader(48000, 2, 48000);
    const view = new DataView(header);

    expect(header.byteLength).toBe(44);
    expect(ascii(view, 0, 4)).toBe("RIFF");
    expect(ascii(view, 8, 4)).toBe("WAVE");
    expect(view.getUint32(4, true)).toBe(36 + 48000 * 2 * 2);
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint16(34, true)).toBe(16);
    expect(view.getUint32(40, true)).toBe(48000 * 2 * 2);
  });

  it("marks float32 payloads with fmt tag 3 and 4-byte frames", async () => {
    const bytes = await wavBytes(encodeFloat32Wav(fakeBuffer([new Float32Array([0.5])])));
    const view = new DataView(bytes.buffer);

    expect(view.getUint16(20, true)).toBe(3);
    expect(view.getUint16(32, true)).toBe(4);
    expect(view.getUint32(40, true)).toBe(4);
  });
});

describe("wav-encode PCM16 conversions", () => {
  it("encodePcm16Wav interleaves channels with asymmetric scaling", async () => {
    const bytes = await wavBytes(
      encodePcm16Wav(
        fakeBuffer([new Float32Array([1, -1]), new Float32Array([0, 0.5])]),
      ),
    );
    const view = new DataView(bytes.buffer);

    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getInt16(44, true)).toBe(0x7fff);
    expect(view.getInt16(46, true)).toBe(0);
    expect(view.getInt16(48, true)).toBe(-0x8000);
    expect(view.getInt16(50, true)).toBe(0x3fff);
  });

  it("encodePcm16WavRounded rounds symmetrically instead of truncating", async () => {
    const bytes = await wavBytes(
      encodePcm16WavRounded(fakeBuffer([new Float32Array([0.5, -0.5])])),
    );
    const view = new DataView(bytes.buffer);

    expect(view.getInt16(44, true)).toBe(Math.round(0.5 * 32767));
    expect(view.getInt16(46, true)).toBe(Math.round(-0.5 * 32767));
  });
});
