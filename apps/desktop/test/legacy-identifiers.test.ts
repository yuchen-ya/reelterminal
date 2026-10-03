/**
 * Persisted Blender object identifier tests.
 *
 * The rigging sidecar embeds the Blender object names
 * (`OpenReelHumanoid`, `OpenReel Armature`) into user .blend assets via an
 * interpolated Python script. The values live in the central registry
 * (packages/core/src/legacy/physical-identifiers.ts) and are interpolated
 * from it; this test checks the generated script text.
 */
import { describe, expect, it } from "vitest";
import { blenderRigScript } from "../src/main/sidecar/rigging-backend";
import {
  LEGACY_RIGGING_HUMANOID_NAME,
  LEGACY_RIGGING_ARMATURE_MODIFIER,
} from "@reelterminal/core/legacy/physical-identifiers";

describe("rigging sidecar Blender identifiers", () => {
  it("uses the registered object names", () => {
    expect(LEGACY_RIGGING_HUMANOID_NAME).toBe("OpenReelHumanoid");
    expect(LEGACY_RIGGING_ARMATURE_MODIFIER).toBe("OpenReel Armature");
  });

  it("embedded Python script interpolates the frozen names", () => {
    const script = blenderRigScript();
    expect(script).toContain('default="OpenReelHumanoid"');
    expect(script).toContain('modifiers.new("OpenReel Armature", "ARMATURE")');
  });
});
