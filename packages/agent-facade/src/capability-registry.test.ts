import { describe, expect, it, vi } from "vitest";
import * as ffmpeg from "./media/ffmpeg-bin";
import * as openCv from "./media/opencv-runner";
import { createAgentFacade } from "./index";
import { getCommandCatalogEntry } from "./command-catalog";
import {
  CAPABILITY_DEFINITIONS,
  describeCommand,
  getCapabilityTools,
  listCapabilities,
  listCapabilityDomains,
} from "./capability-registry";
import { EDIT_OP_TYPES, FACADE_VERBS } from "./types";
import type { JsonSchemaObject } from "./jsonschema";

function variants(schema: JsonSchemaObject) {
  const ops = schema.properties.ops;
  if (!("items" in ops) || !("anyOf" in ops.items)) throw new Error("Expected edit operation union");
  return ops.items.anyOf;
}

describe("capability discovery", () => {
  it("covers every facade command and edit op with resolvable members and unique IDs", () => {
    const definitions = listCapabilities({ includeLegacy: true });
    expect(new Set(definitions.map(cap => cap.id)).size).toBe(definitions.length);
    expect([...new Set(definitions.flatMap(cap => cap.commands))].sort()).toEqual([...FACADE_VERBS].sort());
    expect([...new Set(definitions.flatMap(cap => cap.operations))].sort()).toEqual([...EDIT_OP_TYPES].sort());
    const facade = createAgentFacade({ mediaRoots: [] }) as unknown as Record<string, unknown>;
    for (const cap of definitions) {
      expect(cap.targets.length).toBeGreaterThan(0);
      expect(cap.workflow.length).toBeGreaterThan(0);
      for (const name of cap.commands) {
        expect(typeof facade[name], name).toBe("function");
        expect(getCommandCatalogEntry(name, "live")?.inputSchema).toBeDefined();
      }
    }
  });

  it("returns short domain cards and selected packages without unrelated schemas", () => {
    expect(listCapabilityDomains().map(domain => domain.id)).toEqual(["video", "review", "library", "system"]);
    expect(listCapabilities({ domain: "review" }).every(cap => cap.domain === "review")).toBe(true);
    const graphics = getCapabilityTools("video.graphics");
    expect(graphics.operations).toEqual(["text.create", "text.update", "text.delete", "svg.create", "svg.update", "svg.remove"]);
    expect(graphics.tools.map(tool => tool.name)).toEqual(["edit.validate", "edit.apply"]);
    expect(JSON.stringify(graphics)).not.toMatch(/inputSchema|outputSchema|clip\.setDucking/);
    expect(graphics.tools.every(tool => tool.availability === "unprobed")).toBe(true);
    expect(getCapabilityTools("system.environment")).toMatchObject({
      capability: { targets: ["local"], localTools: expect.arrayContaining(["environment get", "environment check"]) }, tools: [],
    });
  });

  it("keeps review authority and explicit repair activation separate from video and private boards", () => {
    const repair = getCapabilityTools("review.image-repair");
    expect(repair.capability.activation).toBe("user-explicit");
    expect(repair.capability.targets).toEqual(["review-node"]);
    expect(repair.tools.length).toBeGreaterThan(0);
    expect(repair.tools.every(tool => tool.name.startsWith("review.repair."))).toBe(true);
    expect(listCapabilities({ domain: "video", includeLegacy: true }).flatMap(cap => cap.commands)
      .some(name => name.startsWith("review."))).toBe(false);
    expect(CAPABILITY_DEFINITIONS.some(cap => cap.id.includes("free-board") || cap.id.includes("human-board"))).toBe(false);
    expect(repair.tools.find(tool => tool.name === "review.repair.inspect")?.requiredAccess).toBe("read");
    expect(repair.tools.find(tool => tool.name === "review.repair.apply")?.requiredAccess).toBe("write");
    expect(getCapabilityTools("video.frames").tools.find(tool => tool.name === "frames.extract")?.dependencies)
      .toContain("mediaRoots");
  });

  it("does not probe media runtimes when querying capability metadata or schemas", () => {
    const ffmpegProbe = vi.spyOn(ffmpeg, "resolveToolFfmpeg");
    const openCvProbe = vi.spyOn(openCv, "resolveOpenCvRuntime");
    listCapabilityDomains();
    listCapabilities();
    getCapabilityTools("video.frame-processing");
    describeCommand("patch.propagate");
    expect(ffmpegProbe).not.toHaveBeenCalled();
    expect(openCvProbe).not.toHaveBeenCalled();
    ffmpegProbe.mockRestore();
    openCvProbe.mockRestore();
  });

  it("hides legacy packages by default and labels known unavailable commands honestly", () => {
    expect(listCapabilities().some(cap => cap.legacy)).toBe(false);
    expect(getCapabilityTools("review.legacy-branches").tools.find(tool => tool.name === "review.branches.create"))
      .toMatchObject({ status: "retired", availability: "unavailable" });
    expect(describeCommand("project.open")).toMatchObject({ status: "unsupported", availability: "unavailable" });
    expect(describeCommand("project.open", { mode: "headless" })).toMatchObject({ status: "registered", availability: "unprobed" });
  });

  it("rejects unknown discovery selectors instead of returning unrelated content", () => {
    expect(() => listCapabilities({ domain: "unknown" })).toThrow("Unknown capability domain");
    expect(() => getCapabilityTools("review.unknown")).toThrow("Unknown capability");
    expect(() => describeCommand("edit_apply")).toThrow("Unknown command");
    expect(() => describeCommand("timeline.get", { ops: ["clip.split"] })).toThrow("only by edit.apply");
    expect(() => describeCommand("edit.apply", { ops: [] })).toThrow("at least one");
    expect(() => describeCommand("edit.apply", { ops: ["clip.unknown"] })).toThrow("Unknown edit operation");
  });
});

