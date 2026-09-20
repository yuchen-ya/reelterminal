/**
 * Render/hydration adapter seam — RESERVED for the Slice 1b Chromium runtime.
 *
 * Slice 1 ships NO implementation of this interface, and no facade verb
 * consumes one. The facade's canonical serialized Project (see
 * project.get_state) is the contract the future Chromium adapter hydrates
 * from: it re-creates engine-side overlay state (titleEngine etc.) from
 * `project.textClips`, decodes media, and produces pixels for preview/export.
 *
 * DORMANCY RULE: injecting an adapter into the Slice-1 session changes
 * nothing observable. Because no verb calls hydrateFromProject/renderFrame,
 * capabilities.get must keep reporting preview/export as unavailable even
 * with an adapter present; availability flips only when Slice 1b adds the
 * verbs that actually drive the adapter.
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
