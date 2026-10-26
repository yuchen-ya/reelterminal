import { describe, expect, it } from "vitest";
import {
  artifactOwnershipMatchesTarget,
  createArtifactFileRecord,
  createArtifactOwnership,
  isArtifactFileRecord,
  isArtifactOwnership,
  type ArtifactFileRecord,
  type ArtifactOwnership,
} from "./artifact-ownership";

const output: ArtifactOwnership = {
  kind: "output",
  purpose: "Review export",
  origin: "agent",
  projectId: "project-a",
  workspaceId: "workspace-a",
  nodeId: "node-a",
  deliveryStatus: "pending",
};

const retainedFrame: ArtifactFileRecord = {
  fileId: "preview-frame",
  path: "C:/workspace/live-artifacts/renders/preview.png",
  kind: "work",
  purpose: "Preview frame",
  origin: "agent",
  rebuildable: true,
  deliveryStatus: "pending",
};

describe("artifact ownership", () => {
  it("validates and clones the four ownership categories with agent provenance", () => {
    expect(isArtifactOwnership(output)).toBe(true);
    expect(createArtifactOwnership(output)).toEqual(output);
    expect(isArtifactOwnership({ ...output, kind: "agent" })).toBe(false);
  });

  it("requires project and workspace ownership and checks the requested node when supplied", () => {
    expect(isArtifactOwnership({ ...output, projectId: "" })).toBe(false);
    expect(isArtifactOwnership({ ...output, workspaceId: "" })).toBe(false);
    expect(artifactOwnershipMatchesTarget(output, {
      projectId: "project-a",
      workspaceId: "workspace-a",
      nodeId: "node-a",
    })).toBe(true);
    expect(artifactOwnershipMatchesTarget(output, {
      projectId: "project-b",
      workspaceId: "workspace-a",
    })).toBe(false);
    expect(artifactOwnershipMatchesTarget(output, {
      projectId: "project-a",
      workspaceId: "workspace-a",
      nodeId: "node-b",
    })).toBe(false);
  });

  it("validates exact producer file records without making AI a file category", () => {
    expect(isArtifactFileRecord(retainedFrame)).toBe(true);
    expect(createArtifactFileRecord(retainedFrame)).toEqual(retainedFrame);
    expect(isArtifactFileRecord({ ...retainedFrame, path: "relative/output.wav" })).toBe(false);
    expect(isArtifactFileRecord({ ...retainedFrame, kind: "agent" })).toBe(false);
    expect(isArtifactFileRecord({ ...retainedFrame, origin: "user" })).toBe(false);
  });
});