describe("selective command contracts", () => {
  it("keeps the full contract by default and selects multiple ops without changing transaction guards", () => {
    const full = describeCommand("edit.apply");
    const selected = describeCommand("edit.apply", { ops: ["clip.split", "clip.trim", "clip.split"] });
    expect(variants(full.inputSchema)).toHaveLength(EDIT_OP_TYPES.length);
    expect(variants(selected.inputSchema).map(variant => variant.properties.op)).toEqual([{ const: "clip.trim" }, { const: "clip.split" }]);
    expect(selected.inputSchema.required).toEqual(full.inputSchema.required);
    expect(selected.inputSchema.properties.projectId).toEqual(full.inputSchema.properties.projectId);
    expect(selected.inputSchema.properties.workspaceId).toEqual(full.inputSchema.properties.workspaceId);
    expect(selected.inputSchema.properties.expectedRevision).toEqual(full.inputSchema.properties.expectedRevision);
    expect(selected.inputSchema.properties.idempotencyKey).toEqual(full.inputSchema.properties.idempotencyKey);
    expect(JSON.stringify(selected.inputSchema)).not.toContain("clip.setDucking");
    expect(variants(describeCommand("edit.apply").inputSchema)).toHaveLength(EDIT_OP_TYPES.length);
  });

  it("preserves live clip.add ID restrictions and validate/apply parameter differences", () => {
    const liveApply = describeCommand("edit.apply", { ops: ["clip.add"] });
    const headlessApply = describeCommand("edit.apply", { mode: "headless", ops: ["clip.add"] });
    const liveValidate = describeCommand("edit.validate", { ops: ["clip.add"] });
    expect(variants(liveApply.inputSchema)[0].properties).not.toHaveProperty("clipId");
    expect(variants(headlessApply.inputSchema)[0].properties).toHaveProperty("clipId");
    expect(liveApply.inputSchema.properties).toHaveProperty("idempotencyKey");
    expect(liveValidate.inputSchema.properties).not.toHaveProperty("idempotencyKey");
    expect(variants(liveValidate.inputSchema)[0].properties).not.toHaveProperty("clipId");
  });

  it("calls a real facade edit using the discovered selected operation contract", async () => {
    const facade = createAgentFacade({ mediaRoots: [] });
    const created = await facade["project.create"]({ name: "Capability contract" });
    expect(created.ok).toBe(true);
    const contract = describeCommand("edit.apply", { mode: "headless", ops: ["track.add"] });
    expect(variants(contract.inputSchema)[0].required).toEqual(["op", "trackType"]);
    const result = await facade[contract.name as "edit.apply"]({
      ops: [{ op: "track.add", trackType: "video" }], expectedRevision: 0, idempotencyKey: "discovered-edit",
    });
    expect(result.ok).toBe(true);
    const timeline = await facade["timeline.get"]();
    expect(timeline.ok).toBe(true);
    if (timeline.ok) expect(timeline.value.tracks).toHaveLength(1);
  });
});
