import {
  analyzeAudioForHighlights,
  CloudRequestError,
  type TranscriptWord,
  type AudioSegmentMetrics,
} from "@reelterminal/core";
import { REELTERMINAL_CLOUD_ENABLED, REELTERMINAL_CLOUD_URL } from "../config/api-endpoints";

export interface HighlightResult {
  start: number;
  end: number;
  score: number;
  title: string;
  reason: string;
}

export interface HighlightPreferences {
  targetClipCount: number;
  minClipDuration: number;
  maxClipDuration: number;
  contentType: string;
}

const DEFAULT_PREFERENCES: HighlightPreferences = {
  targetClipCount: 5,
  minClipDuration: 5,
  maxClipDuration: 60,
  contentType: "video",
};

type ProgressCallback = (phase: string, progress: number, message: string) => void;

/**
 * Highlight service URL from the shared cloud endpoint configuration.
 */
const API_BASE = REELTERMINAL_CLOUD_URL;

// Same budget as the cloud transcription upload: the request must fail
// fast with an understandable timeout instead of hanging on the browser
// default. There is no retry loop here — retries stay user-driven.
const SUBMIT_TIMEOUT_MS = 120_000;

function createSubmitTimeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(SUBMIT_TIMEOUT_MS)
    : undefined;
}

function isTimeoutAbort(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "TimeoutError";
}

export async function extractHighlights(
  audioBuffer: AudioBuffer,
  transcript: TranscriptWord[],
  preferences: Partial<HighlightPreferences> = {},
  onProgress?: ProgressCallback,
): Promise<HighlightResult[]> {
  if (!REELTERMINAL_CLOUD_ENABLED) throw new Error("Cloud highlight analysis is unavailable in this local build.");
  const prefs = { ...DEFAULT_PREFERENCES, ...preferences };

  onProgress?.("analyze", 10, "Analyzing audio energy...");
  const analysis = analyzeAudioForHighlights(audioBuffer, transcript);

  onProgress?.("analyze", 30, "Preparing data for AI...");
  const energyData = analysis.segments
    .filter((seg) => !seg.isSilence)
    .map((seg: AudioSegmentMetrics) => ({
      start: seg.start,
      end: seg.end,
      rmsDb: seg.rmsDb,
      peakDb: seg.peakDb,
    }));

  onProgress?.("ai", 40, "Sending to AI for highlight detection...");

  let response: Response;
  try {
    response = await fetch(`${API_BASE}/highlights`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        transcript: transcript.map((w) => ({
          text: w.text,
          start: w.start,
          end: w.end,
        })),
        energy: energyData,
        duration: analysis.duration,
        preferences: prefs,
      }),
      signal: createSubmitTimeoutSignal(),
    });
  } catch (err) {
    if (isTimeoutAbort(err)) {
      throw new CloudRequestError(
        "timeout",
        `Highlight analysis request timed out after ${Math.round(SUBMIT_TIMEOUT_MS / 1000)} seconds`,
      );
    }
    throw new CloudRequestError(
      "network",
      `Could not reach the highlight analysis service (${err instanceof Error ? err.message : String(err)})`,
    );
  }

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    const serverMessage = (errorData as { error?: string }).error;
    throw new CloudRequestError(
      response.status === 429 ? "rateLimited" : "server",
      serverMessage || `API error: ${response.status}`,
      response.status,
    );
  }

  onProgress?.("ai", 80, "Processing AI response...");
  let data: { highlights?: HighlightResult[] };
  try {
    data = (await response.json()) as { highlights?: HighlightResult[] };
  } catch {
    throw new CloudRequestError(
      "responseInvalid",
      "Highlight analysis service returned a response that is not valid JSON",
    );
  }

  if (!Array.isArray(data.highlights)) {
    throw new CloudRequestError(
      "responseInvalid",
      "Highlight analysis service returned no highlights list",
    );
  }

  onProgress?.("done", 100, "Highlights ready");
  return data.highlights;
}
