import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { TemplateSummary } from "@openreel/core";
import { useEngineStore } from "../../../stores/engine-store";
import { TemplatesTab } from "./TemplatesTab";

const TEMPLATES: TemplateSummary[] = [
  {
    id: "tpl-youtube-intro",
    name: "YouTube Intro",
    category: "youtube",
    thumbnailUrl: null,
    placeholderCount: 2,
    duration: 10,
  },
  {
    id: "tpl-social-hook",
    name: "Social Hook",
    category: "social-media",
    thumbnailUrl: "https://example.com/thumb.png",
    placeholderCount: 1,
    duration: 15,
  },
];

function stubTemplateEngine() {
  return {
    initialize: async () => {},
    listTemplates: async () => TEMPLATES,
    loadTemplate: async () => null,
    applyTemplate: () => {
      throw new Error("not used in these tests");
    },
  };
}

describe("TemplatesTab", () => {
  const originalGetTemplateEngine =
    useEngineStore.getState().getTemplateEngine;

  beforeEach(() => {
    useEngineStore.setState({
      getTemplateEngine: async () =>
        stubTemplateEngine() as unknown as Awaited<
          ReturnType<typeof originalGetTemplateEngine>
        >,
    });
  });

  afterEach(() => {
    cleanup();
    useEngineStore.setState({ getTemplateEngine: originalGetTemplateEngine });
  });

  it("lays out template cards at content height so previews and labels stay inside the card", async () => {
    render(<TemplatesTab />);

    const card = await screen.findByRole("button", { name: "YouTube Intro" });
    // Regression guard: ToolcraftButton's md size forces `h-8` (32px); the
    // card must override it or the thumbnail/label overflow and overlap
    // neighboring cards and the banner above (narrow-window breakage).
    expect(card.className).toContain("h-auto");
    expect(card.className).not.toContain("h-8");
    expect(card.className).toContain("flex-col");

    const thumb = card.querySelector(".aspect-video");
    expect(thumb).not.toBeNull();
    expect(thumb!.className).toContain("w-full");

    const name = screen.getByText("YouTube Intro");
    expect(name.className).toContain("truncate");
    expect(screen.getByText("10s")).toBeInTheDocument();
  });

  it("renders thumbnail images without stretching the card grid", async () => {
    render(<TemplatesTab />);

    const card = await screen.findByRole("button", { name: "Social Hook" });
    const img = card.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe("https://example.com/thumb.png");
    expect(img!.className).toContain("object-cover");
  });

  it("keeps the Motion Creator banner and search controls visible above the cards", async () => {
    render(<TemplatesTab />);

    const banner = await screen.findByRole("button", {
      name: /Motion Creator/,
    });
    expect(banner).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("Search templates..."),
    ).toBeInTheDocument();

    await screen.findByRole("button", { name: "YouTube Intro" });
    const bannerRect = banner.compareDocumentPosition(
      screen.getByRole("button", { name: "YouTube Intro" }),
    );
    expect(bannerRect & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("filters templates by the search query", async () => {
    render(<TemplatesTab />);

    await screen.findByRole("button", { name: "YouTube Intro" });
    const search = screen.getByPlaceholderText("Search templates...");
    expect(search).toBeInTheDocument();

    // Narrow the list down to the social template.
    const { fireEvent } = await import("@testing-library/react");
    fireEvent.change(search, { target: { value: "social" } });

    await waitFor(() => {
      expect(
        screen.queryByRole("button", { name: "YouTube Intro" }),
      ).not.toBeInTheDocument();
    });
    expect(
      screen.getByRole("button", { name: "Social Hook" }),
    ).toBeInTheDocument();
  });
});
