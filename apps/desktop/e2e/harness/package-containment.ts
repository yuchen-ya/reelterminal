import { realpathSync } from "node:fs";
import path from "node:path";
import { resolveContainedPathDetailed } from "@reelterminal/agent-facade/media/path-roots";
import { isForbiddenLocalPath } from "@reelterminal/core/security/local-path-policy";
import type { ExternalAgent } from "./cli-client";

/** Emit verdicts only, never paths, when a package inside a test root is refused. */
export async function diagnosePackageContainment(agent: ExternalAgent, directory: string, runDir: string): Promise<void> {
  const capability = await agent.callCommand<{ mediaImport: { mediaRoots: string[] } }>("capabilities.get", { kind: "review" });
  const roots = capability.ok ? capability.value?.mediaImport.mediaRoots ?? [] : [];
  const realpath = (candidate: string) => {
    try {
      const real = realpathSync(candidate);
      return { ok: true, extendedNamespace: /^\\\\[?.]\\/.test(real) };
    } catch (error) {
      return { ok: false, code: (error as NodeJS.ErrnoException).code ?? "unknown" };
    }
  };
  const relation = (root: string, candidate: string) => {
    try {
      const actualRoot = realpathSync(root);
      const actualCandidate = realpathSync(candidate);
      const relative = path.relative(actualRoot, actualCandidate);
      return {
        inputForbidden: isForbiddenLocalPath(candidate),
        rootForbidden: isForbiddenLocalPath(root),
        realCandidateForbidden: isForbiddenLocalPath(actualCandidate),
        realRootForbidden: isForbiddenLocalPath(actualRoot),
        relativeIsAbsolute: path.isAbsolute(relative),
        relativeEscapes: relative === ".." || relative.startsWith(".." + path.sep),
        relativeEmpty: relative === "",
      };
    } catch { return { unavailable: true }; }
  };
  console.log("REVIEW_PACKAGE_CONTAINMENT", JSON.stringify({
    capabilityOk: capability.ok, rootCount: roots.length,
    testRoot: realpath(runDir), candidate: realpath(directory),
    roots: roots.map(realpath),
    testRootRelation: relation(runDir, directory),
    testRootVerdict: resolveContainedPathDetailed(directory, [runDir]).kind,
    capabilityVerdict: resolveContainedPathDetailed(directory, roots).kind,
  }));
}
