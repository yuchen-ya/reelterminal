/**
 * Reserved project rendering adapter interface.
 *
 * No facade verb consumes this interface. The facade's canonical serialized
 * Project (see
 * project.get_state) is the contract the future Chromium adapter hydrates
 * from: it re-creates engine-side overlay state (titleEngine etc.) from
 * `project.textClips`, decodes media, and produces pixels for preview/export.
 *
 * Injecting an adapter changes nothing observable. Because no verb calls
 * hydrateFromProject/renderFrame,
 * capabilities.get must keep reporting preview/export as unavailable even
 * with an adapter present.
 */
import type { Project } from "@reelterminal/core/types/project";

export interface ProjectRenderAdapter {
  readonly id: string;
  /**
   * Rebuild runtime render state from the canonical serialized project.
   * Called by the future runtime after loading/hydrating a project.
   */
  hydrateFromProject(project: Project): Promise<void>;
  /** Render one frame at the given timeline position. */
  renderFrame(timeSec: number): Promise<unknown>;
}
