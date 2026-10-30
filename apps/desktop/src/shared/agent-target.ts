import { z } from "zod";

const identity = z.string().min(1).max(256).refine(value => value.trim().length > 0);
export const agentTargetRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("video"), projectId: identity, workspaceId: identity }).strict(),
  z.object({ kind: z.literal("review"), reviewWorkspaceId: z.string().uuid(), instanceId: z.string().uuid(), nodeId: z.string().uuid().optional() }).strict(),
]);
export const agentTargetSchema = z.discriminatedUnion("kind", [
  agentTargetRequestSchema.options[0].extend({ instanceId: identity, hostInstanceId: identity }),
  agentTargetRequestSchema.options[1],
]);
export type AgentTargetRequest = z.infer<typeof agentTargetRequestSchema>;
export type AgentTarget = z.infer<typeof agentTargetSchema>;

/** Self-contained identity only: no credentials, mutable selection, or session DB. */
export function encodeAgentTarget(target: AgentTarget): string {
  return `rt1.${Buffer.from(JSON.stringify(agentTargetSchema.parse(target))).toString("base64url")}`;
}

export function decodeAgentTarget(reference: string): AgentTarget {
  if (!/^rt1\.[A-Za-z0-9_-]+$/.test(reference) || reference.length > 4096) throw new Error("Invalid target reference; copy the startup prompt from the intended workspace");
  let value: unknown;
  try { value = JSON.parse(Buffer.from(reference.slice(4), "base64url").toString("utf8")); }
  catch { throw new Error("Invalid target reference JSON"); }
  return agentTargetSchema.parse(value);
}
