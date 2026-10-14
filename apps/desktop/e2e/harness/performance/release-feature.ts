import { mkdir, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";
import { launchApp, type LaunchedApp } from "../launch";
import { connectExternalAgent, type ExternalAgent } from "../mcp-client";
import { createProjectViaUI, enableAgentSessionViaUI, openRecentProjectViaUI } from "../ui";
import { ARTIFACTS_DIR } from "../paths";
import type { CDPSession } from "playwright-core";
import { acquirePerformanceLock } from "./driver";
import { captureBuildIdentity, readEnvironmentIdentity } from "./identity";

export interface ReleaseFeatureContext {
  app: LaunchedApp;
  agent: ExternalAgent;
  target: Record<string, unknown>;
  evidence: string;
  record: any;
  call(name: string, args?: Record<string, unknown>): Promise<any>;
  reply(name: string, args?: Record<string, unknown>): Promise<any>;
  flush(): Promise<void>;
  sample(): Promise<any>;
  reconnect(): Promise<void>;
}

/** Opt-in, single owned desktop/profile; no endpoint descriptors enter evidence. */
export async function runReleaseFeature(
  name: string,
  body: (context: ReleaseFeatureContext) => Promise<void>,
  options: { runDir?: string; createProject?: boolean; setup?: (app: LaunchedApp) => Promise<void> } = {},
): Promise<void> {
  const unlock = await acquirePerformanceLock();
  const evidence = path.join(ARTIFACTS_DIR, "performance", "feature-" + name + "-" + Date.now());
  await mkdir(evidence, { recursive: true });
  const record: any = { scenario: name, status: "running", operations: [], samples: [], started_epoch_ms: Date.now() };
  let app: LaunchedApp | undefined;
  let agent: ExternalAgent | undefined;
  let cdp: CDPSession | undefined;
  let context: ReleaseFeatureContext | undefined;
  let schemas = new Map<string, any>();
  const flush = () => writeFile(path.join(evidence, "result.json"), JSON.stringify(record, null, 2));
  try {
    record.build = await captureBuildIdentity();
    if (!record.build.build_verified) throw new Error("feature stress needs a matching production build");
    app = await launchApp({ ...(options.runDir ? { runDir: options.runDir } : {}), keepRunDir: true });
    record.retained_profile = app.runDir;
    record.application = await app.app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged, arch: process.arch, pid: process.pid, versions: process.versions }));
    record.executable = process.env.REELTERMINAL_E2E_APP_EXECUTABLE ?? "checkout Electron";
    await app.app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]!; w.setContentSize(1280, 800); w.show(); w.focus(); });
    if (options.setup) await options.setup(app);
    if (options.createProject !== false) await createProjectViaUI(app.page);
    await enableAgentSessionViaUI(app.page, app.endpointFile);
    agent = await connectExternalAgent(app.endpointFile);
    context = { app, agent, target: {}, evidence, record, flush, call: undefined!, reply: undefined!, sample: undefined!, reconnect: undefined! };
    const connect = async () => {
      schemas = new Map((await context!.agent.client.listTools()).tools.map(tool => [tool.name, (tool as any).inputSchema]));
      const ctx = await context!.agent.callTool<any>("editor_get_context");
      if (!ctx.ok) throw new Error("editor context unavailable");
      context!.target = { projectId: ctx.value.identity.projectId, workspaceId: ctx.value.identity.workspaceId };
      await cdp?.detach().catch(() => undefined);
      cdp = await context!.app.page.context().newCDPSession(context!.app.page);
      await cdp.send("Performance.enable");
    };
    context.reply = async (verb, args = {}) => {
      const properties = schemas.get(verb)?.properties ?? {};
      const target = Object.fromEntries(Object.entries(context!.target).filter(([key]) => key in properties));
      const result = await context!.agent.callTool<any>(verb, { ...target, ...args }, { timeoutMs: 120_000 });
      if (!result.ok) { record.rejected_requests ??= []; record.rejected_requests.push({ verb, args, error: result.error }); }
      if (result.ok && verb === "job_status") { record.latest_job_statuses ??= {}; record.latest_job_statuses[String(args.jobId)] = result.value; }
      if (result.ok && verb === "analysis_get") { record.latest_analysis_views ??= {}; record.latest_analysis_views[String(args.recordId) + ":" + String(args.view ?? "summary")] = result.value; }
      return result;
    };
    context.call = async (verb, args = {}) => {
      const result = await context!.reply(verb, args);
      if (!result.ok) throw new Error(verb + ": " + result.error?.code + ": " + result.error?.message);
      if (result.value?.jobId && (verb.endsWith("_start") || verb === "audio_process_normalize")) {
        record.owned_job_ids ??= []; record.owned_job_ids.push(result.value.jobId);
      }
      return result.value;
    };
    context.sample = async () => {
      const metrics = await cdp!.send("Performance.getMetrics");
      const heap = Object.fromEntries(metrics.metrics.map((m: any) => [m.name, m.value]));
      const main = await context!.app.app.evaluate(({ app }) => ({ memory: process.memoryUsage(), processes: app.getAppMetrics().map(p => ({ pid: p.pid, epoch: p.creationTime, type: p.type, rss_bytes: p.memory.workingSetSize * 1024 })) }));
      const renderer = await context!.app.page.evaluate(async () => ({ visible: !document.hidden, resources: await (globalThis as any).__reelterminalPerformanceCapture.readResources() }));
      if (!renderer.visible) throw new Error("feature stress window hidden");
      const sample = { elapsed_ms: Date.now() - record.started_epoch_ms, phase: record.phase ?? null, heap, main, ...renderer };
      record.samples.push(sample);
      await appendFile(path.join(evidence, "resources.jsonl"), JSON.stringify(sample) + "\n");
      return sample;
    };
    context.reconnect = async () => {
      for (const [key, lines] of Object.entries(context!.app.output)) {
        await writeFile(path.join(evidence, "before-relaunch-" + key + ".redacted.log"), lines.join("\n").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]"));
      }
      await context!.agent.close();
      await cdp?.detach().catch(() => undefined);
      context!.app = await context!.app.relaunch();
      // Relaunch initially exposes a loading document. Wait for the library
      // and the saved card rather than racing its first render with isVisible.
      await openRecentProjectViaUI(context!.app.page, record.project_name);
      await enableAgentSessionViaUI(context!.app.page, context!.app.endpointFile);
      context!.agent = await connectExternalAgent(context!.app.endpointFile);
      await connect();
      record.relaunched_application = await context!.app.app.evaluate(({ app }) => ({ pid: process.pid, packaged: app.isPackaged, version: app.getVersion() }));
    };
    await connect();
    record.capabilities = await context.call("capabilities_get");
    record.project_name = (await context.call("project_get_state")).project.name;
    record.environment = await readEnvironmentIdentity(app);
    await flush();
    console.info("RELEASE_FEATURE_EVIDENCE", evidence);
    await body(context);
    record.status = "passed";
  } catch (error) {
    record.status = "failed";
    record.error = String(error);
    await (context?.app ?? app)?.page.screenshot({ path: path.join(evidence, "failure.png"), timeout: 5000 }).catch(() => undefined);
    throw error;
  } finally {
    record.finished_epoch_ms = Date.now();
    const currentApp = context?.app ?? app;
    if (context) {
      for (const jobId of record.owned_job_ids ?? []) {
        try {
          let status = await context.agent.callTool<any>("job_status", { jobId }, { timeoutMs: 5000 });
          if (status.ok && !["done", "error", "cancelled"].includes(status.value.state)) {
            await context.agent.callTool("job_cancel", { jobId }, { timeoutMs: 5000 });
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              status = await context.agent.callTool<any>("job_status", { jobId }, { timeoutMs: 5000 });
              if (!status.ok || ["done", "error", "cancelled"].includes(status.value.state)) break;
              await new Promise(resolve => setTimeout(resolve, 50));
            }
          }
        } catch (error) { record.cleanup_errors ??= []; record.cleanup_errors.push(String(error)); }
      }
    }
    for (const [key, lines] of Object.entries(currentApp?.output ?? {})) {
      await writeFile(path.join(evidence, key + ".redacted.log"), (lines as string[]).join("\n").replace(/\b[a-f0-9]{64}\b/gi, "[redacted]"));
    }
    await flush();
    try { await cdp?.detach().catch(() => undefined); await (context?.agent ?? agent)?.close(); }
    finally { try { await currentApp?.close({ keepRunDir: record.status !== "passed" }); } finally { await unlock(); } }
    console.info("RELEASE_FEATURE_FINISHED", evidence, record.status);
  }
}
