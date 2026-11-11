import { expect, test, vi } from "vitest";
import type { EditApplyResult, TimelineQueryResult, TimelineState } from "@reelterminal/agent-facade/types";
import { launchApp } from "./harness/launch";
import { connectExternalAgent, value, type ExternalAgent } from "./harness/cli-client";
import { createProjectViaUI, enableAgentSessionViaUI } from "./harness/ui";

test("reelctl replaces GUI and native captions in place and one undo restores both", async () => {
  const app = await launchApp();
  let agent: ExternalAgent | undefined;
  try {
    await createProjectViaUI(app.page);
    const guiSrt = "1\n00:00:00,000 --> 00:00:01,000\nOld GUI cue\n\n2\n00:00:02,000 --> 00:00:03,000\nLater GUI cue";
    await app.page.locator('input[type="file"][aria-label="Import media"]').setInputFiles({
      name: "scene.srt", mimeType: "application/x-subrip", buffer: Buffer.from(guiSrt),
    });
    await enableAgentSessionViaUI(app.page, app.endpointFile);
    agent = await connectExternalAgent(app.endpointFile);
    const { identity } = value(await agent.callCommand<{ identity: { projectId: string; workspaceId: string } }>("editor.get_context"));
    const target = { projectId: identity.projectId, workspaceId: identity.workspaceId };
    const call = async <T>(name: string, args: Record<string, unknown> = {}) =>
      value(await agent!.callCommand<T>(name, { ...target, ...args }));
    const timeline = () => call<TimelineState>("timeline.get");
    const query = () => call<TimelineQueryResult>("timeline.query", {
      entityTypes: ["text", "subtitle"], timeRange: { startSec: 0, endSec: 2 },
      fields: ["text", "captionSource", "captionSourceClipId"],
    });
    await vi.waitFor(async () => expect((await timeline()).textOverlays).toHaveLength(2), { timeout: 15_000 });
    const seeded = await timeline();
    const trackId = seeded.textOverlays[0]!.trackId;
    await call("edit.apply", { expectedRevision: seeded.revision, ops: [
      { op: "text.create", trackId, text: "Keep title", startTime: 0, duration: 1 },
      { op: "subtitle.importSrt", srtContent: "1\n00:00:00,000 --> 00:00:01,000\nOld native cue" },
    ] });
    const before = await timeline();
    const selection = await query();
    const guiCue = selection.items.find(item => item.data.captionSource === "srt")!;
    const title = selection.items.find(item => item.data.text === "Keep title")!;
    const nativeCue = selection.items.find(item => item.entityType === "subtitle")!;
    expect(selection.items).toHaveLength(3);
    expect(guiCue.data.text).toBe("Old GUI cue");
    expect(title.trackId).toBe(guiCue.trackId);
    const removeNative = { op: "subtitle.remove", entityType: "subtitle", ids: [nativeCue.id] };
    const removeGui = { op: "subtitle.remove", entityType: "text", ids: [guiCue.id] };
    const importNew = { op: "subtitle.importSrt", srtContent: "1\n00:00:00,100 --> 00:00:01,300\nRevised cue" };
    const ops = [removeNative, removeGui, importNew];
    const bad = await agent.callCommand("edit.apply", { ...target, expectedRevision: before.revision,
      ops: [removeNative, { ...removeGui, ids: [guiCue.id, title.id] }, importNew] });
    expect(bad).toMatchObject({ ok: false, error: { code: "INVALID_PARAMS" } });
    expect(await call("edit.validate", { expectedRevision: selection.revision, ops })).toMatchObject({ valid: true });
    expect(await timeline()).toEqual(before);
    const request = { expectedRevision: selection.revision, idempotencyKey: "rewrite-scene-one", ops };
    const applied = await call<EditApplyResult>("edit.apply", request);
    expect(await call("edit.apply", request)).toMatchObject({ replayed: true, applied: applied.applied });
    const after = await timeline();
    expect(after.textOverlays).toEqual(before.textOverlays.filter(cue => cue.id !== guiCue.id));
    expect(after.subtitles).toMatchObject([{ text: "Revised cue", id: applied.applied[2]!.createdIds[0] }]);
    expect(after.tracks).toEqual(before.tracks);
    await call("history.control", { action: "undo", expectedRevision: after.revision, idempotencyKey: "undo-scene-one" });
    const undone = await timeline();
    expect(undone).toEqual({ ...before, revision: undone.revision });
    await call("history.control", { action: "redo", expectedRevision: undone.revision, idempotencyKey: "redo-scene-one" });
    const redone = await timeline();
    expect(redone).toEqual({ ...after, revision: redone.revision });
    await call("edit.apply", { expectedRevision: redone.revision, ops: [{ op: "track.update", trackId, locked: true }] });
    const locked = await timeline();
    const later = locked.textOverlays.find(clip => clip.text === "Later GUI cue")!;
    const denied = await agent.callCommand("edit.apply", { ...target, expectedRevision: locked.revision,
      ops: [{ ...removeGui, ids: [later.id] }] });
    expect(denied).toMatchObject({ ok: false, error: { code: "CONFLICT" } });
    expect(await timeline()).toEqual(locked);
  } finally {
    await agent?.close();
    await app.close();
  }
}, 120_000);
