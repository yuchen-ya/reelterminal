import { realpathSync } from "node:fs";
import { resolveContainedPathDetailed } from "@reelterminal/agent-facade/media/path-roots";
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
  console.log("REVIEW_PACKAGE_CONTAINMENT", JSON.stringify({
    capabilityOk: capability.ok, rootCount: roots.length,
    testRoot: realpath(runDir), candidate: realpath(directory),
    roots: roots.map(realpath),
    testRootVerdict: resolveContainedPathDetailed(directory, [runDir]).kind,
    capabilityVerdict: resolveContainedPathDetailed(directory, roots).kind,
  }));
}
