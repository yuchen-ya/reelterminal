import React, { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Subtitles,
  Palette,
  Music,
  Video,
  Layers,
  ChevronRight,
  Wand2,
  FileStack,
  Volume2,
  AudioLines,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button } from "@reelterminal/ui";
import { ToolcraftClickableCard as ClickableCard } from "@reelterminal/ui";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { AutoCaptionPanel } from "./inspector/AutoCaptionPanel";
import { FilterPresetsPanel } from "./inspector/FilterPresetsPanel";
import { MusicLibraryPanel } from "./inspector/MusicLibraryPanel";
import { TemplatesBrowserPanel } from "./inspector/TemplatesBrowserPanel";
import { MultiCameraPanel } from "./inspector/MultiCameraPanel";
import { AudioGenerationRequirementPanel } from "./AudioGenerationRequirementPanel";

type FeatureId = "templates" | "captions" | "filters" | "music" | "aiAudio" | "multicam" | null;

interface FeatureCardProps {
  icon: React.ElementType;
  title: string;
  description: string;
  iconColor: string;
  iconBg: string;
  activeBorder: string;
  activeBg: string;
  activeRing: string;
  isActive: boolean;
  onClick: () => void;
}

const FeatureCard: React.FC<FeatureCardProps> = ({
  icon: Icon,
  title,
  description,
  iconColor,
  iconBg,
  activeBorder,
  activeBg,
  activeRing,
  isActive,
  onClick,
}) => (
  <ClickableCard
    label={title}
    onClick={onClick}
    padding={3}
    variant={isActive ? "green" : "default"}
    className={`w-full min-w-0 text-left group ${
      isActive
        ? `${activeBorder} ${activeBg} ring-1 ${activeRing}`
        : "border-border bg-background-tertiary hover:border-border-strong hover:bg-background-elevated"
    }`}
  >
    <div className="flex items-center gap-3 min-w-0">
      <div
        className={`w-10 h-10 shrink-0 rounded-lg flex items-center justify-center transition-colors ${
          isActive ? iconBg : "bg-background-secondary group-hover:bg-background-tertiary"
        }`}
      >
        <Icon size={20} className={isActive ? iconColor : "text-text-secondary group-hover:text-text-primary"} aria-hidden />
      </div>
      <div className="flex-1 min-w-0 overflow-hidden">
        <div className="flex items-center justify-between gap-2">
          <Text type="label" weight="bold" maxLines={1} className="text-[12px]">
            {title}
          </Text>
          <ChevronRight
            size={14}
            className={`shrink-0 transition-transform ${isActive ? "rotate-90 text-text-primary" : "text-text-muted group-hover:text-text-secondary"}`}
            aria-hidden
          />
        </div>
        <Text type="supporting" color="secondary" display="block" maxLines={1} className="mt-0.5 text-[10px]">
          {description}
        </Text>
      </div>
    </div>
  </ClickableCard>
);

interface FeatureSectionProps {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}

const FeatureSection: React.FC<FeatureSectionProps> = ({ title, icon: Icon, children }) => (
  <div className="space-y-2 min-w-0">
    <div className="flex items-center gap-2 px-1">
      <Icon size={12} className="text-text-muted shrink-0" aria-hidden />
      <Text type="supporting" color="secondary" weight="bold" className="text-[10px] uppercase">
        {title}
      </Text>
    </div>
    <div className="space-y-1.5 min-w-0">{children}</div>
  </div>
);

