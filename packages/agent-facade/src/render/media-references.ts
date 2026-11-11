import type { Project } from "@reelterminal/core/types/project";
import type { Track } from "@reelterminal/core/types/timeline";
import type { MotionMaterial3D } from "@reelterminal/core/motion/types";
import { resolveMotionLayerVariableBindings } from "@reelterminal/core/motion/motion-variable-bindings";

/** Media that an isolated renderer needs to reopen for the authored timeline. */
export function timelineRenderMediaIds(project: Project): Set<string> {
  const ids = new Set<string>();
  const visitedCompounds = new Set<string>();
  function collectTracks(tracks: readonly Track[]) {
    for (const track of tracks) {
      for (const clip of track.clips) {
        ids.add(clip.mediaId);
        const stabilized = clip.stabilization;
        if (stabilized?.enabled && stabilized.renderedSource) ids.add(stabilized.renderedSource.mediaId);
        const compoundId = clip.metadata?.compoundClipId
          ?? (clip.mediaId.startsWith("compound:") ? clip.mediaId.slice("compound:".length) : undefined);
        if (typeof compoundId !== "string" || visitedCompounds.has(compoundId)) continue;
        visitedCompounds.add(compoundId);
        const compound = project.compoundClips?.find(item => item.id === compoundId);
        if (compound) collectTracks(compound.content.tracks);
      }
    }
  }
  collectTracks(project.timeline.tracks);

  const ancestors = new Set<string>();
  function collectComposition(id: string, overrides?: Record<string, string | number | boolean>) {
    const comp = project.motionCompositions?.find(item => item.id === id);
    if (!comp || ancestors.has(id)) return;
    ancestors.add(id);
    const assets = new Set<string>();
    function addMaterial(material?: MotionMaterial3D) {
      for (const value of [material?.mapAssetId, material?.normalMapAssetId, material?.roughnessMapAssetId, material?.metalnessMapAssetId]) {
        if (value) assets.add(value);
      }
    }
    for (const original of comp.layers) {
      const layer = resolveMotionLayerVariableBindings(comp, original, overrides);
      if (layer.type === "composition") collectComposition(layer.compositionId, overrides);
      if (layer.type === "image" || layer.type === "video") assets.add(layer.assetId);
      if (layer.type === "scene3d") {
        addMaterial(layer.material);
        for (const object of layer.objects ?? []) addMaterial(object.material);
      }
    }
    for (const audio of comp.audioClips ?? []) {
      if (audio.mediaId) ids.add(audio.mediaId);
      if (audio.assetId) assets.add(audio.assetId);
    }
    for (const asset of comp.assets) {
      if (assets.has(asset.id) && asset.mediaId) ids.add(asset.mediaId);
    }
    ancestors.delete(id);
  }
  for (const instance of project.motionInstances ?? []) collectComposition(instance.compositionId, instance.variableOverrides);
  return ids;
}
