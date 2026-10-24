/**
 * The Electron-backed LiveSessionHost singleton: production
 * wiring for createLiveSessionHost — the renderer-store bridge, Chromium
 * providers (same createChromiumProviders + FfmpegArtifactVerifier pattern
 * as agent-transport's session.ts), the facade factory, the liveEvents push
 * to the editor window, and the artifact root under app userData.
 *
 * Kept separate from live-session-host.ts so the host core stays
 * Electron-free and unit-testable.
 */
import { app } from "electron";
import { getReviewFileStore } from "../ipc/review-files";
import { createReviewMediaBridge } from "./review-media-bridge";
import { getPerfSink } from "@reelterminal/core";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createLiveFacade } from "@reelterminal/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
  adaptPerfSinkForExport,
} from "@reelterminal/runtime-chromium";
import { CHANNELS } from "../../shared/channels";
import {
  createLiveSessionHost,
  type LiveProviders,
  type LiveSessionHost,
} from "./live-session-host";
import {
  installLiveStoreBridge,
  liveTargetWebContents,
} from "./renderer-store-adapter";
import { getAgentAccessPreferenceStore } from "./access-instance";
import { agentWorkspaceDefault } from "../data-root";
import { controlledMediaRoot } from "../ipc/controlled-media";

let host: LiveSessionHost | null = null;

/**
 * The one Agent workspace root under the OS Videos folder (`jobs` + `shared`
 * are created eagerly so a user can open it before any Agent ran). Shared by
 * the media-roots default and the "open workspace" IPC — single source.
 */
export function agentWorkspaceRoot(): string {
  const configured = process.env.REELTERMINAL_AGENT_WORKSPACE_ROOT;
  if (configured && path.isAbsolute(configured)) return configured;
  // Data-root aware default: `<dataRoot>/agent-workspace` when the data root
  // is active, else the pre-data-root folder under Videos (docs/DATA-ROOT.md).
  return agentWorkspaceDefault();
}

export function agentWorkspaceScopes(): { video: string; review: string } {
  const workspace = agentWorkspaceRoot();
  const roots = { video: path.join(workspace, "video"), review: path.join(workspace, "review") };
  for (const root of Object.values(roots)) {
    mkdirSync(path.join(root, "jobs"), { recursive: true });
    mkdirSync(path.join(root, "shared"), { recursive: true });
  }
  return roots;
}

/**
 * Local roots exposed by `capabilities_get.mediaImport.mediaRoots`.
 *
 * The default deliberately avoids granting the whole home directory. It
 * covers the OS folders where people and creative Agents normally put media,
 * and creates one deterministic workspace under Videos for generated assets,
 * working files, deliverables, and evidence.
 * Advanced hosts can replace the list before launch without changing the
 * Command API contract.
 */
export function liveMediaRoots(): readonly string[] {
  const scopes = Object.values(agentWorkspaceScopes());
  const controlledRoot = controlledMediaRoot();
  mkdirSync(controlledRoot, { recursive: true });
  const configured = process.env.REELTERMINAL_LIVE_MEDIA_ROOTS;
  if (configured?.trim()) {
    const roots = configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => path.isAbsolute(entry) && isDirectory(entry));
    return [...new Set([...roots, ...scopes, controlledRoot])];
  }

  const workspace = agentWorkspaceRoot();
  mkdirSync(path.join(workspace, "jobs"), { recursive: true });
  mkdirSync(path.join(workspace, "shared"), { recursive: true });

  // Keep the former inbox readable so existing projects do not lose access
  // to media imported before the workspace convention was introduced. New
  // Agent work belongs under workspace/jobs; the first root is advertised as
  // capabilities_get.mediaImport.recommendedRoot.
  const legacyInbox = path.join(
    app.getPath("videos"),
    "ReelTerminal Agent Imports",
  );
  const candidates = [
    workspace,
    legacyInbox,
    app.getPath("desktop"),
    app.getPath("documents"),
    app.getPath("downloads"),
    app.getPath("music"),
    app.getPath("pictures"),
    app.getPath("videos"),
  ];
  return [...new Set([...candidates.filter(isDirectory), ...scopes, controlledRoot])];
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Roots under which export.start's destinationPath may deliver finished
 * artifacts (`<root>/jobs/<slug>/output/`). Defaults to the Agent workspace
 * root — the one place the workspace convention defines a deliverables
 * directory. REELTERMINAL_LIVE_DELIVERY_ROOTS overrides
 * for advanced hosts.
 */
