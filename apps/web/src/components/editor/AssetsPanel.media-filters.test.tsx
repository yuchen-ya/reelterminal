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

it("keeps sorting visible and combines duration, name and import order with type filters", () => {
  const project = useProjectStore.getState().project;
  const long = { ...item("take10", "audio"), metadata: { ...item("take10", "audio").metadata, duration: 12 } };
  const short = item("take2", "audio");
  const picture = item("still", "image");
  useProjectStore.setState({ project: { ...project, mediaLibrary: { ...project.mediaLibrary, items: [long, short, picture] } } });
  const { container } = render(<AssetsPanel />);
  const order = () => [...container.querySelectorAll("[data-live-media-id]")].map(element => element.getAttribute("data-live-media-id"));
  const sorting = screen.getByRole("combobox", { name: "Sort media" });
  expect(order()).toEqual(["still", "take2", "take10"]);
  fireEvent.change(sorting, { target: { value: "shortest" } });
  expect(order()).toEqual(["take2", "take10", "still"]);
  fireEvent.change(sorting, { target: { value: "longest" } });
  expect(order()).toEqual(["take10", "take2", "still"]);
  chooseType("Audio");
  expect(sorting).toHaveValue("longest");
  expect(order()).toEqual(["take10", "take2"]);
  fireEvent.change(sorting, { target: { value: "nameAsc" } });
  expect(order()).toEqual(["take2", "take10"]);
  fireEvent.change(sorting, { target: { value: "oldest" } });
  expect(order()).toEqual(["take10", "take2"]);
  expect(screen.queryByRole("group", { name: "Asset categories" })).not.toBeInTheDocument();
});

it("opens the archive tree on demand and lets a media selection find its related save point", async () => {
  const current = useProjectStore.getState().project;
  const node: ProjectNodeRecord = { id: "linked-node", projectId: current.id, parentNodeId: null, name: "Audio cut", summary: "", createdAt: 1, formatVersion: 1,
    mediaIds: ["voice"], missingDependencies: [], project: current };
  vi.spyOn(workspaceManager, "getSnapshot").mockReturnValue({ ...workspaceManager.getSnapshot(), nodes: [node] });
  vi.spyOn(workspaceManager, "getNode").mockResolvedValue(node);
  const { container } = render(<AssetsPanel />);
  expect(screen.queryByRole("group", { name: "Project save points" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "By save point" }));
  fireEvent.click(screen.getByTestId("asset-node-linked-node"));
  await screen.findByTestId("node-assets");
  expect(screen.queryByRole("group", { name: "Project save points" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Clear save-point filter" }));
  fireEvent.click(container.querySelector('[data-live-media-id="voice"]')!);
  const relations = screen.getByTestId("media-node-relations");
  fireEvent.click(within(relations).getByRole("button", { name: "Audio cut ↗" }));
  await screen.findByTestId("node-assets");
  expect(useProjectStore.getState().project).toBe(current);
});

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
  fireEvent.click(screen.getByRole("button", { name: "Clear save-point filter" }));
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
