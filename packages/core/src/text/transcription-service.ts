import type { Subtitle, SubtitleStyle, Clip } from "../types/timeline";
import type { MediaItem } from "../types/project";
import { encodePcm16Wav } from "../audio/wav-encode";

export interface CloudflareWhisperWord {
  word: string;
  start: number;
  end: number;
}

export interface CloudflareWhisperResponse {
  text: string;
  word_count?: number;
  words?: CloudflareWhisperWord[];
  vtt?: string;
}

export interface WhisperTranscriptionProgress {
  phase:
    | "extracting"
    | "uploading"
    | "transcribing"
    | "processing"
    | "complete"
    | "error"
    | "cancelled";
  progress: number;
  message: string;
  /**
   * Raw error text kept readable for debugging; rendered as a secondary
   * detail line under the localized failure title on error phases.
   */
  detail?: string;
}

/**
 * Machine-readable categories for cloud-request failures. The UI maps
 * these to localized failure titles instead of surfacing raw browser
 * error text.
 */
export type CloudFailureKind =
  | "network"
  | "server"
  | "rateLimited"
  | "taskFailed"
  | "timeout"
  | "responseInvalid";

/**
 * A cloud-request failure that carries its classification. `detail`
 * keeps the original human-readable text (server body, browser message,
 * etc.) so it stays readable as a secondary line for debugging.
 */
export class CloudRequestError extends Error {
  readonly kind: CloudFailureKind;
  readonly status?: number | undefined;
  readonly detail: string;

  constructor(kind: CloudFailureKind, detail: string, status?: number) {
    super(detail);
    this.name = "CloudRequestError";
    this.kind = kind;
    this.status = status;
    this.detail = detail;
  }
}

// The upload request must fail fast instead of hanging on the browser
// default timeout; the job poll loop keeps its own bounded budget below.
const SUBMIT_TIMEOUT_MS = 120_000;
const POLL_MAX_ATTEMPTS = 120;
const POLL_INTERVAL_MS = 3000;
// A healthy job poll answers within a couple of attempts; this many
// consecutive failures (server errors or lost connection) means the
// service is down and the wait must surface instead of spinning.
const POLL_MAX_CONSECUTIVE_FAILURES = 5;

function createAbortError(message: string): Error {
  if (typeof DOMException === "function") {
    return new DOMException(message, "AbortError");
  }
  const err = new Error(message);
  err.name = "AbortError";
  return err;
}

function isTimeoutAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}

/**
 * Combines optional abort signals into one; the returned signal aborts
 * when any input aborts. Returns undefined when no signal is given so
 * fetch stays unabortable exactly as before.
 */
function linkAbortSignals(
  signals: (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const composite = new AbortController();
  let linked = false;
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      composite.abort(signal.reason);
      return composite.signal;
    }
    signal.addEventListener("abort", () => composite.abort(signal.reason), {
      once: true,
    });
    linked = true;
  }
  return linked ? composite.signal : undefined;
}

function createSubmitTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
    : undefined;
}

export interface TranscriptionConfig {
  apiEndpoint: string;
  apiKey?: string;
  language?: string;
  targetLanguage?: string;
  maxSegmentDuration?: number;
  maxWordsPerSegment?: number;
}

const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  fontFamily: "Arial",
  fontSize: 24,
  color: "#ffffff",
  backgroundColor: "rgba(0, 0, 0, 0.7)",
  position: "bottom",
};

export class TranscriptionService {
  private config: TranscriptionConfig;
  private audioContext: AudioContext | null = null;
  private activeController: AbortController | null = null;

  constructor(config: TranscriptionConfig) {
    this.config = {
      maxSegmentDuration: 5,
      maxWordsPerSegment: 10,
      ...config,
    };
  }

  /**
   * Aborts the in-flight run (upload + result polling). The run unwinds
   * without an error: transcribeClip resolves with no subtitles and its
   * caller resets to the pre-run state, so nothing half-finished stays
   * behind. No-op when nothing is running.
   */
  cancelActiveRun(): void {
    this.activeController?.abort(createAbortError("Transcription cancelled"));
  }

