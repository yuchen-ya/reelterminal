import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { changeAppLanguage } from "../../../i18n";
import { TourPopover } from "./TourPopover";
import { TOUR_STEPS } from "./tour-steps";

vi.mock("framer-motion", async () => {
  const React = await import("react");
  const createMotionElement = (tag: "div" | "h2" | "p") =>
    ({
      children,
      initial: _initial,
      animate: _animate,
      exit: _exit,
      transition: _transition,
      ...props
    }: {
      children?: React.ReactNode;
      initial?: unknown;
      animate?: unknown;
      exit?: unknown;
      transition?: unknown;
      [key: string]: unknown;
    }) => React.createElement(tag, props, children);
  return {
    motion: {
      div: createMotionElement("div"),
      h2: createMotionElement("h2"),
      p: createMotionElement("p"),
    },
  };
});

function renderWelcomeStep(): void {
  render(
    <TourPopover
      step={TOUR_STEPS[0]}
      targetRect={null}
      currentStep={0}
      totalSteps={TOUR_STEPS.length}
      isFirstStep
      isLastStep={false}
      onNext={vi.fn()}
      onPrev={vi.fn()}
      onSkip={vi.fn()}
      onGoToStep={vi.fn()}
    />,
  );
}

describe("TourPopover localization", () => {
  beforeEach(async () => {
    await act(async () => {
      await changeAppLanguage("en");
    });
  });

  afterEach(async () => {
    await act(async () => {
      await changeAppLanguage("en");
    });
  });

  it("keeps the first-run welcome copy in English", () => {
    renderWelcomeStep();

    expect(screen.getByText("Welcome to ReelTerminal")).toBeInTheDocument();
    expect(screen.getByText(/A quick map of the current editor layout/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Next" })).toBeInTheDocument();
  });

  it("renders the first-run welcome copy in Simplified Chinese", async () => {
    await act(async () => {
      await changeAppLanguage("zh-CN");
    });
    renderWelcomeStep();

    expect(screen.getByText("欢迎使用 ReelTerminal")).toBeInTheDocument();
    expect(screen.getByText(/快速了解当前编辑器布局/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "下一步" })).toBeInTheDocument();
    expect(screen.queryByText("Welcome to ReelTerminal")).not.toBeInTheDocument();
  });
});
