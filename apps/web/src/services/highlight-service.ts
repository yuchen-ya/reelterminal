import {
  analyzeAudioForHighlights,
  type TranscriptWord,
  type AudioSegmentMetrics,
} from "@openreel/core";
import { OPENREEL_CLOUD_URL } from "../config/api-endpoints";

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
 * Base URL of the highlight AI, read from the central endpoint registry.
 * This replaces the former module-private VITE_CLOUD_API_URL read; the
 * registry still honors that variable as a compatibility alias, and in
 * dev builds the URL now follows the shared dev/prod switch like every
 * other first-party cloud service (previously it always pointed at
 * production).
 */
const API_BASE = OPENREEL_CLOUD_URL;

export async function extractHighlights(
  audioBuffer: AudioBuffer,
  transcript: TranscriptWord[],
  preferences: Partial<HighlightPreferences> = {},
  onProgress?: ProgressCallback,
): Promise<HighlightResult[]> {
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

  const response = await fetch(`${API_BASE}/highlights`, {
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
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error((errorData as { error?: string }).error || `API error: ${response.status}`);
  }

  onProgress?.("ai", 80, "Processing AI response...");
  const data = (await response.json()) as { highlights: HighlightResult[] };

  onProgress?.("done", 100, "Highlights ready");
  return data.highlights;
}
