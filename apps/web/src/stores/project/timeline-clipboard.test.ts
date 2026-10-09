import { describe, expect, it } from "vitest";
import type { Clip, Project, TextClip } from "@reelterminal/core";
import { createProjectStore, activateProjectStore, getActiveProjectRuntimeStore } from "../project-store";
import { captureTimelineClipboard, getTimelineClipboard, planTimelinePaste } from "./timeline-clipboard";
import { useUIStore } from "../ui-store";

function fixture() {
  const project = createProjectStore().getState().project;
  const tracks = ["video", "audio", "text"].map((type, index) => ({ id: `track-${index}`, type, name: type, clips: [], transitions: [], locked: false, hidden: false, muted: false, solo: false })) as Project["timeline"]["tracks"];
  const media = { id: "old-media-version", name: "Source", type: "video", blob: new Blob(["original bytes"]), fileHandle: null, metadata: { duration: 20, width: 320, height: 180, frameRate: 30, codec: "h264", sampleRate: 48000, channels: 2, fileSize: 14 }, thumbnailUrl: null, waveformData: null } as Project["mediaLibrary"]["items"][number];
  const video = { id: "video", trackId: tracks[0].id, mediaId: media.id, startTime: 1, duration: 4, inPoint: 2, outPoint: 6, speed: 1.5, transform: { position: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, rotation: 0, anchor: { x: 0.5, y: 0.5 }, opacity: 1 }, volume: 0.6, effects: [], audioEffects: [], keyframes: [], metadata: { linkedClipId: "audio" } } as Clip;
  const audio = { ...video, id: "audio", trackId: tracks[1].id, startTime: 2, metadata: { linkedClipId: "video" } };
  const text = { id: "text", trackId: tracks[2].id, startTime: 1.5, duration: 3, text: "Original title", style: { fontFamily: "Saved Face", fontSize: 48, color: "#fff" }, transform: video.transform, keyframes: [], effects: [] } as unknown as TextClip;
  const font = { family: "Saved Face", style: "normal", weight: "400", dataUrl: "data:font/ttf;base64,AAAAAA==" };
  const source = { ...project, timeline: { ...project.timeline, tracks: [{ ...tracks[0], clips: [video] }, { ...tracks[1], clips: [audio] }, tracks[2]] }, mediaLibrary: { items: [media] }, textClips: [text], renderFonts: [font] };
  const target = { ...source, timeline: { ...source.timeline, tracks }, mediaLibrary: { items: [] }, textClips: [], renderFonts: [] };
  const items = [{ kind: "media" as const, clip: video }, { kind: "media" as const, clip: audio }, { kind: "text" as const, clip: text }];
  return { source, target, items, media, font };
}

