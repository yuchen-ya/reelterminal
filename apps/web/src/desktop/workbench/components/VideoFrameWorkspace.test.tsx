import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkbenchItemView } from "../types";
import { VideoFrameWorkspace } from "./VideoFrameWorkspace";

vi.mock("../../../stores/project-store", () => ({ useProjectStore: vi.fn() }));

beforeEach(() => { vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {}); });
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function video(id: string, url: string | null = null): WorkbenchItemView {
  return { id, batchId: "batch", orderIndex: 0, title: id, subtitle: "", type: "video", version: 1,
    status: "pending", hasManualRevision: false, provenanceTags: [], userCategoryTags: [], feedbacks: [],
    videoPayload: { media: { mediaId: id, url, status: url ? "ready" : "loading", thumbnailUrl: null, displayName: id }, markers: [] } };
}

it("releases comparison media on reference changes, closing comparison and repeated unmounts", async () => {
  const releases: Array<ReturnType<typeof vi.fn>> = [];
  const openMediaUrl = vi.fn(async (id: string) => {
    const release = vi.fn();
    releases.push(release);
    return { url: `blob:${id}`, release };
  });
  const item = { ...video("current", "blob:current"), compareWithItemId: "reference" };
  const items = [item, video("reference"), video("other")];
  const props = { item, batchVideoItems: items, openMediaUrl, issuePanelWidth: 280,
    onUpdateVideoMarkers: vi.fn(async () => ({ ok: true as const })) };
  const ui = render(<VideoFrameWorkspace {...props} />);
  const referenceVideo = () => screen.getByTestId("video-compare-reference-pane").querySelector("video");
  await waitFor(() => expect(referenceVideo()).toHaveAttribute("src", "blob:reference"));
  // Parent refreshes replace item views; an unchanged media identity keeps its handle.
  ui.rerender(<VideoFrameWorkspace {...props} batchVideoItems={items.map(entry => ({ ...entry }))} />);
  expect(openMediaUrl).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByTestId("video-compare-select"), { target: { value: "other" } });
  await waitFor(() => expect(referenceVideo()).toHaveAttribute("src", "blob:other"));
  expect(releases[0]).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByTestId("video-compare-toggle"));
  expect(releases[1]).toHaveBeenCalledTimes(1);
  ui.unmount();
  for (let cycle = 0; cycle < 5; cycle++) {
    const next = render(<VideoFrameWorkspace {...props} />);
    await waitFor(() => expect(referenceVideo()).toHaveAttribute("src", "blob:reference"));
    next.unmount();
  }
  expect(releases).toHaveLength(7);
  for (const release of releases) expect(release).toHaveBeenCalledTimes(1);
});

it("releases a comparison handle that arrives after unmount", async () => {
  const release = vi.fn();
  let resolve!: (handle: { url: string; release: () => void }) => void;
  const pending = new Promise<{ url: string; release: () => void }>(done => { resolve = done; });
  const openMediaUrl = vi.fn(() => pending);
  const item = { ...video("current", "blob:current"), compareWithItemId: "reference" };
  const ui = render(<VideoFrameWorkspace item={item} batchVideoItems={[item, video("reference")]}
    openMediaUrl={openMediaUrl} issuePanelWidth={280} onUpdateVideoMarkers={async () => ({ ok: true })} />);
  await waitFor(() => expect(openMediaUrl).toHaveBeenCalledWith("reference"));
  ui.unmount();
  await act(async () => { resolve({ url: "blob:late-reference", release }); await pending; });
  expect(release).toHaveBeenCalledTimes(1);
});

it("seeks to a selected issue after video metadata arrives", async () => {
  const base = video("current", "blob:current");
  const item: WorkbenchItemView = { ...base, videoPayload: { ...base.videoPayload!, markers: [{ id:"marker", type:"frame", startPtsSec:2.65, note:"Issue", version:1, annotations:[] }] } };
  render(<VideoFrameWorkspace item={item} batchVideoItems={[item]} issuePanelWidth={280}
    onUpdateVideoMarkers={async () => ({ ok:true })} />);
  const player = document.querySelector("[data-workbench-player='true'] video") as HTMLVideoElement;
  expect(player).not.toBeNull();
  Object.defineProperty(player, "duration", { configurable:true, value:10 });
  fireEvent.click(screen.getByTestId("workbench-issue-card"));
  expect(player.currentTime).toBe(0);
  fireEvent.loadedMetadata(player);
  await waitFor(() => expect(player.currentTime).toBeCloseTo(2.65, 2));
});
