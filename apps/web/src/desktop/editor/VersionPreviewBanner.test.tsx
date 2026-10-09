/**
 * VersionPreviewBanner contract (docs/VERSION-NODES-UX.md 预览不会打断编辑):
 * visible only while the read-only preview is active, surfaces missing
 * dependencies, and wires 返回当前编辑 / 从这里继续编辑 to the session.
 */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionPreviewBanner } from "./VersionPreviewBanner";
import type { PreviewSessionState } from "../../services/preview-session";

type PreviewSessionStateImport = PreviewSessionState;

const { enter, exit, adopt, getState } = vi.hoisted(() => {
  const initial: PreviewSessionStateImport = {
    active: false,
    busy: false,
    info: null,
  };
  return {
    enter: vi.fn(() => Promise.resolve()),
    exit: vi.fn(() => Promise.resolve()),
    adopt: vi.fn(() => Promise.resolve()),
    // useSyncExternalStore needs a stable snapshot reference between updates.
    getState: vi.fn(() => initial),
  };
});

vi.mock("../../services/preview-session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/preview-session")>();
  return {
    ...actual,
    previewSession: {
      ...actual.previewSession,
      subscribe: actual.previewSession.subscribe,
      getSnapshot: getState,
      enter,
      exit,
      adopt,
    },
  };
});

let state: PreviewSessionState = { active: false, busy: false, info: null };

function setState(next: Partial<PreviewSessionState>): void {
  state = { ...state, ...next };
  getState.mockReturnValue(state);
}

describe("VersionPreviewBanner", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    setState({ active: false, busy: false, info: null });
  });

  it("renders nothing while no preview is active", () => {
    const { container } = render(<VersionPreviewBanner />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the previewed node name, adopt and return buttons", () => {
    setState({
      active: true,
      info: {
        projectId: "p1",
        nodeId: "n1",
        workspaceId: null,
        nodeName: "初剪",
        summary: "",
        createdAt: 1728451200000,
        missingDependencies: [],
        agentTrial: false,
      },
    });
    render(<VersionPreviewBanner />);

    expect(screen.getByTestId("version-preview-banner").textContent).toContain("初剪");
    expect(screen.getByTestId("version-preview-return")).toBeDefined();
    expect(screen.getByTestId("version-preview-adopt")).toBeDefined();
    expect(screen.queryByText(/dependencies are missing/i)).toBeNull();
  });

  it("surfaces missing dependencies with the list in the tooltip", () => {
    setState({
      active: true,
      info: {
        projectId: "p1",
        nodeId: "n1",
        workspaceId: null,
        nodeName: "初剪",
        summary: "",
        createdAt: null,
        missingDependencies: ["media-1", "media-2"],
        agentTrial: false,
      },
    });
    render(<VersionPreviewBanner />);

    const banner = screen.getByTestId("version-preview-banner");
    // Count notice inline, dependency names in the tooltip (title attr).
    expect(banner.textContent).toContain("2 dependencies are missing");
    const tooltip = banner.querySelector("[title]")?.getAttribute("title") ?? "";
    expect(tooltip).toContain("media-1");
    expect(tooltip).toContain("media-2");
  });

  it("return exits the preview and adopt starts adoption", async () => {
    setState({
      active: true,
      info: {
        projectId: "p1",
        nodeId: "n1",
        workspaceId: null,
        nodeName: "初剪",
        summary: "",
        createdAt: null,
        missingDependencies: [],
        agentTrial: false,
      },
    });
    render(<VersionPreviewBanner />);

    screen.getByTestId("version-preview-return").click();
    await waitFor(() => expect(exit).toHaveBeenCalledTimes(1));

    screen.getByTestId("version-preview-adopt").click();
    await waitFor(() => expect(adopt).toHaveBeenCalledTimes(1));
    expect(enter).not.toHaveBeenCalled();
  });

  it("disables the actions while the session is busy", () => {
    setState({
      active: true,
      busy: true,
      info: {
        projectId: "p1",
        nodeId: null,
        workspaceId: "w1",
        nodeName: "试剪",
        summary: "",
        createdAt: null,
        missingDependencies: [],
        agentTrial: true,
      },
    });
    render(<VersionPreviewBanner />);

    const adoptButton = screen.getByTestId("version-preview-adopt") as HTMLButtonElement;
    const returnButton = screen.getByTestId("version-preview-return") as HTMLButtonElement;
    expect(adoptButton.disabled).toBe(true);
    expect(returnButton.disabled).toBe(true);
    adoptButton.click();
    returnButton.click();
    expect(adopt).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