export const EditingToolsTab: React.FC = () => {
  const { t } = useTranslation();
  const [activeFeature, setActiveFeature] = useState<FeatureId>(null);

  const navigateAway = useCallback((next: FeatureId) => {
    setActiveFeature(next);
  }, []);

  const handleFeatureClick = (id: FeatureId) => {
    navigateAway(activeFeature === id ? null : id);
  };

  const renderActivePanel = () => {
    switch (activeFeature) {
      case "templates":
        return <TemplatesBrowserPanel />;
      case "captions":
        return <AutoCaptionPanel />;
      case "filters":
        return <FilterPresetsPanel />;
      case "music":
        return <MusicLibraryPanel />;
      case "aiAudio":
        return <AudioGenerationRequirementPanel />;
      case "multicam":
        return <MultiCameraPanel />;
      default:
        return null;
    }
  };

  if (activeFeature) {
    return (
      <div className="flex-1 flex flex-col overflow-y-auto w-full min-w-0">
        <Button
          label={t("editingTools.back")}
          onClick={() => navigateAway(null)}
          variant="ghost"
          icon={<ChevronRight size={14} className="rotate-180" aria-hidden />}
          className="justify-start rounded-none border-b border-border bg-background-secondary shrink-0"
        />
        <div className="flex-1 w-full overflow-y-auto">
          <div className="p-4 w-full min-w-0 overflow-hidden">{renderActivePanel()}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 w-full overflow-y-auto">
      <div className="p-4 space-y-6 min-w-0">
        <div className="text-center pb-2">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/5 mb-3">
            <Wand2 size={24} className="text-primary" aria-hidden />
          </div>
          <Text as="h2" type="label" weight="bold" display="block">
            {t("editingTools.title")}
          </Text>
          <Text type="supporting" color="secondary" display="block" className="mt-1 text-[11px]">
            {t("editingTools.description")}
          </Text>
        </div>

        <FeatureSection title={t("editingTools.captionsSection")} icon={Subtitles}>
          <FeatureCard
            icon={Subtitles}
            title={t("editingTools.autoCaptions")}
            description={t("editingTools.autoCaptionsDescription")}
            iconColor="text-primary"
            iconBg="bg-primary/20"
            activeBorder="border-primary/50"
            activeBg="bg-primary/10"
            activeRing="ring-primary/30"
            isActive={activeFeature === "captions"}
            onClick={() => handleFeatureClick("captions")}
          />
        </FeatureSection>

        <FeatureSection title={t("editingTools.templatesSection")} icon={FileStack}>
          <FeatureCard
            icon={Layers}
            title={t("editingTools.projectTemplates")}
            description={t("editingTools.projectTemplatesDescription")}
            iconColor="text-green-400"
            iconBg="bg-green-500/20"
            activeBorder="border-green-500/50"
            activeBg="bg-green-500/10"
            activeRing="ring-green-500/30"
            isActive={activeFeature === "templates"}
            onClick={() => handleFeatureClick("templates")}
          />
          <FeatureCard
            icon={Palette}
            title={t("editingTools.filterPresets")}
            description={t("editingTools.filterPresetsDescription")}
            iconColor="text-orange-400"
            iconBg="bg-orange-500/20"
            activeBorder="border-orange-500/50"
            activeBg="bg-orange-500/10"
            activeRing="ring-orange-500/30"
            isActive={activeFeature === "filters"}
            onClick={() => handleFeatureClick("filters")}
          />
        </FeatureSection>

        <FeatureSection title={t("editingTools.mediaSection")} icon={Volume2}>
          <FeatureCard
            icon={Music}
            title={t("editingTools.music")}
            description={t("editingTools.musicDescription")}
            iconColor="text-teal-400"
            iconBg="bg-teal-500/20"
            activeBorder="border-teal-500/50"
            activeBg="bg-teal-500/10"
            activeRing="ring-teal-500/30"
            isActive={activeFeature === "music"}
            onClick={() => handleFeatureClick("music")}
          />
          <FeatureCard
            icon={AudioLines}
            title={t("audioRequirement.title")}
            description={t("audioRequirement.cardDescription")}
            iconColor="text-violet-400"
            iconBg="bg-violet-500/20"
            activeBorder="border-violet-500/50"
            activeBg="bg-violet-500/10"
            activeRing="ring-violet-500/30"
            isActive={activeFeature === "aiAudio"}
            onClick={() => handleFeatureClick("aiAudio")}
          />
        </FeatureSection>

        <FeatureSection title={t("editingTools.toolsSection")} icon={Video}>
          <FeatureCard
            icon={Video}
            title={t("editingTools.multicam")}
            description={t("editingTools.multicamDescription")}
            iconColor="text-cyan-400"
            iconBg="bg-cyan-500/20"
            activeBorder="border-cyan-500/50"
            activeBg="bg-cyan-500/10"
            activeRing="ring-cyan-500/30"
            isActive={activeFeature === "multicam"}
            onClick={() => handleFeatureClick("multicam")}
          />
        </FeatureSection>

      </div>
    </div>
  );
};

export default EditingToolsTab;
