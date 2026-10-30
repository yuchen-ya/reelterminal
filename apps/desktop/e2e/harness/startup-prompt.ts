import { expect } from "vitest";
import { decodeAgentTarget } from "../../src/shared/agent-target";

/** Validate the compact startup command's identity, rather than retired prose. */
export function expectVideoStartupPrompt(prompt: string, identity: { projectId: string; workspaceId: string }) {
  expect(prompt).toContain(" start --target ");
  const reference = prompt.match(/--target (rt1\.[A-Za-z0-9_-]+)/)?.[1];
  expect(reference).toBeDefined();
  const binding = decodeAgentTarget(reference!);
  expect(binding).toMatchObject({ kind: "video", projectId: identity.projectId, workspaceId: identity.workspaceId });
  expect(prompt).not.toMatch(/Bearer|token|\b[a-f0-9]{64}\b/i);
  return binding;
}
