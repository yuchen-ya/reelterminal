import React from "react";
import { Zap, Captions, Loader2, Upload } from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@openreel/ui";
import { ToolcraftCard as Card } from "@openreel/ui";
import { ToolcraftFileDropControl as FileInput } from "@openreel/ui";
import { ToolcraftProgressBar as ProgressBar } from "@openreel/ui";
import { ToolcraftSelectControl as Selector } from "@openreel/ui";
import { ToolcraftText as Text } from "@openreel/ui";
import {
  type WhisperTranscriptionProgress,
  type CaptionAnimationStyle,
  CAPTION_ANIMATION_STYLES,
  getAnimationStyleDisplayName,
} from "@openreel/core";
import { AutoReframeSection } from "../";
import { AutoCaptionPanel } from "../AutoCaptionPanel";
import { CaptionEditorPanel } from "../CaptionEditorPanel";
import { AutoEditPanel } from "../../panels/AutoEditPanel";
import { HighlightExtractorPanel } from "../../panels/HighlightExtractorPanel";
import { InspectorSection } from "../shell/InspectorSection";
import { OPENREEL_CLOUD_ENABLED } from "../../../../config/api-endpoints";
import { useTranslation } from "react-i18next";

export interface AiTabProps {
  clipId: string;
  clipType: string | null;
  showVideoControls: boolean;
  showAudioEffects: boolean;
  showVideoEffects: boolean;
  transcriptionProgress: WhisperTranscriptionProgress | null;
  isTranscribing: boolean;
  targetLanguage: string;
  setTargetLanguage: React.Dispatch<React.SetStateAction<string>>;
  defaultAnimationStyle: CaptionAnimationStyle;
  setDefaultAnimationStyle: React.Dispatch<
    React.SetStateAction<CaptionAnimationStyle>
  >;
  handleGenerateSubtitles: () => Promise<void>;
  handleSRTImport: (
    event: React.ChangeEvent<HTMLInputElement>,
  ) => Promise<void>;
  srtInputRef: React.RefObject<HTMLInputElement | null>;
  handleRemoveBackground: () => void;
  handleEnhanceAudio: () => Promise<void>;
  handleAutoColor: () => Promise<void>;
  isEnhancingAudio: boolean;
  audioEnhanced: boolean;
  isApplyingSelectedClipEffect: boolean;
  captionWordsPerLine: number;
  onCaptionWordsPerLineChange: (value: number) => void;
}

