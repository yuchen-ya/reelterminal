import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Project } from "@reelterminal/core";
import { workspaceManager } from "../../services/workspace-manager";
import { mediaDisplayName } from "@reelterminal/core";
import { formatDuration } from "../../utils/format";

export type ProjectMediaType = "all" | "video" | "audio" | "image" | "subtitle";

export function ProjectSubtitleList({ project, search }: { project: Project; search: string }) {
  const { t } = useTranslation();
  const captionTracks = new Set(project.timeline.tracks.filter(track => track.type === "text" && track.name === "Captions").map(track => track.id));
  const captions = (project.textClips ?? []).filter(clip =>
    (captionTracks.has(clip.trackId) || typeof clip.metadata?.captionSource === "string") &&
    clip.text.toLowerCase().includes(search.trim().toLowerCase()),
  ).sort((a, b) => a.startTime - b.startTime);
  return <div className="space-y-2" data-testid="project-subtitles">
    <p className="text-xs text-fg-2">{t("projectMediaFilters.subtitleHint")}</p>
    {captions.length === 0 && <p className="text-sm text-fg-muted">{t("projectMediaFilters.noMatches")}</p>}
    {captions.map(clip => <div key={clip.id} className="rounded border border-border p-2 text-xs">
      <span className="text-fg-muted">{formatDuration(clip.startTime)} – {formatDuration(clip.startTime + clip.duration)}</span>
      <p className="whitespace-pre-wrap break-words text-fg">{clip.text}</p>
    </div>)}
  </div>;
}

/** Read a single immutable snapshot on demand; never activate it or hydrate its media. */
export function ProjectNodeAssets({ projectId, nodeId, mediaType, search, sortOrder }: {
  projectId: string; nodeId: string; mediaType: ProjectMediaType; search: string; sortOrder: "none" | "asc" | "desc";
}) {
  const { t } = useTranslation();
  const [result, setResult] = useState<{ project?: Project; error?: string }>({});
  const [onlyUsed, setOnlyUsed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setResult({});
    void workspaceManager.getNode(projectId, nodeId).then(node => {
      if (!cancelled) setResult(node ? { project: node.project } : { error: t("projectMediaFilters.nodeMissing") });
    }, error => {
      if (!cancelled) setResult({ error: error instanceof Error ? error.message : String(error) });
    });
    return () => { cancelled = true; };
  }, [projectId, nodeId, t]);
  if (result.error) return <p role="alert" className="p-3 text-sm text-destructive">{result.error}</p>;
  if (!result.project) return <p role="status" className="p-3 text-sm text-fg-muted">{t("projectMediaFilters.loading")}</p>;
  const project = result.project;
  if (mediaType === "subtitle") return <ProjectSubtitleList project={project} search={search} />;
  const used = new Set(project.timeline.tracks.flatMap(track => track.clips.map(clip => clip.mediaId)));
  const items = project.mediaLibrary.items.filter(item =>
    (!onlyUsed || used.has(item.id)) &&
    (mediaType === "all" || item.type === mediaType) && mediaDisplayName(item).toLowerCase().includes(search.trim().toLowerCase()),
  );
  if (sortOrder !== "none") items.sort((a, b) => mediaDisplayName(a).localeCompare(mediaDisplayName(b)) * (sortOrder === "asc" ? 1 : -1));
  return <div className="space-y-2" data-testid="node-assets">
    <p className="text-xs text-fg-2">{t("projectMediaFilters.nodeHint")}</p>
    <label className="flex items-center gap-2 text-xs text-fg-2"><input type="checkbox" checked={onlyUsed} onChange={event => setOnlyUsed(event.target.checked)} />{t("projectMediaFilters.onlyUsed")}</label>
    <p className="text-xs text-fg-muted">{t("projectMediaFilters.matches", { count: items.length })}</p>
    {items.length === 0 && <p className="text-sm text-fg-muted">{t("projectMediaFilters.noMatches")}</p>}
    {items.map(item => <div key={item.id} className="rounded border border-border p-3" data-node-media-id={item.id}>
      <p className="break-words text-sm text-fg">{mediaDisplayName(item)}</p>
      <div className="mt-1 flex flex-wrap gap-2 text-xs text-fg-muted">
        <span>{t(`projectMediaFilters.${item.type}`)}</span>
        <span>{t(used.has(item.id) ? "projectMediaFilters.used" : "projectMediaFilters.retained")}</span>
        {item.metadata.duration > 0 && <span>{formatDuration(item.metadata.duration)}</span>}
      </div>
    </div>)}
  </div>;
}
