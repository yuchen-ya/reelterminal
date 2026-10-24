/**
 * Shared fixtures and Command API helpers for the round-2 workbench specs.
 *
 * Real media only: the image is copied from the shipped desktop icon, the
 * video is generated with the local ffmpeg. Both are written into the harness
 * run dir (an allowed media root) and imported through `media.import`, then a
 * review batch references them by `mediaId` through `workbench.ingest`.
 * No demo media is ever injected into a user project.
 */
import { copyFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import type { Page } from "playwright-core";
import type { ExternalAgent } from "./cli-client";
import { DESKTOP_DIR } from "./paths";

export interface WorkbenchIdentity {
  projectId: string;
  workspaceId: string;
  projectEpoch: string;
}

export interface CommandResult<T> {
  ok: boolean;
  value?: T;
  error?: { code: string; message: string };
}

export interface ImportedMedia {
  mediaId: string;
  revision: number;
  metadata: {
    durationSec: number;
    width: number;
    height: number;
    frameRate: number;
    codec: string;
    fileSize: number;
  };
}

export interface WorkbenchProjectState {
  revision: number;
  project: {
    mediaLibrary: {
      items: Array<{
        id: string;
        name: string;
        originalUrl?: string;
        contentUrl?: string;
        metadata?: { width?: number; height?: number; duration?: number };
      }>;
    };
    workbench: {
      items: Array<{
        id: string;
        version: number;
        status: string;
        content: Record<string, unknown>;
        revisions?: Array<{
          kind: string;
          mediaId?: string;
          parentVersion?: number;
          producedVersion?: number;
        }>;
        markers?: unknown;
      }>;
      feedback: Array<{
        id: string;
        itemId: string;
        text: string;
        state: string;
        itemVersion: number;
        referencedTagIds: string[];
        target?: Record<string, unknown>;
      }>;
      batches: Array<{ id: string; items: string[] }>;
    };
  };
}

export async function readIdentity(agent: ExternalAgent): Promise<WorkbenchIdentity> {
  const context = await agent.callCommand<{
    identity: { projectId: string; workspaceId: string; projectEpoch: string };
  }>("editor.get_context");
  if (!context.ok || !context.value?.identity.projectId) {
    throw new Error(`editor.get_context failed: ${JSON.stringify(context.error)}`);
  }
  return context.value.identity;
}

/** Poll until the workspace instance id stops changing (bootstrap race). */
export async function waitForStableWorkspace(
  agent: ExternalAgent,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last: string | undefined;
  while (Date.now() < deadline) {
    const context = await agent.callCommand<{ identity: { workspaceInstanceId?: string } }>(
      "editor.get_context",
    );
    const instance = context.value?.identity.workspaceInstanceId ?? "";
    if (instance && instance === last) return;
    last = instance;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
}

export async function readProjectState(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
): Promise<WorkbenchProjectState> {
  const state = await agent.callCommand<WorkbenchProjectState>("project.get_state", {
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
  });
  if (!state.ok || !state.value) {
    throw new Error(`project.get_state failed: ${JSON.stringify(state.error)}`);
  }
  return state.value;
}

export async function currentRevision(agent: ExternalAgent): Promise<number> {
  const context = await agent.callCommand<{ projectRevision: number }>("editor.get_context");
  if (!context.ok || typeof context.value?.projectRevision !== "number") {
    throw new Error(`editor.get_context failed: ${JSON.stringify(context.error)}`);
  }
  return context.value.projectRevision;
}

export async function importMedia(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  filePath: string,
  idempotencyKey: string,
): Promise<ImportedMedia> {
  const revision = await currentRevision(agent);
  const result = await agent.callCommand<ImportedMedia>("media.import", {
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    path: filePath,
    expectedRevision: revision,
    idempotencyKey,
  });
  if (!result.ok || !result.value?.mediaId) {
    throw new Error(`media.import(${filePath}) failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

export interface IngestItem {
  id: string;
  title: string;
  type: "image" | "video" | "text" | "data";
  content: Record<string, unknown>;
  subtitle?: string;
  provenanceTags?: Array<Record<string, unknown>>;
  agentGuidance?: Record<string, unknown>;
}

export async function ingestBatch(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  batchId: string,
  name: string,
  items: IngestItem[],
  idempotencyKey: string,
): Promise<{ acceptedItemIds: string[]; revision: number }> {
  const revision = await currentRevision(agent);
  const result = await agent.callCommand<{ acceptedItemIds: string[]; revision: number }>(
    "workbench.ingest",
    {
      projectId: identity.projectId,
      workspaceId: identity.workspaceId,
      expectedRevision: revision,
      idempotencyKey,
      batchId,
      name,
      items,
    },
  );
  if (!result.ok || !result.value) {
    throw new Error(`workbench.ingest failed: ${JSON.stringify(result.error)}`);
  }
  return result.value;
}

/** Write an edit.apply op against the current revision and identity. */
export async function applyOp(
  agent: ExternalAgent,
  identity: WorkbenchIdentity,
  ops: Array<Record<string, unknown>>,
): Promise<CommandResult<unknown>> {
  const revision = await currentRevision(agent);
  return agent.callCommand("edit.apply", {
    projectId: identity.projectId,
    workspaceId: identity.workspaceId,
    expectedRevision: revision,
    ops,
  });
}

/** Copy the shipped desktop icon as a real PNG review item. */
export function createImageFixture(runDir: string, fileName = "r2-image.png"): string {
  const source = path.join(DESKTOP_DIR, "build", "icon.png");
  if (!existsSync(source)) {
    throw new Error(`image fixture source missing: ${source}`);
  }
  const target = path.join(runDir, fileName);
  copyFileSync(source, target);
  return target;
}

/**
 * Generate a short CFR H.264 MP4 (30 fps, 2 s, start_time 0) with ffmpeg.
 * CFR is deliberately simple so a marker's PTS can be cross-checked with
 * `frames.extract`; the test reports the probed timing facts instead of
 * assuming them.
 */
export function createVideoFixture(runDir: string, fileName = "r2-video.mp4"): string {
  const target = path.join(runDir, fileName);
  execFileSync(
    "ffmpeg",
    [
      "-y",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=320x180:rate=30:duration=2",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      target,
    ],
    { stdio: "ignore" },
  );
  if (!existsSync(target)) throw new Error("ffmpeg did not produce the video fixture");
  return target;
}

/** Read-only timing probe used to state CFR/VFR honestly in evidence. */
export function probeFrameTiming(agent: ExternalAgent, mediaId: string): Promise<CommandResult<{
  frames: Array<{ frame: number; ptsTimeSec: number }>;
  facts: Record<string, unknown>;
}>> {
  return agent.callCommand("frames.extract", {
    source: { mediaId },
    selection: { frames: [0] },
  });
}

export async function switchToWorkbench(page: Page, timeout = 20_000): Promise<void> {
  const tab = page.getByRole("tab", { name: /Review Workspace|审阅工作台/i });
  await tab.waitFor({ state: "visible", timeout });
  await tab.click();
  await page.getByTestId("review-page").waitFor({ state: "visible" });
  if (!await page.locator("[data-review-legacy]").isVisible()) {
    for (const dismiss of await page.getByRole("button", { name: "Dismiss notification", exact: true }).all()) {
      await dismiss.click();
    }
    await page.getByTestId("review-legacy-project").click();
  }
  await page.getByTestId("workbench-page").waitFor({ state: "visible", timeout });
}

export async function selectTreeItem(page: Page, title: string): Promise<void> {
  await page
    .getByTestId("workbench-tree-panel")
    .getByText(title, { exact: true })
    .first()
    .click();
}
