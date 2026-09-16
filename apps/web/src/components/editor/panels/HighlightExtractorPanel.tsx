import React, { useState, useCallback, useEffect, useRef } from "react";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftIconButton as IconButton } from "@openreel/ui";
import { ToolcraftNumberInputControl } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import { Sparkles, Play, Check, Loader2 } from "@/icons/lucide-compat";
import { useProjectStore } from "../../../stores/project-store";
import { useTimelineStore } from "../../../stores/timeline-store";
import { applyHighlightRanges } from "../../../services/highlight-apply";
import {
  getTranscriptionService,
  initializeTranscriptionService,
  type TranscriptWord,
} from "@openreel/core";
import {
  OPENREEL_CLOUD_ENABLED,
  OPENREEL_TRANSCRIBE_URL,
} from "../../../config/api-endpoints";
import { t } from "../../../i18n";
import {
  extractHighlights,
  type HighlightResult,
  type HighlightPreferences,
} from "../../../services/highlight-service";
import {
  classifyCloudError,
  cloudFailureMessage,
} from "../../../services/cloud-error";
import { useTranslation } from "react-i18next";

interface HighlightExtractorPanelProps {
  clipId: string;
}

export const HighlightExtractorPanel: React.FC<HighlightExtractorPanelProps> = ({
  clipId,
}) => {
  const { t: tr } = useTranslation();
  const [highlights, setHighlights] = useState<HighlightResult[]>([]);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [phase, setPhase] = useState("");
  const [progress, setProgress] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failureDetail, setFailureDetail] = useState<string | null>(null);

  const project = useProjectStore((s) => s.project);
  const getMediaItem = useProjectStore((s) => s.getMediaItem);
  const seekTo = useTimelineStore((s) => s.seekTo);

  // The in-flight analysis run is aborted when the panel unmounts, so no
  // upload or poll loop outlives the component and no setState lands on
  // a dead component.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const [preferences, setPreferences] = useState<HighlightPreferences>({
    targetClipCount: 5,
    minClipDuration: 5,
    maxClipDuration: 60,
    contentType: "video",
  });

  // Build-time cloud switch: highlight analysis (and its transcription
  // prerequisite) belongs to the first-party cloud domain.
  const cloudEnabled = OPENREEL_CLOUD_ENABLED;

  const handleAnalyze = useCallback(async () => {
    if (!project) return;

    const clip = project.timeline.tracks
      .flatMap((t) => t.clips)
      .find((c) => c.id === clipId);
    if (!clip) return;

    const mediaItem = getMediaItem(clip.mediaId);
    if (!mediaItem?.blob) {
      setError("Media not found or not loaded");
      return;
    }

    if (!cloudEnabled) {
      // Cloud-disabled build: explain through the existing error line and
      // return before any transcription service, audio extraction, or
      // highlight request can happen.
      setError(t("cloud.highlightDisabled"));
      return;
    }

    setIsProcessing(true);
    setError(null);
    setFailureDetail(null);
    setHighlights([]);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      setPhase("Transcribing audio...");
      setProgress(5);

      const transcriptionService = getTranscriptionService() || initializeTranscriptionService({
        apiEndpoint: `${OPENREEL_TRANSCRIBE_URL}/transcribe`,
      });
      const subtitles = await transcriptionService.transcribeClip(
        clip,
        mediaItem,
        (p) => setProgress(Math.round(p.progress * 20)),
        controller.signal,
      );
      if (controller.signal.aborted) return;

      const transcript: TranscriptWord[] = subtitles.flatMap((sub) =>
        sub.words
          ? sub.words.map((w) => ({ text: w.text, start: w.startTime, end: w.endTime }))
          : [{ text: sub.text, start: sub.startTime, end: sub.endTime }],
      );

      if (transcript.length === 0) {
        throw new Error("No transcript words found");
      }

      setPhase("Decoding audio...");
      setProgress(25);

      const arrayBuffer = await mediaItem.blob.arrayBuffer();
      const audioContext = new OfflineAudioContext(1, 44100, 44100);
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);

      const results = await extractHighlights(
        audioBuffer,
        transcript,
        preferences,
        (phaseName, prog) => {
          setPhase(phaseName);
          setProgress(25 + Math.round(prog * 0.75));
        },
      );

      setHighlights(results);
      setSelected(new Set(results.map((_, i) => i)));
    } catch (err) {
      // Cloud failures get a categorized, localized title ("service
      // unreachable", "rate limited", ...) with the raw message kept as
      // the detail text for debugging. Local failures keep the generic
      // analysis-failed wording so they are not mistaken for an outage.
      const classified = classifyCloudError(err);
      const failure = cloudFailureMessage(classified);
      if (failure) {
        setError(tr(failure.key, failure.options));
        setFailureDetail(failure.showDetail ? classified.detail : null);
      } else {
        setError(tr("cloud.highlightFailed", { message: classified.detail }));
        setFailureDetail(null);
      }
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
      }
      setIsProcessing(false);
      setPhase("");
      setProgress(0);
    }
  }, [clipId, project, getMediaItem, preferences, cloudEnabled, tr]);

  const handlePreview = useCallback(
    (highlight: HighlightResult) => {
      seekTo(highlight.start);
    },
    [seekTo],
  );

  const toggleSelect = useCallback((index: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  }, []);

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, "0")}`;
  };

  return (
    <div className="space-y-3">
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <Text type="label" color="secondary" className="text-[10px] text-text-secondary">{tr("Clips")}</Text>
          <ToolcraftNumberInputControl
            label={tr("Clips")}
            isLabelHidden
            size="sm"
            width={48}
            min={1}
            max={20}
            value={preferences.targetClipCount}
            onChange={(value) =>
              setPreferences((p) => ({ ...p, targetClipCount: value || 5 }))
            }
            className="w-12 px-1 py-0.5 text-[10px] bg-background-secondary border border-border rounded text-text-primary"
          />
          <Text type="label" color="secondary" className="text-[10px] text-text-secondary">{tr("Max")}</Text>
          <ToolcraftNumberInputControl
            label={tr("Max duration")}
            isLabelHidden
            size="sm"
            width={48}
            min={1}
            max={300}
            value={preferences.maxClipDuration}
            onChange={(value) =>
              setPreferences((p) => ({ ...p, maxClipDuration: value || 60 }))
            }
            className="w-12 px-1 py-0.5 text-[10px] bg-background-secondary border border-border rounded text-text-primary"
          />
          <span className="text-[10px] text-text-muted">s</span>
        </div>

        <Button
          label={
            isProcessing ? `${phase} (${progress}%)` : tr("Find Highlights")
          }
          icon={
            isProcessing ? (
              <Loader2 size={14} className="animate-spin" aria-hidden />
            ) : (
              <Sparkles size={14} aria-hidden />
            )
          }
          variant="primary"
          size="md"
          onClick={handleAnalyze}
          isDisabled={isProcessing || !cloudEnabled}
          className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-primary hover:bg-primary/90 text-white rounded text-[11px] font-medium transition-colors disabled:opacity-50"
        />

        {!cloudEnabled && (
          <Text
            type="supporting"
            className="block text-[10px] text-text-muted"
          >
            {tr("cloud.highlightDisabled")}
          </Text>
        )}

        {error && (
          <div className="space-y-1">
            <Text type="supporting" className="block text-[10px] text-red-400">
              {error}
            </Text>
            {failureDetail && (
              <Text
                type="supporting"
                className="block break-all text-[9px] text-text-muted"
              >
                {failureDetail}
              </Text>
            )}
            {cloudEnabled && !isProcessing && (
              // Same explicit retry contract as the captions entry: the
              // user re-issues the request once; nothing auto-retries.
              <Button
                label={tr("templates.retry")}
                onClick={handleAnalyze}
                isDisabled={isProcessing}
                variant="secondary"
                size="sm"
                className="w-full justify-center"
              />
            )}
          </div>
        )}
      </div>

      {highlights.length > 0 && (
        <div className="space-y-1.5">
          {highlights.map((highlight, index) => (
            <div
              key={index}
              className={`p-2 rounded border transition-colors cursor-pointer ${
                selected.has(index)
                  ? "bg-primary/10 border-primary/30"
                  : "bg-background-tertiary border-transparent hover:border-border"
              }`}
              onClick={() => toggleSelect(index)}
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                  <div
                    className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-bold text-white ${
                      highlight.score >= 8
                        ? "bg-green-500"
                        : highlight.score >= 5
                          ? "bg-yellow-500"
                          : "bg-gray-500"
                    }`}
                  >
                    {highlight.score}
                  </div>
                  <span className="text-[10px] text-text-primary font-medium truncate max-w-[140px]">
                    {tr(highlight.title)}
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  <IconButton
                    label={tr("Preview highlight")}
                    icon={<Play size={10} className="text-text-muted" aria-hidden />}
                    variant="ghost"
                    size="sm"
                    onClick={(e) => {
                      e.stopPropagation();
                      handlePreview(highlight);
                    }}
                    className="p-1 hover:bg-background-secondary rounded"
                  />
                  {selected.has(index) && (
                    <Check size={12} className="text-primary" />
                  )}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[9px] text-text-muted">
                  {formatTime(highlight.start)} - {formatTime(highlight.end)}
                </span>
                <span className="text-[9px] text-text-muted italic truncate max-w-[120px]">
                  {highlight.reason}
                </span>
              </div>
            </div>
          ))}

          <Button
            label={`Apply ${selected.size} Highlight${selected.size !== 1 ? "s" : ""}`}
            icon={<Check size={14} aria-hidden />}
            variant="primary"
            size="md"
            onClick={async () => {
              const selectedHighlights = highlights.filter((_, i) => selected.has(i));
              await applyHighlightRanges(
                clipId,
                selectedHighlights.map((h) => ({ start: h.start, end: h.end })),
              );
            }}
            isDisabled={selected.size === 0}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 bg-green-600 hover:bg-green-700 text-white rounded text-[11px] font-medium transition-colors disabled:opacity-50"
          />
        </div>
      )}
    </div>
  );
};

export default HighlightExtractorPanel;