export const AiTab: React.FC<AiTabProps> = ({
  clipId,
  clipType,
  showVideoControls,
  showAudioEffects,
  showVideoEffects,
  transcriptionProgress,
  isTranscribing,
  targetLanguage,
  setTargetLanguage,
  defaultAnimationStyle,
  setDefaultAnimationStyle,
  handleGenerateSubtitles,
  handleSRTImport,
  srtInputRef,
  handleRemoveBackground,
  handleEnhanceAudio,
  handleAutoColor,
  isEnhancingAudio,
  audioEnhanced,
  isApplyingSelectedClipEffect,
  captionWordsPerLine,
  onCaptionWordsPerLineChange,
}) => {
  const { t } = useTranslation();
  const cloudTranscribeEnabled = OPENREEL_CLOUD_ENABLED;
  return (
    <>
      {clipType === "video" && (
        <>
          <InspectorSection
            title={t("Local Auto-Captions")}
            sectionId="auto-captions"
            defaultOpen={false}
          >
            <div className="space-y-3">
              <AutoCaptionPanel
                clipId={clipId}
                maxWordsPerLine={captionWordsPerLine}
              />
              <FileInput
                ref={srtInputRef}
                label={t("Import SRT or VTT file")}
                isLabelHidden
                value={null}
                accept=".srt,.vtt,text/srt,text/vtt,text/plain"
                onChange={(files) => {
                  const file = Array.isArray(files) ? files[0] : files;
                  if (!file) return;
                  void handleSRTImport({
                    target: { files: [file] },
                  } as unknown as React.ChangeEvent<HTMLInputElement>);
                }}
                className="hidden"
              />
              <div className="space-y-1">
                <Selector
                  label={t("Animation Style")}
                  size="sm"
                  width="100%"
                  value={defaultAnimationStyle}
                  onChange={(v) =>
                    setDefaultAnimationStyle(v as CaptionAnimationStyle)
                  }
                  isDisabled={isTranscribing}
                  options={CAPTION_ANIMATION_STYLES.map((style) => ({
                    label: getAnimationStyleDisplayName(style),
                    value: style,
                  }))}
                />
              </div>

              <div className="space-y-1">
                <Selector
                  label={t("Target Language")}
                  size="sm"
                  width="100%"
                  value={targetLanguage}
                  onChange={setTargetLanguage}
                  isDisabled={isTranscribing}
                  options={[
                    { label: t("Original (no translation)"), value: "none" },
                    { label: t("English"), value: "en" },
                    { label: t("Spanish"), value: "es" },
                    { label: t("French"), value: "fr" },
                    { label: t("German"), value: "de" },
                    { label: t("Portuguese"), value: "pt" },
                    { label: t("Italian"), value: "it" },
                    { label: t("Dutch"), value: "nl" },
                    { label: t("Russian"), value: "ru" },
                    { label: t("Chinese"), value: "zh" },
                    { label: t("Japanese"), value: "ja" },
                    { label: t("Korean"), value: "ko" },
                    { label: t("Arabic"), value: "ar" },
                    { label: t("Hindi"), value: "hi" },
                    { label: t("Turkish"), value: "tr" },
                    { label: t("Polish"), value: "pl" },
                    { label: t("Swedish"), value: "sv" },
                  ]}
                />
              </div>

              {transcriptionProgress ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2">
                    <Loader2
                      size={12}
                      className="animate-spin text-primary"
                    />
                    <Text type="supporting" color="primary" className="text-[10px]">
                      {transcriptionProgress.message}
                    </Text>
                  </div>
                    <ProgressBar
                      label={t("Caption generation progress")}
                      isLabelHidden
                      value={transcriptionProgress.progress}
                      max={100}
                      hasValueLabel={false}
                      variant={
                        transcriptionProgress.phase === "error"
                          ? "error"
                          : transcriptionProgress.phase === "complete"
                            ? "success"
                            : "accent"
                      }
                    />
                    {transcriptionProgress.phase === "error" &&
                      cloudTranscribeEnabled && (
                        // Persistent failure needs an explicit way back in:
                        // Retry re-issues the transcription once, no auto-retry.
                        <Button
                          label={t("templates.retry")}
                          onClick={handleGenerateSubtitles}
                          isDisabled={isTranscribing}
                          variant="secondary"
                          size="sm"
                          className="w-full justify-center"
                        />
                      )}
                  </div>
                ) : (
                  <div className="space-y-1">
                    <Button
                      label={t("cloud.transcribeButton")}
                      onClick={handleGenerateSubtitles}
                      isDisabled={isTranscribing || !cloudTranscribeEnabled}
                      variant="primary"
                      size="sm"
                      icon={<Captions size={14} aria-hidden />}
                      className="w-full justify-center"
                    />
                    {cloudTranscribeEnabled ? (
                      // PLAN §5.3: say what is uploaded and to which service
                      // before the upload can happen (no extra dialog flow).
                      <Text
                        type="supporting"
                        className="block text-[10px] text-text-muted"
                      >
                        {t("cloud.transcribeUploadNotice")}
                      </Text>
                    ) : (
                      <Text
                        type="supporting"
                        className="block text-[10px] text-text-muted"
                      >
                        {t("cloud.transcribeDisabled")}
                      </Text>
                    )}
                  </div>
                )}
              <Button
                label={t("Import SRT / VTT as Text")}
                onClick={() => srtInputRef.current?.click()}
                isDisabled={isTranscribing}
                variant="secondary"
                size="sm"
                icon={<Upload size={13} aria-hidden />}
                className="w-full justify-center"
              />
            </div>
          </InspectorSection>
        </>
      )}

      {clipType === "video" && (
        <InspectorSection
          title={t("Editable Captions")}
          sectionId="editable-captions"
          defaultOpen={false}
        >
          <CaptionEditorPanel
            maxWordsPerLine={captionWordsPerLine}
            onMaxWordsPerLineChange={onCaptionWordsPerLineChange}
          />
        </InspectorSection>
      )}

      {clipType === "video" && (
        <InspectorSection
          title={t("Auto Reframe")}
          sectionId="auto-reframe"
          defaultOpen={false}
        >
          <AutoReframeSection clipId={clipId} />
        </InspectorSection>
      )}

      {showAudioEffects && (
        <InspectorSection
          title={t("Beat-Synced Auto-Edit")}
          sectionId="auto-edit"
          defaultOpen={false}
        >
          <AutoEditPanel onClose={() => {}} />
        </InspectorSection>
      )}

      {showAudioEffects && (
        <InspectorSection
          title={t("AI Highlights")}
          sectionId="ai-highlights"
          defaultOpen={false}
        >
          <HighlightExtractorPanel clipId={clipId} />
        </InspectorSection>
      )}

      {(showVideoControls || showAudioEffects || showVideoEffects) && (
        <Card
          variant="green"
          padding={4}
          className="relative overflow-hidden border border-primary/30 bg-primary/5"
        >
          <div className="flex items-center gap-2 text-primary mb-3">
            <Zap size={14} />
            <Text type="supporting" color="active" className="text-xs font-bold">
              {t("Quick Actions")}</Text>
          </div>
          <div className="space-y-2">
            {showVideoControls && (
              <Button
                label={t("Remove Background")}
                onClick={handleRemoveBackground}
                isDisabled={isApplyingSelectedClipEffect}
                variant="secondary"
                size="sm"
                className={`w-full justify-center ${
                  isApplyingSelectedClipEffect
                    ? "bg-bg-2 border-border text-fg-3"
                    : "bg-bg-2 hover:bg-primary hover:text-white border-border hover:border-primary"
                }`}
              />
            )}
            {showAudioEffects && (
              <Button
                label={
                  isEnhancingAudio
                    ? t("Cleaning up...")
                    : audioEnhanced
                      ? t("Noise Reduced")
                      : t("Quick Dialogue Cleanup")
                }
                onClick={handleEnhanceAudio}
                isDisabled={isEnhancingAudio || isApplyingSelectedClipEffect}
                variant="secondary"
                size="sm"
                icon={isEnhancingAudio ? <Loader2 size={12} className="animate-spin" aria-hidden /> : undefined}
                className={`w-full justify-center ${
                  audioEnhanced
                    ? "bg-green-500/20 border-green-500 text-green-400"
                    : isEnhancingAudio || isApplyingSelectedClipEffect
                      ? "bg-bg-2 border-border text-fg-3"
                      : "bg-bg-2 hover:bg-primary hover:text-white border-border hover:border-primary"
                }`}
              />
            )}
            {showVideoEffects && (
              <Button
                label={isApplyingSelectedClipEffect ? t("Applying...") : t("Auto-Color")}
                onClick={handleAutoColor}
                isDisabled={isApplyingSelectedClipEffect}
                variant="secondary"
                size="sm"
                className={`w-full justify-center ${
                  isApplyingSelectedClipEffect
                    ? "bg-bg-2 border-border text-fg-3"
                    : "bg-bg-2 hover:bg-primary hover:text-white border-border hover:border-primary"
                }`}
              />
            )}
          </div>
        </Card>
      )}
    </>
  );
};
