import type { Action, MediaItem, Project, ProjectRenderFont, Track } from "@reelterminal/core";
import { v4 as uuid } from "uuid";
import { isRuntimeSystemFontFamily } from "../../services/font-catalog";
import i18n from "../../i18n";
import type { TimelineClipboardItem } from "./types";

interface ClipboardCapture {
  projectId: string;
  items: TimelineClipboardItem[];
  tracks: Pick<Track, "id" | "type">[];
  media: MediaItem[];
  fonts: ProjectRenderFont[];
  fromPreview: boolean;
  dependencies: Project;
}

// Editor-session clipboard. It outlives a detached historical preview store.
let capture: ClipboardCapture | null = null;

export class ClipboardPasteError extends Error {}

export function captureTimelineClipboard(project: Project, items: TimelineClipboardItem[], fromPreview: boolean): void {
  const mediaIds = new Set(items.filter(item => item.kind === "media").map(item => item.clip.mediaId));
  capture = {
    projectId: project.id,
    items,
    tracks: project.timeline.tracks.map(({ id, type }) => ({ id, type })),
    media: project.mediaLibrary.items
      .filter(item => mediaIds.has(item.id))
      .map(({ blob, fileHandle: _fileHandle, ...item }) => ({
        ...structuredClone(item),
        fileHandle: null,
        blob,
      })),
    fonts: structuredClone([...(project.renderFonts ?? [])]),
    fromPreview,
    dependencies: {
      id: project.id,
      name: "Copied clips",
      createdAt: 0,
      modifiedAt: 0,
      settings: project.settings,
      mediaLibrary: { items: [] },
      timeline: {
        ...project.timeline,
        tracks: project.timeline.tracks.map(track => ({
          ...track,
          clips: items
            .filter(item => item.kind === "media" && item.clip.trackId === track.id)
            .map(item => item.clip) as typeof track.clips,
          transitions: [],
        })),
        subtitles: [],
        markers: [],
      },
      textClips: items.filter((item): item is Extract<TimelineClipboardItem, { kind: "text" }> => item.kind === "text").map(item => item.clip),
      shapeClips: items.filter((item): item is Extract<TimelineClipboardItem, { kind: "shape" }> => item.kind === "shape").map(item => item.clip),
      svgClips: items.filter((item): item is Extract<TimelineClipboardItem, { kind: "svg" }> => item.kind === "svg").map(item => item.clip),
      stickerClips: items.filter((item): item is Extract<TimelineClipboardItem, { kind: "sticker" }> => item.kind === "sticker").map(item => item.clip),
      renderFonts: project.renderFonts,
    },
  };
}

export function getTimelineClipboard(): ClipboardCapture | null {
  return capture;
}

function fontFamilies(value: unknown, result: Set<string>): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (key === "fontFamily" && typeof child === "string") result.add(child);
    else fontFamilies(child, result);
  }
}

export function planTimelinePaste(project: Project, clipboard: ClipboardCapture, trackId: string, startTime: number): {
  actions: Action[];
  clipIds: string[];
  mediaToSave: MediaItem[];
} {
  if (clipboard.projectId !== project.id) throw new ClipboardPasteError(i18n.t("previewClipboard.sameProject"));
  if (!Number.isFinite(startTime) || startTime < 0) throw new ClipboardPasteError(i18n.t("previewClipboard.validTime"));
  const actions: Action[] = [];
  const addAction = (type: string, params: Record<string, unknown>) => {
    actions.push({ type, params, id: uuid(), timestamp: Date.now() });
  };
  const mediaToSave: MediaItem[] = [];
  for (const item of clipboard.items) {
    if (item.kind !== "media") continue;
    const media = clipboard.media.find(media => media.id === item.clip.mediaId);
    if (!media || clipboard.fromPreview && !media.blob) throw new ClipboardPasteError(i18n.t("previewClipboard.missingMedia", { name: item.clip.mediaId }));
    if (!project.mediaLibrary.items.some(existing => existing.id === media.id) && !mediaToSave.some(existing => existing.id === media.id)) {
      if (!media.blob) throw new ClipboardPasteError(i18n.t("previewClipboard.missingMedia", { name: media.name }));
      mediaToSave.push(media);
      addAction("media/import", { mediaItem: media });
    }
  }

  const families = new Set<string>();
  for (const item of clipboard.items) fontFamilies(item.clip, families);
  const fonts = [...project.renderFonts ?? []];
  for (const family of families) {
    const faces = clipboard.fonts.filter(font => font.family.toLowerCase() === family.toLowerCase());
    if (clipboard.fromPreview && faces.length === 0 && !isRuntimeSystemFontFamily(family)) throw new ClipboardPasteError(i18n.t("previewClipboard.missingFont", { family }));
    for (const face of faces) {
      const existing = fonts.find(font => font.family.toLowerCase() === face.family.toLowerCase() && font.style === face.style && font.weight === face.weight && font.unicodeRange === face.unicodeRange);
      if (existing && existing.dataUrl !== face.dataUrl) throw new ClipboardPasteError(i18n.t("previewClipboard.fontConflict", { family }));
      if (!existing) fonts.push(face);
    }
  }
  if (fonts.length !== (project.renderFonts?.length ?? 0)) addAction("project/setRenderFonts", { fonts });

  // Clip identities and template application identities belong to instances.
  // Effect/keyframe ids remain local to their copied clip, as in normal paste.
  const ids = new Map(clipboard.items.map(item => [item.clip.id, uuid()]));
  const collectIds = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "applicationId" && typeof child === "string" && !ids.has(child)) ids.set(child, uuid());
      else collectIds(child);
    }
  };
  for (const item of clipboard.items) collectIds(item.clip);
  const remap = (value: unknown, key = ""): unknown => {
    if (typeof value === "string") return key === "id" || key.endsWith("Id") || key.endsWith("Ids") ? ids.get(value) ?? value : value;
    if (Array.isArray(value)) return value.map(child => remap(child, key));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, remap(child, key)]));
    return value;
  };
  const originTime = Math.min(...clipboard.items.map(item => item.clip.startTime));
  const clipIds: string[] = [];
  for (const item of clipboard.items) {
    const expectedType = item.kind === "media"
      ? clipboard.tracks.find(track => track.id === item.clip.trackId)!.type
      : item.kind === "text" ? "text" : "graphics";
    const compatible = (track: Track) => !track.locked && track.type === expectedType;
    const destination = project.timeline.tracks.find(track => track.id === item.clip.trackId && compatible(track))
      ?? project.timeline.tracks.find(track => track.id === trackId && compatible(track))
      ?? project.timeline.tracks.find(compatible);
    if (!destination) throw new ClipboardPasteError(i18n.t("previewClipboard.compatibleTrack", { type: expectedType }));
    const clip = {
      ...remap(item.clip) as TimelineClipboardItem["clip"],
      id: ids.get(item.clip.id)!,
      trackId: destination.id,
      startTime: startTime + item.clip.startTime - originTime,
    };
    clipIds.push(clip.id);
    if (item.kind === "media") addAction("clip/add", { trackId: destination.id, mediaId: item.clip.mediaId, clipId: clip.id, startTime: clip.startTime, sourceClip: clip });
    else addAction(`${item.kind}/create`, { clip });
  }
  return { actions, clipIds, mediaToSave };
}
