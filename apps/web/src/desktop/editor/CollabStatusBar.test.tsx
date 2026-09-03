import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CollabStatusBar } from "./CollabStatusBar";

const INTRO_SEEN_KEY = "reelterminal.agentSessionIntroSeen";

type OpenReelWindow = Window & { openreel?: Record<string, unknown> };
const openreelWindow = window as OpenReelWindow;

describe("CollabStatusBar Agent Session onboarding", () => {
  beforeEach(() => {
    window.localStorage.clear();
    delete openreelWindow.openreel;
  });

  afterEach(() => {
    window.localStorage.clear();
    delete openreelWindow.openreel;
  });

  it("shows the first-run intro bubble until dismissed, then remembers", () => {
    render(<CollabStatusBar />);

    expect(screen.getByText("Let an AI assistant help you edit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("Let an AI assistant help you edit")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
  });

  it("does not show the intro bubble once it was seen", () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<CollabStatusBar />);

    expect(screen.queryByText("Let an AI assistant help you edit")).not.toBeInTheDocument();
  });

  it("opens the help popover from the intro and from the help button", () => {
    render(<CollabStatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    expect(screen.queryByText("Let an AI assistant help you edit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("What is Agent Session?")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About Agent Session" }));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();
  });

  it("reveals the Agent workspace via the desktop bridge", () => {
    const openWorkspace = vi.fn(async () => "/videos/ReelTerminal Agent Workspace");
    // Partial bridge mock: only the surface this component can touch.
    openreelWindow.openreel = {
      platform: "desktop",
      collabControl: {
        enable: vi.fn(),
        disable: vi.fn(),
        setMode: vi.fn(),
        getStatus: async () => ({
          enabled: false,
          externalConnected: false,
          writer: null,
          mode: "assist",
          currentAction: null,
        }),
        openWorkspace,
      },
    } as unknown as NonNullable<OpenReelWindow["openreel"]>;
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<CollabStatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "About Agent Session" }));
    fireEvent.click(screen.getByRole("button", { name: /Open Agent Workspace/ }));

    expect(openWorkspace).toHaveBeenCalledTimes(1);
  });
});