function liveDeliveryRoots(): readonly string[] {
  const configured = process.env.REELTERMINAL_LIVE_DELIVERY_ROOTS;
  if (configured?.trim()) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => path.isAbsolute(entry) && isDirectory(entry));
  }
  return [agentWorkspaceRoot()];
}

/**
 * Host-level knobs for the export ceilings: the no-progress watchdog and
 * the total budget are pool config, and operators get environment overrides
 * (REELTERMINAL_EXPORT_WATCHDOG_MS / REELTERMINAL_EXPORT_BUDGET_MS) so a
 * known-slow machine can raise them without a rebuild. 0 disables the
 * budget; both must be positive integers otherwise.
 */
function chromiumProvidersFromEnv(): Parameters<typeof createChromiumProviders>[0] {
  const parse = (name: string): number | undefined => {
    const raw = process.env[name]?.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : undefined;
  };
  const exportWatchdogMs = parse("REELTERMINAL_EXPORT_WATCHDOG_MS");
  const exportTotalBudgetMs = parse("REELTERMINAL_EXPORT_BUDGET_MS");
  return {
    ...(exportWatchdogMs !== undefined && exportWatchdogMs > 0 ? { exportWatchdogMs } : {}),
    ...(exportTotalBudgetMs !== undefined ? { exportTotalBudgetMs } : {}),
  };
}

export function getLiveSessionHost(): LiveSessionHost {
  if (!host) {
    host = createLiveSessionHost({
      artifactRoot: path.join(app.getPath("userData"), "live-artifacts"),
      mediaRoots: liveMediaRoots(),
      workspaceRoots: agentWorkspaceScopes(),
      deliveryRoots: liveDeliveryRoots(),
      installStoreBridge: installLiveStoreBridge,
      createProviders: (): LiveProviders => {
        const chromium = createChromiumProviders({
          ...chromiumProvidersFromEnv(),
          exportPerformanceSinkFactory: (jobId) => {
            const sink = getPerfSink();
            let runId = `live-export-${jobId}`;
            try {
              const suppliedRunId = sink.runId;
              if (typeof suppliedRunId === "string" && suppliedRunId.length > 0) runId = suppliedRunId;
            } catch {
              // Collector metadata is observational and cannot veto an export.
            }
            return adaptPerfSinkForExport(sink, { runId, operationId: jobId });
          },
        });
        return {
          renderProvider: chromium.renderProvider,
          exportProvider: chromium.exportProvider,
          artifactVerifier: new FfmpegArtifactVerifier(),
          close: () => chromium.close(),
        };
      },
      createFacade: config => createLiveFacade({ ...config, ...(config.reviewCommand ? {
        reviewCommand: createReviewMediaBridge(config.reviewCommand, getReviewFileStore, agentWorkspaceScopes().review),
      } : {}) }),
      emitEvent: (event) => {
        const contents = liveTargetWebContents();
        if (contents && !contents.isDestroyed()) {
          contents.send(CHANNELS.liveEvent, event);
        }
      },
      serverInfo: { name: "reelterminal-live", version: app.getVersion() },
      accessPreferenceStore: getAgentAccessPreferenceStore(),
    });
  }
  return host;
}

/** App-quit path (wired alongside stopMcpServer in main/index.ts). */
export async function disposeLiveSessionHost(): Promise<void> {
  const current = host;
  host = null;
  if (current?.isEnabled) {
    await current.disable().catch(() => undefined);
  }
}