describe("timeline clipboard across historical preview", () => {
  it("holds fixed media/font bytes and remaps selected clip associations on every paste", () => {
    const { source, target, items, media, font } = fixture();
    captureTimelineClipboard(source, items, true);
    const clipboard = getTimelineClipboard()!;
    const first = planTimelinePaste(target, clipboard, "track-0", 10);
    const second = planTimelinePaste(target, clipboard, "track-0", 20);
    expect(first.clipIds.some(id => second.clipIds.includes(id))).toBe(false);
    expect(first.mediaToSave[0].id).toBe(media.id);
    expect(first.mediaToSave[0].blob?.size).toBe(media.blob?.size);
    expect(first.actions.find(action => action.type === "project/setRenderFonts")?.params.fonts).toEqual([font]);
    const clips = first.actions.filter(action => action.type === "clip/add").map(action => action.params.sourceClip as Clip);
    expect(clips[0]).toMatchObject({ mediaId: media.id, startTime: 10, inPoint: 2, outPoint: 6, speed: 1.5, volume: 0.6, metadata: { linkedClipId: first.clipIds[1] } });
    expect(clips[1]).toMatchObject({ startTime: 11, metadata: { linkedClipId: first.clipIds[0] } });
    expect(first.actions.find(action => action.type === "text/create")?.params.clip).toMatchObject({ startTime: 10.5, text: "Original title", style: (items[2].clip as TextClip).style });
    expect(source.timeline.tracks[0].clips[0].id).toBe("video");
  });

  it("rejects missing bytes, unavailable tracks, different projects and font conflicts before changing a project", () => {
    const { source, target, items, font } = fixture();
    const before = structuredClone(target);
    captureTimelineClipboard({ ...source, mediaLibrary: { items: [] } }, items, true);
    expect(() => planTimelinePaste(target, getTimelineClipboard()!, "track-0", 10)).toThrow("Missing source media");
    captureTimelineClipboard(source, items, true);
    const clipboard = getTimelineClipboard()!;
    expect(() => planTimelinePaste({ ...target, id: "other-project" }, clipboard, "track-0", 10)).toThrow("project");
    expect(() => planTimelinePaste({ ...target, timeline: { ...target.timeline, tracks: target.timeline.tracks.map(track => ({ ...track, locked: true })) } }, clipboard, "track-0", 10)).toThrow("unlocked");
    expect(() => planTimelinePaste({ ...target, renderFonts: [{ ...font, dataUrl: "data:font/ttf;base64,AQAAAA==" }] }, clipboard, "track-0", 10)).toThrow("different saved font");
    expect(target).toEqual(before);
  });

  it("keeps copied overlays after preview disposal and commits one undoable batch; stale revision is atomic", async () => {
    const previous = getActiveProjectRuntimeStore();
    const previousSelection = useUIStore.getState().selectedItems;
    const source = createProjectStore();
    source.getState().createNewProject();
    await source.getState().addTrack("text");
    const track = source.getState().project.timeline.tracks.find(track => track.type === "text")!;
    const original = source.getState().createTextClip(track.id, 1, "Snapshot title", 3)!;
    source.getState().updateTextStyle(original.id, { fontFamily: "Saved Face" });
    const editing = createProjectStore();
    editing.getState().loadProject(source.getState().getFullProject());
    const font = fixture().font;
    source.setState({ project: { ...source.getState().project, renderFonts: [font] } });
    source.setState({ readOnlyPreview: true });
    activateProjectStore(source);
    const revision = source.getState().projectRevision;
    source.getState().copyClips([original.id]);
    expect(source.getState().projectRevision).toBe(revision);
    activateProjectStore(editing);
    try {
      const currentRevision = editing.getState().projectRevision;
      expect((await editing.getState().pasteClips(track.id, 10, { expectedRevision: currentRevision - 1 }))[0].success).toBe(false);
      expect(editing.getState().project.textClips).toHaveLength(1);
      expect((await editing.getState().pasteClips(track.id, 10, { expectedRevision: currentRevision }))[0].success).toBe(true);
      expect(editing.getState().project.textClips).toHaveLength(2);
      expect(editing.getState().project.renderFonts).toEqual([font]);
      const pastedId = editing.getState().lastPastedClipIds[0];
      useUIStore.getState().selectMultiple([
        { type: "text-clip", id: original.id, trackId: track.id },
        { type: "text-clip", id: pastedId, trackId: track.id },
      ]);
      await editing.getState().undo();
      expect(editing.getState().project.textClips).toHaveLength(1);
      expect(editing.getState().project.renderFonts).toBeUndefined();
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([original.id]);
      expect(useUIStore.getState().lastSelectedItem?.id).toBe(original.id);
      await editing.getState().redo();
      expect(editing.getState().project.textClips).toHaveLength(2);
      expect(editing.getState().project.renderFonts).toEqual([font]);
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([original.id]);
      await editing.getState().addTrack("audio");
      await editing.getState().undo();
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([original.id]);
      await editing.getState().redo();
      expect(useUIStore.getState().getSelectedClipIds()).toEqual([original.id]);
      expect(editing.getState().clipboard[0].clip.id).toBe(original.id);
    } finally {
      activateProjectStore(previous);
      useUIStore.getState().selectMultiple(previousSelection);
    }
  });
});
