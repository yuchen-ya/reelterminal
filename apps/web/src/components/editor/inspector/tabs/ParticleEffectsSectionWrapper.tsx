import React from "react";
import { ParticleEffectsSection } from "../";
import type { ParticleEffect, ParticleConfig } from "@reelterminal/core";
import { useProjectStore } from "../../../../stores/project-store";

export const ParticleEffectsSectionWrapper: React.FC<{
  clipId: string;
  clipDuration: number;
  clipStartTime: number;
}> = ({ clipId, clipDuration, clipStartTime }) => {
  const project = useProjectStore((state) => state.project);
  const workspaceId = useProjectStore((state) => state.workspaceId);
  const effects = (project.particleEffects ?? []).filter(
    (effect) => effect.clipId === clipId,
  );

  const updateEffects = React.useCallback(
    (update: (effects: ParticleEffect[]) => ParticleEffect[]) => {
      useProjectStore.setState((state) => {
        // A stale inspector callback must not edit a newly selected workspace.
        if (state.readOnlyPreview || state.project.id !== project.id ||
            state.workspaceId !== workspaceId) {
          return state;
        }
        return {
          project: {
            ...state.project,
            particleEffects: update(state.project.particleEffects ?? []),
            modifiedAt: Date.now(),
          },
        };
      });
    },
    [project.id, workspaceId],
  );

  const handleAddEffect = React.useCallback(
    (effect: ParticleEffect) => updateEffects((effects) => [...effects, effect]),
    [updateEffects],
  );
  const handleUpdateEffect = React.useCallback(
    (effectId: string, config: Partial<ParticleConfig>) => {
      updateEffects((effects) => effects.map((effect) =>
        effect.id === effectId
          ? { ...effect, config: { ...effect.config, ...config } }
          : effect,
      ));
    },
    [updateEffects],
  );
  const handleRemoveEffect = React.useCallback(
    (effectId: string) => {
      updateEffects((effects) => effects.filter((effect) => effect.id !== effectId));
    },
    [updateEffects],
  );
  const handleToggleEffect = React.useCallback(
    (effectId: string, enabled: boolean) => {
      updateEffects((effects) => effects.map((effect) =>
        effect.id === effectId ? { ...effect, enabled } : effect,
      ));
    },
    [updateEffects],
  );
  const handleUpdateTiming = React.useCallback(
    (effectId: string, startTime: number, duration: number) => {
      updateEffects((effects) => effects.map((effect) =>
        effect.id === effectId ? { ...effect, startTime, duration } : effect,
      ));
    },
    [updateEffects],
  );

  return (
    <ParticleEffectsSection
      clipId={clipId}
      clipDuration={clipDuration}
      clipStartTime={clipStartTime}
      effects={effects}
      onAddEffect={handleAddEffect}
      onUpdateEffect={handleUpdateEffect}
      onRemoveEffect={handleRemoveEffect}
      onToggleEffect={handleToggleEffect}
      onUpdateTiming={handleUpdateTiming}
    />
  );
};
