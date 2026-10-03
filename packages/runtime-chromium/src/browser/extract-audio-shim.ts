/**
 * Harness shim for core's `media/extract-audio` module.
 *
 * The product module falls back to ffmpeg.wasm (@ffmpeg/core) in browsers.
 * Those wasm assets are not bundled in the harness page, so this shim
 * implements the same
 * contract over mediabunny instead:
 *
 *   - no audio track (or undecodable one) → error NAMED "NoAudioStreamError"
 *     (audio-engine checks `error.name`, not instanceof);
 *   - otherwise decode via WebCodecs (AudioBufferSink) and return a PCM16
 *     WAV Blob, which `context.decodeAudioData` consumes downstream.
 *
 * Same memory profile as the product path: the whole clip's audio is decoded
 * (that is what the whole-file extraction contract means).
 */
export class NoAudioStreamError extends Error {
  constructor(message = "The media file has no decodable audio stream") {
    super(message);
    this.name = "NoAudioStreamError";
  }
}

function floatTo16BitPCM(samples: Float32Array, out: DataView, offset: number): void {
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    out.setInt16(offset + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
}

/** Interleave channels and wrap them in a canonical PCM16 RIFF/WAVE blob. */
function encodeWav(buffers: AudioBuffer[], totalFrames: number): Blob {
  const channels = buffers[0]?.numberOfChannels ?? 0;
  const sampleRate = buffers[0]?.sampleRate ?? 0;
  if (channels <= 0 || sampleRate <= 0) {
    throw new NoAudioStreamError("decoded audio has no channels");
  }
  const bytesPerSample = 2;
  const dataSize = totalFrames * channels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeAscii(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeAscii(8, "WAVE");
  writeAscii(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM format
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * bytesPerSample, true);
  view.setUint16(32, channels * bytesPerSample, true);
  view.setUint16(34, 16, true);
  writeAscii(36, "data");
  view.setUint32(40, dataSize, true);

  const channelData: Float32Array[][] = buffers.map((audioBuffer) => {
    const channels_: Float32Array[] = [];
    for (let c = 0; c < channels; c++) {
      channels_.push(audioBuffer.getChannelData(c));
    }
    return channels_;
  });

  let writeFrame = 0;
  for (const audioBuffer of buffers) {
    const idx = buffers.indexOf(audioBuffer);
    const chunk = channelData[idx]!;
    for (let frame = 0; frame < audioBuffer.length; frame++) {
      for (let c = 0; c < channels; c++) {
        const sample = chunk[c]![frame] ?? 0;
        const s = Math.max(-1, Math.min(1, sample));
        view.setInt16(
          44 + (writeFrame + frame) * channels * 2 + c * 2,
          s < 0 ? s * 0x8000 : s * 0x7fff,
          true,
        );
      }
    }
    writeFrame += audioBuffer.length;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function extractAudioWav(
  file: File | Blob,
  audioTrackIndex = 0,
): Promise<Blob> {
  const mb = await import("mediabunny");
  const input = new mb.Input({
    source: new mb.BlobSource(file),
    formats: mb.ALL_FORMATS,
  });
  try {
    const audioTracks = await input.getAudioTracks();
    let track = audioTracks[audioTrackIndex] ?? null;
    if (!track && audioTrackIndex === 0) {
      track = (await input.getPrimaryAudioTrack()) ?? audioTracks[0] ?? null;
    }
    if (!track) throw new NoAudioStreamError();
    if (!(await track.canDecode())) {
      throw new NoAudioStreamError("audio track cannot be decoded");
    }
    const duration = await input.computeDuration();
    const sink = new mb.AudioBufferSink(track);
    const buffers: AudioBuffer[] = [];
    let totalFrames = 0;
    for await (const wrapped of sink.buffers(0, Math.max(duration, 0.001))) {
      buffers.push(wrapped.buffer);
      totalFrames += wrapped.buffer.length;
    }
    if (buffers.length === 0 || totalFrames === 0) {
      throw new NoAudioStreamError();
    }
    return encodeWav(buffers, totalFrames);
  } finally {
    input[Symbol.dispose]?.();
  }
}

export interface ExtractAudioProgressOptions {
  onProgress?: (progress: { phase?: string; progress: number }) => void;
}

// Keep the linter honest: the float helper documents the PCM conversion;
// encodeWav inlines it for speed.
void floatTo16BitPCM;
