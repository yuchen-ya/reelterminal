import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createEffectFromPreset } from "@reelterminal/core";
import { activateProjectStore, createProjectStore } from "../../../../stores/project-store";
import { createEmptyProject } from "../../../../stores/project/project-helpers";
import { ParticleEffectsSectionWrapper } from "./ParticleEffectsSectionWrapper";
import type { ComponentProps } from "react";
import type { ParticleEffectsSection } from "../ParticleEffectsSection";

const section = vi.hoisted(() => ({ props: null as ComponentProps<typeof ParticleEffectsSection> | null }));
vi.mock("../", () => ({
  ParticleEffectsSection: (props: ComponentProps<typeof ParticleEffectsSection>) => {
    section.props = props;
    return null;
  },
}));

afterEach(() => {
  cleanup();
  activateProjectStore(createProjectStore({ isForeground: true }));
});

describe("project-owned inspector particle edits", () => {
  it("publishes configuration and timing in the saved project and isolates workspace switches", () => {
    const first = createProjectStore({ workspaceId: "workspace-first", initialProject: createEmptyProject("First") });
    activateProjectStore(first);
    render(<ParticleEffectsSectionWrapper clipId="clip" clipDuration={5} clipStartTime={0} />);
    const effect = createEffectFromPreset("confetti-celebration", "effect", "clip", 0, 5)!;
    act(() => section.props!.onAddEffect(effect));
    expect(first.getState().getFullProject().particleEffects).toEqual([effect]);
    act(() => section.props!.onUpdateEffect(effect.id, { gravity: 42 }));
    act(() => section.props!.onUpdateTiming(effect.id, 1, 3));
    act(() => section.props!.onToggleEffect(effect.id, false));
    expect(first.getState().getFullProject().particleEffects![0]).toMatchObject({
      config: { gravity: 42 }, startTime: 1, duration: 3, enabled: false,
    });
    const staleAdd = section.props!.onAddEffect;
    const other = createProjectStore({ workspaceId: "workspace-other", initialProject: first.getState().getFullProject() });
    act(() => activateProjectStore(other));
    act(() => staleAdd({ ...effect, id: "stale" }));
    expect(other.getState().project.particleEffects).toHaveLength(1);
    act(() => section.props!.onRemoveEffect(effect.id));
    expect(other.getState().project.particleEffects).toEqual([]);
    expect(first.getState().project.particleEffects).toHaveLength(1);
  });

  it("keeps read-only project previews unchanged", () => {
    const store = createProjectStore({ readOnlyPreview: true });
    activateProjectStore(store);
    render(<ParticleEffectsSectionWrapper clipId="clip" clipDuration={5} clipStartTime={0} />);
    act(() => section.props!.onAddEffect(createEffectFromPreset("confetti-celebration", "effect", "clip", 0, 5)!));
    expect(store.getState().project.particleEffects).toBeUndefined();
  });
});
