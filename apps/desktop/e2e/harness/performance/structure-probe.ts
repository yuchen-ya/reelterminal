import { readFile, stat } from "node:fs/promises";
import { request } from "node:http";
import path from "node:path";
import type { LaunchedApp } from "../launch";
import { LiveCommandClient, validateLoopbackUrl, type LiveEndpoint } from "../../../src/reelctl/client";

/**
 * One preparation-only read for the 64 MiB structural fixture. The shipped Command API
 * client caps responses at 64 MiB; JSON overhead exceeds that cap. This harness
 * client accepts at most 80 MiB and returns only a number, never project bytes.
 * Credentials are read only from the explicitly owned endpoint, never logged.
 */
export async function readHydratedStructureBytes(
  launched: LaunchedApp,
  target: { projectId: string; workspaceId: string },
  timeoutMs: number,
): Promise<number> {
  if (path.dirname(path.resolve(launched.endpointFile)) !== path.resolve(launched.runDir)) {
    throw new Error("structural probe endpoint is outside the owned run directory");
  }
  if ((await stat(launched.endpointFile)).size > 64 * 1024) throw new Error("endpoint descriptor exceeds budget");
  const endpoint = JSON.parse(await readFile(launched.endpointFile, "utf8")) as LiveEndpoint;
  const base = validateLoopbackUrl(endpoint.commandApi.url);
  if (endpoint.commandApi.version !== 1 || base.pathname !== "/v1" || typeof endpoint.token !== "string" || !endpoint.token) {
    throw new Error("invalid isolated endpoint descriptor");
  }
  const status = await new LiveCommandClient(endpoint).status();
  const body = JSON.stringify({ command: "project.get_state", arguments: target, expectedProjectEpoch: status.projectEpoch });
  return new Promise<number>((resolve, reject) => {
    const call = request({
      hostname: base.hostname, port: base.port, path: "/v1/command", method: "POST",
      headers: { Authorization: `Bearer ${endpoint.token}`, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, (response) => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 80 * 1024 * 1024) {
          call.destroy(new Error("structural response exceeds 80 MiB budget"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        try {
          const result = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { ok: boolean; value?: { project: { performanceFixture?: { syntheticFontStructure: { dataUrlStructure: string } } } } };
          if (response.statusCode !== 200 || !result.ok) throw new Error("hydrated structural read failed");
          const payload = result.value!.project.performanceFixture?.syntheticFontStructure.dataUrlStructure;
          if (typeof payload !== "string") throw new Error("hydrated structural fixture missing");
          resolve(payload.length);
        } catch (error) { reject(error); }
      });
    });
    call.setTimeout(timeoutMs, () => call.destroy(new Error("structural read timed out")));
    call.on("error", reject);
    call.end(body);
  });
}
