import React, { useState, useCallback, useMemo, useEffect } from "react";
import { Search, Loader2, Layers, CloudOff } from "@/icons/lucide-compat";
import { ToolcraftText as Text } from "@reelterminal/ui";
import { ToolcraftTextInputControl } from "@reelterminal/ui";
import { useEngineStore } from "../../stores/engine-store";
import {
  SOCIAL_MEDIA_CATEGORY_INFO,
  type SocialMediaCategory,
  type ScriptableTemplate,
  type Clip,
} from "@reelterminal/core";
import { templateCloudService } from "../../services/template-cloud-service";
import { CategoryTabs } from "./CategoryTabs";
import { TemplateCard } from "./TemplateCard";
import { TemplatePreviewModal } from "./TemplatePreviewModal";
import { useTranslation } from "react-i18next";

interface PlaceholderClip extends Clip {
  isPlaceholder?: boolean;
  placeholderId?: string;
}

interface TemplateGalleryProps {
  onTemplateApplied?: () => void;
}

export const TemplateGallery: React.FC<TemplateGalleryProps> = ({
  onTemplateApplied,
}) => {
  const { t: tr } = useTranslation();
  const getTemplateEngine = useEngineStore((state) => state.getTemplateEngine);
  // Read once per render: the build-time cloud opt-out cannot change at runtime.
  const cloudEnabled = templateCloudService.isCloudEnabled();

  const [templates, setTemplates] = useState<ScriptableTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [cloudLoadFailed, setCloudLoadFailed] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [selectedCategory, setSelectedCategory] = useState<
    SocialMediaCategory | "all"
  >("all");
  const [selectedTemplate, setSelectedTemplate] =
    useState<ScriptableTemplate | null>(null);
  const [showPreview, setShowPreview] = useState(false);

  const loadTemplates = useCallback(async () => {
    setIsLoading(true);
    try {
      const templateEngine = await getTemplateEngine();
      await templateEngine.initialize();
      const builtinTemplates = templateEngine.getBuiltinTemplates();
      // Failure-aware variant of the mount-time cloud fetch : keeps
      // "cloud unreachable" distinguishable from "no cloud templates".
      const { templates: cloudTemplates, failed: cloudFailed } =
        await templateCloudService.listScriptableTemplatesWithStatus();
      setCloudLoadFailed(cloudFailed);

      const allTemplates = [
        ...(builtinTemplates.map((t) => {
          const placeholderClipMap = new Map<
            string,
            { clipId: string; trackId: string }
          >();
          for (const track of t.timeline.tracks) {
            for (const clip of track.clips) {
              const pClip = clip as PlaceholderClip;
              if (pClip.isPlaceholder && pClip.placeholderId) {
                placeholderClipMap.set(pClip.placeholderId, {
                  clipId: clip.id,
                  trackId: track.id,
                });
              }
            }
          }

          return {
            ...t,
            placeholders: t.placeholders.map((p) => {
              const clipInfo = placeholderClipMap.get(p.id);
              return {
                ...p,
                targets: clipInfo
                  ? [
                      {
                        clipId: clipInfo.clipId,
                        trackId: clipInfo.trackId,
                        property: "content",
                      },
                    ]
                  : [],
                defaultValue: p.defaultValue as unknown,
              };
            }),
            socialCategory: mapCategoryToSocial(t.category),
          };
        }) as ScriptableTemplate[]),
        ...cloudTemplates,
      ];

      const unique = Array.from(
        new Map(allTemplates.map((t) => [t.id, t])).values(),
      );

      setTemplates(unique);
    } catch (error) {
      console.error("Failed to load templates:", error);
    } finally {
      setIsLoading(false);
    }
  }, [getTemplateEngine]);

  useEffect(() => {
    void loadTemplates();
  }, [loadTemplates]);

  const filteredTemplates = useMemo(() => {
    let result = templates;

    if (selectedCategory !== "all") {
      result = result.filter(
        (t) =>
          t.socialCategory === selectedCategory ||
          t.category === selectedCategory,
      );
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      result = result.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          t.description.toLowerCase().includes(query) ||
          t.tags.some((tag) => tag.toLowerCase().includes(query)),
      );
    }

    return result;
  }, [templates, selectedCategory, searchQuery]);

  const handleSelectTemplate = useCallback((template: ScriptableTemplate) => {
    setSelectedTemplate(template);
    setShowPreview(true);
  }, []);

  const handleClosePreview = useCallback(() => {
    setShowPreview(false);
    setSelectedTemplate(null);
  }, []);

  const handleApplyTemplate = useCallback(() => {
    handleClosePreview();
    onTemplateApplied?.();
  }, [handleClosePreview, onTemplateApplied]);

  const categoryStats = useMemo(() => {
    const stats: Record<string, number> = { all: templates.length };
    for (const category of SOCIAL_MEDIA_CATEGORY_INFO) {
      stats[category.id] = templates.filter(
        (t) => t.socialCategory === category.id || t.category === category.id,
      ).length;
    }
    return stats;
  }, [templates]);

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center py-20">
        <div className="relative">
          <div className="absolute inset-0 bg-primary/20 rounded-full blur-xl" />
          <Loader2 className="relative w-10 h-10 text-primary animate-spin" />
        </div>
        <Text type="supporting" color="secondary" className="text-sm text-text-muted mt-6">{tr("Loading templates...")}</Text>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="relative flex-1 max-w-md">
          <Search
            size={18}
            className="absolute left-4 top-1/2 -translate-y-1/2 text-text-muted z-10"
          />
          <ToolcraftTextInputControl
            label={tr("Search templates")}
            isLabelHidden
            value={searchQuery}
            onChange={setSearchQuery}
            placeholder={tr("Search templates...")}
            className="pl-11 bg-background-tertiary border-border rounded-xl text-text-primary"
          />
        </div>
      </div>

      <CategoryTabs
        selectedCategory={selectedCategory}
        onSelectCategory={setSelectedCategory}
        categoryStats={categoryStats}
      />

      {!cloudEnabled && (
        <div
          className="flex items-start gap-3 p-4 rounded-xl border border-border bg-background-tertiary"
          data-testid="cloud-templates-disabled"
        >
          <CloudOff size={18} className="text-text-muted shrink-0 mt-0.5" />
          <div>
            <Text type="supporting" color="primary" weight="medium" className="text-sm text-text-primary">
              {tr("templates.cloudDisabledTitle")}</Text>
            <Text type="supporting" color="secondary" display="block" className="text-sm text-text-muted">
              {tr("templates.cloudDisabledDetail")}</Text>
          </div>
        </div>
      )}

      {cloudEnabled && cloudLoadFailed && (
        <div
          className="flex items-start gap-3 p-4 rounded-xl border border-border bg-background-tertiary"
          data-testid="cloud-templates-failed"
        >
          <CloudOff size={18} className="text-text-muted shrink-0 mt-0.5" />
          <div>
            <Text type="supporting" color="primary" weight="medium" className="text-sm text-text-primary">
              {tr("templates.cloudFailedTitle")}</Text>
            <Text type="supporting" color="secondary" display="block" className="text-sm text-text-muted">
              {tr("templates.cloudFailedDetail")}</Text>
            <button
              type="button"
              data-testid="cloud-templates-retry"
              onClick={() => void loadTemplates()}
              className="mt-2 rounded-lg border border-border px-3 py-1.5 text-xs text-text-primary hover:bg-background-secondary"
            >
              {tr("templates.retry")}</button>
          </div>
        </div>
      )}

      {filteredTemplates.length === 0 ? (
        cloudEnabled && cloudLoadFailed ? (
          <div
            className="flex flex-col items-center justify-center py-16"
            data-testid="cloud-templates-failed-empty"
          >
            <div className="w-14 h-14 rounded-2xl bg-background-tertiary flex items-center justify-center mb-4">
              <CloudOff size={24} className="text-text-muted" />
            </div>
            <Text type="supporting" color="primary" weight="medium" className="text-base text-text-primary mb-1">
              {tr("templates.cloudFailedTitle")}</Text>
            <Text type="supporting" color="secondary" className="text-sm text-text-muted">
              {tr("templates.cloudFailedDetail")}</Text>
            <button
              type="button"
              data-testid="cloud-templates-retry-empty"
              onClick={() => void loadTemplates()}
              className="mt-4 rounded-lg border border-border bg-background-tertiary px-4 py-2 text-sm text-text-primary hover:bg-background-secondary"
            >
              {tr("templates.retry")}</button>
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center py-16">
            <div className="w-14 h-14 rounded-2xl bg-background-tertiary flex items-center justify-center mb-4">
              <Layers size={24} className="text-text-muted" />
            </div>
            <Text type="supporting" color="primary" weight="medium" className="text-base text-text-primary mb-1">
              {cloudEnabled
                ? tr("No templates found")
                : tr("templates.cloudDisabledTitle")}</Text>
            <Text type="supporting" color="secondary" className="text-sm text-text-muted">
              {cloudEnabled
                ? tr("Try adjusting your search or filter")
                : tr("templates.cloudDisabledDetail")}</Text>
          </div>
        )
      ) : (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {filteredTemplates.map((template) => (
            <TemplateCard
              key={template.id}
              template={template}
              onClick={() => handleSelectTemplate(template)}
            />
          ))}
        </div>
      )}

      {showPreview && selectedTemplate && (
        <TemplatePreviewModal
          template={selectedTemplate}
          onClose={handleClosePreview}
          onApply={handleApplyTemplate}
        />
      )}
    </div>
  );
};

function mapCategoryToSocial(category: string): SocialMediaCategory {
  const mapping: Record<string, SocialMediaCategory> = {
    "social-media": "tiktok",
    youtube: "youtube-video",
    tiktok: "tiktok",
    instagram: "instagram-reels",
    business: "promo",
    personal: "custom",
    slideshow: "slideshow",
    "intro-outro": "intro",
    "lower-third": "lower-third",
    custom: "custom",
  };
  return mapping[category] || "custom";
}

export default TemplateGallery;
