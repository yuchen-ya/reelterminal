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

export function getLiveSessionHost(): LiveSessionHost {
  if (!host) {
    host = createLiveSessionHost({
      artifactRoot: path.join(app.getPath("userData"), "live-artifacts"),
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