  async transcribeClip(
    clip: Clip,
    mediaItem: MediaItem,
    onProgress?: (progress: WhisperTranscriptionProgress) => void,
    abortSignal?: AbortSignal,
  ): Promise<Subtitle[]> {
    const controller = new AbortController();
    this.activeController = controller;
    if (abortSignal) {
      if (abortSignal.aborted) {
        controller.abort(abortSignal.reason);
      } else {
        abortSignal.addEventListener(
          "abort",
          () => controller.abort(abortSignal.reason),
          { once: true },
        );
      }
    }
    const signal = controller.signal;
    const throwIfCancelled = () => {
      if (signal.aborted) {
        throw createAbortError("Transcription cancelled");
      }
    };

    try {
      onProgress?.({
        phase: "extracting",
        progress: 0,
        message: "Extracting audio from video...",
      });

      throwIfCancelled();
      const audioBlob = await this.extractAudioFromClip(clip, mediaItem);
      throwIfCancelled();

      onProgress?.({
        phase: "uploading",
        progress: 25,
        message: "Uploading audio for transcription...",
      });

      const whisperResponse = await this.sendToWhisper(
        audioBlob,
        onProgress,
        signal,
      );
      throwIfCancelled();

      onProgress?.({
        phase: "processing",
        progress: 90,
        message: "Processing transcription...",
      });

      const subtitles = this.convertToSubtitles(whisperResponse, clip);

      onProgress?.({
        phase: "complete",
        progress: 100,
        message: `Generated ${subtitles.length} subtitles`,
      });

      return subtitles;
    } catch (error) {
      if (signal.aborted) {
        // Cancellation is not a failure: unwind with zero subtitles and
        // no error event, so the caller resets to the pre-run state.
        onProgress?.({
          phase: "cancelled",
          progress: 0,
          message: "Transcription cancelled",
        });
        return [];
      }
      onProgress?.({
        phase: "error",
        progress: 0,
        message:
          error instanceof Error ? error.message : "Transcription failed",
      });
      throw error;
    } finally {
      if (this.activeController === controller) {
        this.activeController = null;
      }
    }
  }

  private async extractAudioFromClip(
    clip: Clip,
    mediaItem: MediaItem,
  ): Promise<Blob> {
    if (!this.audioContext) {
      this.audioContext = new AudioContext();
    }

    let arrayBuffer: ArrayBuffer;

    if (mediaItem.blob) {
      arrayBuffer = await mediaItem.blob.arrayBuffer();
    } else if (mediaItem.fileHandle) {
      const file = await mediaItem.fileHandle.getFile();
      arrayBuffer = await file.arrayBuffer();
    } else {
      throw new Error("No media source available for audio extraction");
    }

    const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);

    const inPoint = clip.inPoint || 0;
    const outPoint = clip.outPoint || audioBuffer.duration;
    // A sped-up clip consumes clip.duration * speed seconds of SOURCE audio, so
    // the extracted window spans the source range the clip actually plays — not
    // just clip.duration source seconds (which would truncate a 2x clip's
    // captions to the first half).
    const speed = clip.speed || 1;
    const duration = Math.min(outPoint - inPoint, clip.duration * speed);

    const sampleRate = audioBuffer.sampleRate;
    const startSample = Math.floor(inPoint * sampleRate);
    const endSample = Math.floor((inPoint + duration) * sampleRate);
    const numSamples = endSample - startSample;

    const offlineContext = new OfflineAudioContext(1, numSamples, sampleRate);
    const source = offlineContext.createBufferSource();

    const trimmedBuffer = offlineContext.createBuffer(
      1,
      numSamples,
      sampleRate,
    );
    const channelData = trimmedBuffer.getChannelData(0);
    const sourceData = audioBuffer.getChannelData(0);

    for (let i = 0; i < numSamples; i++) {
      channelData[i] = sourceData[startSample + i] || 0;
    }

    source.buffer = trimmedBuffer;
    source.connect(offlineContext.destination);
    source.start(0);

