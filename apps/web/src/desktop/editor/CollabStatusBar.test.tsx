import { fireEvent, render, screen, waitFor } from "@testing-library/react";
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

    expect(screen.getByText("Let an AI agent help you edit")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByText("Let an AI agent help you edit")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
  });

  it("does not show the intro bubble once it was seen", () => {
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<CollabStatusBar />);

    expect(screen.queryByText("Let an AI agent help you edit")).not.toBeInTheDocument();
  });

  it("opens the help popover from the intro and from the help button", () => {
    render(<CollabStatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "Learn more" }));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    expect(screen.queryByText("Let an AI agent help you edit")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByText("What is Agent Session?")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "About Agent Session" }));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();
  });

  it("portals the help popover to document.body and closes it on Escape, returning focus to the toggle", () => {
    render(<CollabStatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "About Agent Session" }));
    const popover = screen.getByRole("dialog", { name: "What is Agent Session?" });
    expect(popover.parentElement).toBe(document.body);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("What is Agent Session?")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "About Agent Session" })).toHaveFocus();
  });

  it("closes the help popover on an outside mousedown but not when clicked inside", () => {
    render(<CollabStatusBar />);

    fireEvent.click(screen.getByRole("button", { name: "About Agent Session" }));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();

    fireEvent.mouseDown(screen.getByText("What is Agent Session?"));
    expect(screen.getByText("What is Agent Session?")).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("What is Agent Session?")).not.toBeInTheDocument();
  });

  it("dismisses the intro bubble on Escape and on an outside mousedown", () => {
    const first = render(<CollabStatusBar />);
    expect(screen.getByText("Let an AI agent help you edit")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByText("Let an AI agent help you edit")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    first.unmount();

    window.localStorage.removeItem(INTRO_SEEN_KEY);
    const second = render(<CollabStatusBar />);
    expect(screen.getByText("Let an AI agent help you edit")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByText("Let an AI agent help you edit")).not.toBeInTheDocument();
    expect(window.localStorage.getItem(INTRO_SEEN_KEY)).toBe("1");
    second.unmount();
  });

  it("reveals the Agent workspace via the desktop bridge", () => {
    const openWorkspace = vi.fn(async () => "/videos/ReelTerminal Agent Workspace");
    // Partial bridge mock: only the surface this component can touch.
    openreelWindow.openreel = {
      platform: "desktop",
      collabControl: {
        enable: vi.fn(),
        disable: vi.fn(),
        setWorkMode: vi.fn(),
        setAccess: vi.fn(),
        getStatus: async () => ({
          enabled: false,
          externalConnected: false,
          writer: null,
          workMode: "collaborative",
          access: "write",
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

  it("shows Guided, Collaborative, and Autonomous and switches them while disabled", async () => {
    const setWorkMode = vi.fn(async (workMode: "guided" | "collaborative" | "autonomous") => ({
      enabled: false,
      externalConnected: false,
      writer: null,
      workMode,
      access: "write" as const,
      currentAction: null,
    }));
    openreelWindow.openreel = {
      platform: "desktop",
      collabControl: {
        enable: vi.fn(),
        disable: vi.fn(),
        setWorkMode,
        setAccess: vi.fn(),
        getStatus: async () => ({
          enabled: false,
          externalConnected: false,
          writer: null,
          workMode: "collaborative",
          access: "write",
          currentAction: null,
        }),
      },
    } as unknown as NonNullable<OpenReelWindow["openreel"]>;
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<CollabStatusBar />);

    expect(screen.getByRole("radio", { name: "Guided" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "Collaborative" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: "Autonomous" })).toBeEnabled();

    fireEvent.click(screen.getByRole("radio", { name: "Guided" }));
    await waitFor(() => expect(setWorkMode).toHaveBeenCalledWith("guided"));
  });

  it("offers an explicit recovery action for migrated read-only access", async () => {
    const setAccess = vi.fn(async () => ({
      sequence: 2,
      enabled: true,
      externalConnected: false,
      writer: null,
      workMode: "guided" as const,
      access: "write" as const,
      currentAction: null,
    }));
    openreelWindow.openreel = {
      platform: "desktop",
      collabControl: {
        enable: vi.fn(),
        disable: vi.fn(),
        setWorkMode: vi.fn(),
        setAccess,
        getStatus: async () => ({
          sequence: 1,
          enabled: true,
          externalConnected: false,
          writer: null,
          workMode: "guided",
          access: "read-only",
          currentAction: null,
        }),
        openWorkspace: vi.fn(),
      },
    } as unknown as NonNullable<OpenReelWindow["openreel"]>;
    window.localStorage.setItem(INTRO_SEEN_KEY, "1");
    render(<CollabStatusBar />);

    const restore = await screen.findByRole("button", { name: "Enable editing" });
    fireEvent.click(restore);

    await waitFor(() => expect(setAccess).toHaveBeenCalledWith("write"));
  });
});
