/**
 * WAV container encoders for AudioBuffer payloads, plus the streaming header
 * builder for the desktop native export path. Three sample encodings sit side
 * by side because their call sites shipped different conversions before being
 * consolidated here, and merging the conversions would change exported bytes
 * at the sample level:
 *
 * - `encodePcm16Wav` clamps to [-1, 1] and scales asymmetrically
 *   (`x*0x8000` / `x*0x7fff`) without rounding — the transcription and
 *   audio-text-sync upload paths. It interleaves every channel; those call
 *   sites render mono OfflineAudioContext buffers, so their output is
 *   unchanged from the earlier channel-0-only writer.
 * - `encodePcm16WavRounded` scales symmetrically with rounding
 *   (`round(x*32767)` clamped to int16) — the ffmpeg fallback's transcode
 *   input.
 * - `encodeFloat32Wav` writes IEEE float32 frames (fmt tag 3) — the export
 *   engine's 32-bit WAV path.
 *
 * `buildPcm16WavHeader` emits only the 44-byte RIFF header for the native
 * export path, which streams PCM frames after it. Do not fold the conversions
 * together without auditing every caller's historical output.
 */

type WavFormatTag = 1 | 3;

function writeWavHeader(
  view: DataView,
  params: {
    format: WavFormatTag;
    numChannels: number;
    sampleRate: number;
    bitDepth: number;
    dataLength: number;
  },
): void {
  const { format, numChannels, sampleRate, bitDepth, dataLength } = params;
  const blockAlign = (numChannels * bitDepth) / 8;
  const byteRate = sampleRate * blockAlign;

  const writeAscii = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataLength, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, format, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, byteRate, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeAscii(36, "data");
  view.setUint32(40, dataLength, true);
}

function allocateWav(format: WavFormatTag, buffer: AudioBuffer, numChannels: number, sampleRate: number) {
  const bytesPerSample = format === 3 ? 4 : 2;
  const dataLength = buffer.length * numChannels * bytesPerSample;
  const arrayBuffer = new ArrayBuffer(44 + dataLength);
  const view = new DataView(arrayBuffer);
  writeWavHeader(view, {
    format,
    numChannels,
    sampleRate,
    bitDepth: bytesPerSample * 8,
    dataLength,
  });
  return { arrayBuffer, view };
}

export function encodePcm16Wav(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const { arrayBuffer, view } = allocateWav(1, buffer, numChannels, buffer.sampleRate);

  const channels: Float32Array[] = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = Math.max(-1, Math.min(1, channels[channel][i]));
      const intSample = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export function encodePcm16WavRounded(buffer: AudioBuffer): Blob {
  const numChannels = buffer.numberOfChannels;
  const { arrayBuffer, view } = allocateWav(1, buffer, numChannels, buffer.sampleRate);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      const sample = buffer.getChannelData(channel)[i];
      const intSample = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export function encodeFloat32Wav(
  buffer: AudioBuffer,
  numChannels: number = buffer.numberOfChannels,
  sampleRate: number = buffer.sampleRate,
): Blob {
  const { arrayBuffer, view } = allocateWav(3, buffer, numChannels, sampleRate);

  let offset = 44;
  for (let i = 0; i < buffer.length; i++) {
    for (let channel = 0; channel < numChannels; channel++) {
      view.setFloat32(offset, buffer.getChannelData(channel)[i], true);
      offset += 4;
    }
  }

  return new Blob([arrayBuffer], { type: "audio/wav" });
}

export function buildPcm16WavHeader(
  totalFrames: number,
  channelCount: number,
  sampleRate: number,
): ArrayBuffer {
  const dataLength = totalFrames * channelCount * 2;
  const buffer = new ArrayBuffer(44);
  writeWavHeader(new DataView(buffer), {
    format: 1,
    numChannels: channelCount,
    sampleRate,
    bitDepth: 16,
    dataLength,
  });
  return buffer;
}
