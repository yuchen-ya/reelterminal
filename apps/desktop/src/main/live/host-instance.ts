/**
 * The Electron-backed LiveSessionHost singleton (ADR 0004): production
 * wiring for createLiveSessionHost — the renderer-store bridge, Chromium
 * providers (same createChromiumProviders + FfmpegArtifactVerifier pattern
 * as agent-transport's session.ts), the facade factory, the liveEvents push
 * to the editor window, and the artifact root under app userData.
 *
 * Kept separate from live-session-host.ts so the host core stays
 * Electron-free and unit-testable.
 */
import { app } from "electron";
import { mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { createLiveFacade } from "@openreel/agent-facade";
import {
  createChromiumProviders,
  FfmpegArtifactVerifier,
} from "@openreel/runtime-chromium";
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

let host: LiveSessionHost | null = null;

/**
 * The one Agent workspace root under the OS Videos folder (`jobs` + `shared`
 * are created eagerly so a user can open it before any Agent ran). Shared by
 * the media-roots default and the "open workspace" IPC — single source.
 */
export function agentWorkspaceRoot(): string {
  return path.join(
    app.getPath("videos"),
    "ReelTerminal Agent Workspace",
  );
}

/**
 * Local roots exposed by `capabilities_get.mediaImport.mediaRoots`.
 *
 * The default deliberately avoids granting the whole home directory. It
 * covers the OS folders where people and creative Agents normally put media,
 * and creates one deterministic workspace under Videos for generated assets,
 * working files, deliverables, and evidence.
 * Advanced hosts can replace the list before launch without changing the
 * MCP contract.
 */
function liveMediaRoots(): readonly string[] {
  const configured = process.env.OPENREEL_LIVE_MEDIA_ROOTS;
  if (configured?.trim()) {
    return configured
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter((entry) => path.isAbsolute(entry) && isDirectory(entry));
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
  return [...new Set(candidates.filter(isDirectory))];
}

function isDirectory(candidate: string): boolean {
  try {
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

export function getLiveSessionHost(): LiveSessionHost {
  if (!host) {
    host = createLiveSessionHost({
      artifactRoot: path.join(app.getPath("userData"), "live-artifacts"),
      mediaRoots: liveMediaRoots(),
      installStoreBridge: installLiveStoreBridge,
      createProviders: (): LiveProviders => {
        const chromium = createChromiumProviders();
        return {
          renderProvider: chromium.renderProvider,
          exportProvider: chromium.exportProvider,
          artifactVerifier: new FfmpegArtifactVerifier(),
          close: () => chromium.close(),
        };
      },
      createFacade: createLiveFacade,
      emitEvent: (event) => {
        const contents = liveTargetWebContents();
        if (contents && !contents.isDestroyed()) {
          contents.send(CHANNELS.liveEvent, event);
        }
      },
      serverInfo: { name: "openreel-live", version: app.getVersion() },
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
