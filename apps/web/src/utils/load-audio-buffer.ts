export interface AudioLoadProgress {
  stage: "extracting" | "decoding";
  progress: number;
  message: string;
}

export interface LoadAudioBufferOptions {
  audioTrackIndex?: number;
  /**
   * When true, a `NoAudioStreamError` from the extractor is trusted (the media
   * genuinely has no matching audio stream) and returned as null without the
   * source-decode fallback. Any other extraction failure (e.g. native sidecar
   * unavailable) still falls back to decoding the source blob directly.
   */
  respectNoAudioStream?: boolean;
  onProgress?: (progress: AudioLoadProgress) => void;
}

export const loadAudioBuffer = async (
  audioContext: AudioContext | BaseAudioContext,
  blob: Blob,
  options: LoadAudioBufferOptions = {},
): Promise<AudioBuffer | null> => {
  const audioTrackIndex = options.audioTrackIndex ?? 0;
  let extractError: unknown = null;

  try {
    const { extractAudioWav } = await import("@reelterminal/core/media");
    options.onProgress?.({
      stage: "extracting",
      progress: 0.08,
      message: "Extracting audio track",
    });
    const wavBlob = await extractAudioWav(blob, audioTrackIndex, {
      onProgress: (progress) => {
        options.onProgress?.({
          stage: "extracting",
          progress: Math.min(0.82, 0.08 + progress.progress * 0.72),
          message: "Extracting audio track",
        });
      },
    });
    options.onProgress?.({
      stage: "decoding",
      progress: 0.88,
      message: "Decoding extracted audio",
    });
    const arrayBuffer = await wavBlob.arrayBuffer();
    const decoded = await audioContext.decodeAudioData(arrayBuffer);
    options.onProgress?.({
      stage: "decoding",
      progress: 1,
      message: "Audio ready for analysis",
    });
    return decoded;
  } catch (error) {
    if (
      options.respectNoAudioStream &&
      error instanceof Error &&
      error.name === "NoAudioStreamError"
    ) {
      return null;
    }
    extractError = error;
    options.onProgress?.({
      stage: "decoding",
      progress: 0.45,
      message: "Falling back to source audio decode",
    });
  }

  if (audioTrackIndex === 0) {
    try {
      options.onProgress?.({
        stage: "decoding",
        progress: 0.55,
        message: "Decoding source audio",
      });
      const arrayBuffer = await blob.arrayBuffer();
      const decoded = await audioContext.decodeAudioData(arrayBuffer);
      options.onProgress?.({
        stage: "decoding",
        progress: 1,
        message: "Audio ready for analysis",
      });
      return decoded;
    } catch {
      // Both extraction and the direct source decode failed — the clip will be
      // silent. Surface the original extraction error so a broken decode
      // pipeline is visible instead of failing silently.
      console.warn("[audio] failed to decode audio; clip stays silent:", extractError);
      return null;
    }
  }

  console.warn(
    `[audio] failed to extract audio track ${audioTrackIndex}; clip stays silent:`,
    extractError,
  );
  return null;
};