    const renderedBuffer = await offlineContext.startRendering();
    return encodePcm16Wav(renderedBuffer);
  }

  private async sendToWhisper(
    audioBlob: Blob,
    onProgress?: (progress: WhisperTranscriptionProgress) => void,
    signal?: AbortSignal,
  ): Promise<CloudflareWhisperResponse> {
    const formData = new FormData();
    formData.append("audio", audioBlob, "audio.wav");

    if (this.config.language) {
      formData.append("language", this.config.language);
    }
    if (this.config.targetLanguage) {
      formData.append("target_language", this.config.targetLanguage);
    }

    onProgress?.({
      phase: "transcribing",
      progress: 30,
      message: "Uploading audio...",
    });

    const timeoutSignal = createSubmitTimeoutSignal();
    let response: Response;
    try {
      response = await fetch(this.config.apiEndpoint, {
        method: "POST",
        body: formData,
        signal: linkAbortSignals([signal, timeoutSignal]),
      });
    } catch (err) {
      if (signal?.aborted || isAbortError(err)) throw err;
      if (isTimeoutAbort(err)) {
        throw new CloudRequestError(
          "timeout",
          `Transcription upload timed out after ${Math.round(SUBMIT_TIMEOUT_MS / 1000)} seconds`,
        );
      }
      throw new CloudRequestError(
        "network",
        `Could not reach the transcription service (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      if (response.status === 429) {
        throw new CloudRequestError(
          "rateLimited",
          "Rate limit reached. Please wait a minute before transcribing more audio. This free service is limited to 10 requests per minute.",
          response.status,
        );
      }
      throw new CloudRequestError(
        "server",
        `Transcription failed: ${response.status}${errorText ? ` - ${errorText}` : ""}`,
        response.status,
      );
    }

    let submitResult: Partial<CloudflareWhisperResponse> & {
      jobId?: string;
    };
    try {
      submitResult = await response.json();
    } catch {
      throw new CloudRequestError(
        "responseInvalid",
        "Transcription service returned a response that is not valid JSON",
      );
    }

    if (!submitResult.jobId) {
      return submitResult as CloudflareWhisperResponse;
    }

    const baseUrl = this.config.apiEndpoint.replace(/\/transcribe$/, "").replace(/\/$/, "");
    const pollUrl = `${baseUrl}/jobs/${submitResult.jobId}`;

    return this.pollForResult(pollUrl, onProgress, signal);
  }

  private async pollForResult(
    pollUrl: string,
    onProgress?: (progress: WhisperTranscriptionProgress) => void,
    signal?: AbortSignal,
  ): Promise<CloudflareWhisperResponse> {
    let consecutiveFailures = 0;

    for (let attempt = 0; attempt < POLL_MAX_ATTEMPTS; attempt++) {
      await this.delay(POLL_INTERVAL_MS, signal);

      let response: Response;
      try {
        response = await fetch(pollUrl, { signal });
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) throw err;
        consecutiveFailures += 1;
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          // A job poll that keeps failing is a visible outage, not a
          // reason to keep waiting: surface it instead of spinning.
          throw new CloudRequestError(
            "network",
            `Lost contact with the transcription service while waiting for the job (${err instanceof Error ? err.message : String(err)})`,
          );
        }
        continue;
      }

      if (!response.ok) {
        if (response.status === 404) {
          throw new CloudRequestError(
            "server",
            "Transcription job not found",
            response.status,
          );
        }
        consecutiveFailures += 1;
        if (consecutiveFailures >= POLL_MAX_CONSECUTIVE_FAILURES) {
          throw new CloudRequestError(
            "server",
            `Transcription service kept failing while waiting for the job (last status: ${response.status})`,
            response.status,
          );
        }
        continue;
      }

      consecutiveFailures = 0;

      let job: {
        status?: string;
        progress?: number;
        result?: CloudflareWhisperResponse;
        error?: string;
      };
      try {
        job = await response.json();
      } catch {
        throw new CloudRequestError(
          "responseInvalid",
          "Transcription service returned a job status that is not valid JSON",
        );
      }

      if (job.status === "processing") {
        const progress = 30 + Math.round((job.progress || 0) * 0.6);
        onProgress?.({
          phase: "transcribing",
          progress,
          message: this.config.targetLanguage
            ? `Transcribing and translating to ${this.config.targetLanguage}...`
            : "Transcribing audio...",
        });
        continue;
      }

      if (job.status === "completed" && job.result) {
        return job.result as CloudflareWhisperResponse;
      }

      if (job.status === "failed") {
        throw new CloudRequestError(
          "taskFailed",
          job.error || "Transcription failed on server",
        );
      }
    }

    throw new CloudRequestError(
      "timeout",
      "Transcription timed out after 6 minutes",
    );
  }

  private delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? createAbortError("Transcription cancelled"));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(signal?.reason ?? createAbortError("Transcription cancelled"));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private convertToSubtitles(
    response: CloudflareWhisperResponse,
    clip: Clip,
  ): Subtitle[] {
    if (!response.words || response.words.length === 0) {
      if (!response.text) return [];

      return [
        {
          id: this.generateId(),
          text: response.text.trim(),
          startTime: clip.startTime,
          endTime: clip.startTime + clip.duration,
          style: DEFAULT_SUBTITLE_STYLE,
          words: undefined,
          animationStyle: "none",
        },
      ];
    }

    return this.groupWordsIntoSubtitles(
      response.words,
      clip.startTime,
      clip.speed || 1,
    );
  }

  private groupWordsIntoSubtitles(
    words: CloudflareWhisperWord[],
    clipStartTime: number,
    speed: number,
  ): Subtitle[] {
    const subtitles: Subtitle[] = [];
    const maxWords = this.config.maxWordsPerSegment || 10;
    const maxDuration = this.config.maxSegmentDuration || 5;

    let currentWords: CloudflareWhisperWord[] = [];
    let groupStart = 0;

    for (const word of words) {
      if (currentWords.length === 0) {
        groupStart = word.start;
      }

      const wouldExceedWords = currentWords.length >= maxWords;
      const wouldExceedDuration = word.end - groupStart > maxDuration;
      const isPunctuation = /[.!?]$/.test(word.word);

      if (
        (wouldExceedWords || wouldExceedDuration) &&
        currentWords.length > 0
      ) {
        subtitles.push(
          this.createSubtitleFromWords(currentWords, clipStartTime, speed),
        );
        currentWords = [word];
        groupStart = word.start;
      } else {
        currentWords.push(word);

        if (isPunctuation && currentWords.length >= 3) {
          subtitles.push(
            this.createSubtitleFromWords(currentWords, clipStartTime, speed),
          );
          currentWords = [];
        }
      }
    }

    if (currentWords.length > 0) {
      subtitles.push(
        this.createSubtitleFromWords(currentWords, clipStartTime, speed),
      );
    }

    return subtitles;
  }

  private createSubtitleFromWords(
    words: CloudflareWhisperWord[],
    clipStartTime: number,
    speed: number,
  ): Subtitle {
    const text = words
      .map((w) => w.word)
      .join(" ")
      .trim();
    // Word times are SOURCE-relative seconds (the audio was trimmed to the
    // clip window before transcription, so 0 = inPoint). A source-second plays
    // back compressed/stretched by `speed` on the timeline.
    const safeSpeed = speed || 1;
    const startTime = clipStartTime + words[0].start / safeSpeed;
    const endTime = clipStartTime + words[words.length - 1].end / safeSpeed;

    return {
      id: this.generateId(),
      text,
      startTime,
      endTime,
      style: DEFAULT_SUBTITLE_STYLE,
      words: words.map((w) => ({
        text: w.word,
        startTime: clipStartTime + w.start / safeSpeed,
        endTime: clipStartTime + w.end / safeSpeed,
      })),
      animationStyle: "none",
    };
  }

  private generateId(): string {
    return `sub-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
  }

  dispose(): void {
    // A disposed service must not leave an orphaned upload or poll loop.
    this.cancelActiveRun();
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}

let transcriptionServiceInstance: TranscriptionService | null = null;

export function getTranscriptionService(): TranscriptionService | null {
  return transcriptionServiceInstance;
}

export function initializeTranscriptionService(
  config: TranscriptionConfig,
): TranscriptionService {
  if (transcriptionServiceInstance) {
    transcriptionServiceInstance.dispose();
  }
  transcriptionServiceInstance = new TranscriptionService(config);
  return transcriptionServiceInstance;
}

export function disposeTranscriptionService(): void {
  if (transcriptionServiceInstance) {
    transcriptionServiceInstance.dispose();
    transcriptionServiceInstance = null;
  }
}
