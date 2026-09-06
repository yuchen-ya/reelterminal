import { stat } from "node:fs/promises";
import { resolveContainedPathDetailed } from "../media/path-roots";
import { FacadeError } from "../errors";
import { definePlugin, defineTool } from "../plugin-api";

export const importPreflightPlugin = definePlugin({ id: "import-preflight", tools: [defineTool({
  name: "media.import_preflight", effect: "read", requires: ["mediaRoots"],
  description: "Cheap local stat/root/size check BEFORE importing. Does not read full media, import, select or change revision. Codec decodability remains unchecked; live GUI currently buffers at most 256MiB. No proxy is generated.",
  input: { path: { required: true, check: (v) => typeof v === "string" && v.length > 0, describe: "absolute local file under a configured media root", emits: { kind: "leaf", schema: { type: "string", minLength: 1 } } } },
  output: { type: "object", additionalProperties: true, properties: {} },
  schemaCases: [{ name: "path", params: { path: "/tmp/file.mp4" }, expectValid: true }, { name: "missing", params: {}, expectValid: false }],
  async execute(input: { path: string }, context) {
    const resolved = resolveContainedPathDetailed(input.path, context.mediaRoots);
    if (resolved.kind !== "ok") throw new FacadeError("INVALID_PARAMS", "Import path must be readable inside a configured media root");
    const file = await stat(resolved.path);
    if (!file.isFile()) throw new FacadeError("INVALID_PARAMS", "Import path must be a regular file");
    const maxFileBytes = context.mode === "live" ? 256 * 1024 * 1024 : null;
    const withinSizeLimit = maxFileBytes === null || file.size <= maxFileBytes;
    return { path: resolved.path, sizeBytes: file.size, lastModified: Math.round(file.mtimeMs), maxFileBytes, withinSizeLimit,
      codecStatus: "unchecked", readyToImport: withinSizeLimit ? "size-and-path-only" : false,
      suggestions: withinSizeLimit ? [] : ["Create explicit shorter source segments below the size limit, preserve originals and record segment start offsets for time mapping.", "Keep frame rate and audio timing. Proxy binding/relink is not implemented; do not silently substitute a low quality proxy for the final source."],
      limitations: ["Stat-only preflight is not a decode or content review. Import revalidates the file to guard changes after preflight."] };
  },
})] });
