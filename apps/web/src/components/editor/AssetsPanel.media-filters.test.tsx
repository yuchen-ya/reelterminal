import "../../test/install-local-storage-mock";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MediaItem } from "@reelterminal/core";
import { useProjectStore } from "../../stores/project-store";
import { useEngineStore } from "../../stores/engine-store";
import { useNotificationStore } from "../../stores/notification-store";
import { workspaceManager, type ProjectNodeRecord } from "../../services/workspace-manager";
import { AssetsPanel } from "./AssetsPanel";

function item(id: string, type: MediaItem["type"]): MediaItem {
  return { id, name: `${id}.${type === "audio" ? "wav" : "mp4"}`, type, blob: null, fileHandle: null, thumbnailUrl: null, waveformData: null,
    metadata: { duration: 4, width: 320, height: 180, frameRate: 30, sampleRate: 48000, channels: 2, codec: "test", fileSize: 1 } };
}

beforeEach(() => {
  useProjectStore.getState().createNewProject();
  useEngineStore.getState().getTitleEngine()?.loadTextClips([]);
  useNotificationStore.getState().clearAll();
  const project = useProjectStore.getState().project;
  useProjectStore.setState({ project: { ...project, mediaLibrary: { ...project.mediaLibrary, items: [item("picture", "video"), item("voice", "audio")] } } });
});

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function chooseType(name: string) {
  fireEvent.click(within(screen.getByRole("group", { name: "Media type" })).getByRole("button", { name }));
}

it("filters audio independently and distinguishes no matches from an empty project", () => {
  const { container } = render(<AssetsPanel />);
  chooseType("Audio");
  expect(container.querySelector('[data-live-media-id="voice"]')).not.toBeNull();
  expect(container.querySelector('[data-live-media-id="picture"]')).toBeNull();
  chooseType("Images");
  expect(screen.getByText("No matches. Adjust the type, scope or search.")).toBeInTheDocument();
  expect(screen.queryByText("No media imported")).not.toBeInTheDocument();
});

it("shows historical-only media without activating or changing the current project", async () => {
  const current = useProjectStore.getState().project;
  const node: ProjectNodeRecord = { id: "node-old", projectId: current.id, parentNodeId: null, name: "First cut", summary: "", createdAt: 1, formatVersion: 1,
    mediaIds: ["old-voice"], missingDependencies: [], project: { ...current, mediaLibrary: { ...current.mediaLibrary, items: [item("old-voice", "audio")] } } };
  vi.spyOn(workspaceManager, "getSnapshot").mockReturnValue({ ...workspaceManager.getSnapshot(), nodes: [node] });
  const readNode = vi.spyOn(workspaceManager, "getNode").mockResolvedValue(node);
  render(<AssetsPanel />);
  act(() => window.dispatchEvent(new CustomEvent("reelterminal:node-assets", { detail: { projectId: current.id, nodeId: node.id } })));
  chooseType("Audio");
  await screen.findByText("old-voice.wav");
  expect(readNode).toHaveBeenCalledTimes(1);
  expect(within(screen.getByTestId("node-assets")).queryByRole("button", { name: /delete/i })).not.toBeInTheDocument();
  expect(useProjectStore.getState().project).toBe(current);
  fireEvent.click(screen.getByRole("checkbox", { name: "Used in timeline only" }));
  expect(screen.queryByText("old-voice.wav")).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox", { name: "View scope" }), { target: { value: "" } });
  expect(screen.queryByText("old-voice.wav")).not.toBeInTheDocument();
});

it.each([
  ["captions.SRT", "\uFEFF1\r\n00:00:01,000 --> 00:00:03,000\r\n第一句\r\n\r\n2\r\n00:00:03,000 --> 00:00:05,000\r\nSecond line"],
  ["captions.vtt", "WEBVTT\n\n00:01.000 --> 00:03.000\n第一句\n\n00:03.000 --> 00:05.000\nSecond line"],
])("imports %s through the media picker as one undoable subtitle operation", async (name, content) => {
  const { container } = render(<AssetsPanel />);
  const input = container.querySelector<HTMLInputElement>('input[type="file"][accept*=".srt"]')!;
  expect(input).not.toBeNull();
  fireEvent.change(input, { target: { files: [{ name, text: async () => content }] } });
  await waitFor(() => expect(useProjectStore.getState().getAllTextClips()).toHaveLength(2));
  expect(await screen.findByTestId("project-subtitles")).toHaveTextContent("第一句");
  await act(async () => { await useProjectStore.getState().undo(); });
  expect(useProjectStore.getState().getAllTextClips()).toHaveLength(0);
});

it("does not add subtitles to another project when a file read finishes late", async () => {
  let resolveRead!: (content: string) => void;
  const { container } = render(<AssetsPanel />);
  fireEvent.change(container.querySelector('input[type="file"][accept*=".srt"]')!, { target: { files: [{ name: "late.srt", text: () => new Promise<string>(resolve => { resolveRead = resolve; }) }] } });
  act(() => { useProjectStore.getState().createNewProject(); });
  await act(async () => { resolveRead("1\n00:00:00,000 --> 00:00:01,000\nWrong project"); });
  expect(useProjectStore.getState().getAllTextClips()).toHaveLength(0);
  expect(useNotificationStore.getState().notifications.some(notification => notification.type === "error")).toBe(true);
});

it("reports malformed subtitles without changing the timeline", async () => {
  const before = useProjectStore.getState().project;
  const { container } = render(<AssetsPanel />);
  fireEvent.change(container.querySelector('input[type="file"][accept*=".srt"]')!, { target: { files: [{ name: "invalid.srt", text: async () => "This has no timecodes" }] } });
  await waitFor(() => expect(useNotificationStore.getState().notifications.some(notification => notification.type === "error")).toBe(true));
  expect(useProjectStore.getState().project).toBe(before);
});

it("keeps dropped subtitle files after the browser clears the drag data", async () => {
  vi.stubGlobal("DataTransferItem", class {});
  const { container } = render(<AssetsPanel />);
  const files = [{ name: "dropped.srt", text: async () => "1\n00:00:00,000 --> 00:00:01,000\nDropped caption" }];
  fireEvent.drop(container.querySelector(".asset-browser-content > div")!, { dataTransfer: { files, items: [] } });
  files.length = 0;
  await waitFor(() => expect(useProjectStore.getState().getAllTextClips()).toHaveLength(1));
  expect(await screen.findByTestId("project-subtitles")).toHaveTextContent("Dropped caption");
});
