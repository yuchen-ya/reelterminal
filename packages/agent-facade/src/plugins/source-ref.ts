/**
 * Source-reference input handling shared by the production-tool plugins
 * (frame-tools, motion-tools): {"mediaId"} or {"path"} — exactly one —
 * resolved against the session's media roots plus the artifact root.
 */
import type { ToolContext } from "../plugin-api";
import { resolveLocalSourceFile } from "../media/source-file";

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export interface SourceRef {
  readonly kind: "mediaId" | "path";
  readonly value: string;
}

export function parseSourceRef(v: unknown): SourceRef | null {
  if (!isPlainObject(v)) return null;
  const hasMedia = typeof v.mediaId === "string" && v.mediaId.length > 0;
  const hasPath = typeof v.path === "string" && v.path.length > 0;
  if (hasMedia === hasPath) return null;
  return hasMedia ? { kind: "mediaId", value: v.mediaId as string } : { kind: "path", value: v.path as string };
}

export async function resolveSourceFile(source: SourceRef, context: ToolContext, verb: string): Promise<string> {
  if (source.kind === "mediaId") {
    const { project } = await context.snapshot();
    return context.resolveMediaPath(source.value, project);
  }
  const roots = [...context.mediaRoots, ...(context.artifactRoot ? [context.artifactRoot] : [])];
  const resolved = await resolveLocalSourceFile(
    { path: source.value },
    { verb, roots, requireAbsolute: false },
  );
  return resolved.path;
}
