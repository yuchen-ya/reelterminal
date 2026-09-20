/**
 * Legacy physical identifier drift protection, desktop side (N04).
 *
 * The rigging sidecar embeds the frozen Blender object names
 * (`OpenReelHumanoid`, `OpenReel Armature`) into user .blend assets via an
 * interpolated Python script. The values live in the central registry
 * (packages/core/src/legacy/physical-identifiers.ts) and are interpolated
 * from it; this test pins the generated script text itself so a registry or
 * interpolation drift fails loudly.
 *
 * docs/NAMING-AND-COMPATIBILITY.md §4 "持久化保留为 legacy".
 */
import { describe, expect, it } from "vitest";
import { blenderRigScript } from "../src/main/sidecar/rigging-backend";
import {
  LEGACY_RIGGING_HUMANOID_NAME,
  LEGACY_RIGGING_ARMATURE_MODIFIER,
} from "@reelterminal/core/legacy/physical-identifiers";

describe("rigging sidecar legacy Blender identifiers (N04)", () => {
  it("registry values keep their historical literals", () => {
    expect(LEGACY_RIGGING_HUMANOID_NAME).toBe("OpenReelHumanoid");
    expect(LEGACY_RIGGING_ARMATURE_MODIFIER).toBe("OpenReel Armature");
  });

  it("embedded Python script interpolates the frozen names", () => {
    const script = blenderRigScript();
    expect(script).toContain('default="OpenReelHumanoid"');
    expect(script).toContain('modifiers.new("OpenReel Armature", "ARMATURE")');
  });
});
