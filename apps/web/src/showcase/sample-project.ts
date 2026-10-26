import type {
  Clip,
  MediaItem,
  Project,
  TextClip,
  Track,
} from "@reelterminal/core";
import { DEFAULT_TEXT_STYLE, DEFAULT_TEXT_TRANSFORM } from "@reelterminal/core";
import { saveMediaBlob } from "../services/media-storage";
import { createEmptyProject } from "../stores/project/project-helpers";

export const SHOWCASE_PROJECT_ID = "official-site-video-editor-v4";

const assetUrl = (name: string) =>
  new URL(`./media/${name}?v=${SHOWCASE_PROJECT_ID}`, window.location.href).href;

export function createSampleProject(): Project {
  const project = createEmptyProject("宣传片 · 官网体验", {
    width: 1280,
    height: 720,
    frameRate: 24,
  });
  const media: MediaItem[] = [
    {
      id: `${SHOWCASE_PROJECT_ID}-video`,
      name: "公式与晶体.mp4",
      type: "video",
      fileHandle: null,
      blob: null,
      originalUrl: assetUrl("sample.mp4"),
      contentUrl: assetUrl("sample.mp4"),
      thumbnailUrl: assetUrl("poster.jpg"),
      waveformData: null,
      filmstripThumbnails: [0, 2, 4, 6].map((timestamp) => ({
        timestamp,
        url: assetUrl(`filmstrip-${timestamp}.jpg`),
      })),
      metadata: {
        duration: 8,
        width: 1280,
        height: 720,
        frameRate: 24,
        codec: "h264",
        sampleRate: 48000,
        channels: 2,
        fileSize: 0,
      },
    },
    {
      id: `${SHOWCASE_PROJECT_ID}-logo`,
      name: "ReelTerminal 标志.png",
      type: "image",
      fileHandle: null,
      blob: null,
      originalUrl: assetUrl("logo.png"),
      contentUrl: assetUrl("logo.png"),
      thumbnailUrl: assetUrl("logo.png"),
      waveformData: null,
      metadata: {
        duration: 4,
        width: 512,
        height: 512,
        frameRate: 0,
        codec: "png",
        sampleRate: 0,
        channels: 0,
        fileSize: 0,
      },
    },
  ];
  const clip = (id: string, startTime: number, duration: number): Clip => ({
    id,
    mediaId: `${SHOWCASE_PROJECT_ID}-video`,
    trackId: "demo-footage",
    startTime,
    duration,
    inPoint: 0,
    outPoint: duration,
    effects: [],
    audioEffects: [],
    volume: 1,
    keyframes: [],
    transform: {
      position: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      rotation: 0,
      anchor: { x: 0.5, y: 0.5 },
      opacity: 1,
    },
  });
  const track = (
    id: string,
    name: string,
    type: Track["type"],
    clips: Clip[] = [],
  ): Track => ({
    id,
    name,
    type,
    clips,
    transitions: [],
    locked: false,
    hidden: false,
    muted: false,
    solo: false,
  });
  const text = (
    id: string,
    value: string,
    startTime: number,
    duration: number,
    y: number,
    size: number,
  ): TextClip => ({
    id,
    trackId: "demo-titles",
    startTime,
    duration,
    text: value,
    keyframes: [],
    style: {
      ...DEFAULT_TEXT_STYLE,
      fontFamily: "Inter",
      fontSize: size,
      strokeWidth: 0,
    },
    transform: { ...DEFAULT_TEXT_TRANSFORM, position: { x: 0.5, y } },
  });
  return {
    ...project,
    id: SHOWCASE_PROJECT_ID,
    mediaLibrary: { items: media },
    timeline: {
      ...project.timeline,
      duration: 16,
      tracks: [
        track("demo-titles", "标题", "text"),
        track("demo-captions", "字幕", "text"),
        track("demo-footage", "视频", "video", [
          clip("demo-clip-a", 0, 8),
          clip("demo-clip-b", 8, 8),
        ]),
      ],
    },
    textClips: [
      text("demo-title-a", "把审美留给你", 0, 8, 0.45, 72),
      {
        ...text(
          "demo-caption-a",
          "从创意到成片，人和 Agent 一起完成",
          0,
          8,
          0.63,
          25,
        ),
        trackId: "demo-captions",
      },
      text("demo-title-b", "把繁琐交给 Agent", 8, 8, 0.45, 68),
      {
        ...text(
          "demo-caption-b",
          "ReelTerminal · 生成发生在任何地方，成片交付在这里",
          8,
          8,
          0.63,
          24,
        ),
        trackId: "demo-captions",
      },
    ],
  };
}

/** Feed the production preview and version store the same browser media blobs. */
export async function loadSampleProject(): Promise<Project> {
  const project = createSampleProject();
  const items = await Promise.all(
    project.mediaLibrary.items.map(async (item) => {
      const response = await fetch(item.originalUrl!);
      if (!response.ok)
        throw new Error(`样例素材加载失败：${item.name} (${response.status})`);
      const blob = await response.blob();
      const metadata = { ...item.metadata, fileSize: blob.size };
      const saved = await saveMediaBlob(
        project.id,
        item.id,
        blob,
        metadata,
        item.name,
      );
      return { ...item, blob, contentHash: saved.contentHash, metadata };
    }),
  );
  return { ...project, mediaLibrary: { items } };
}
