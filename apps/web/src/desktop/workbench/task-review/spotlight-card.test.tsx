import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { Layers, Sparkles } from "lucide-react";
import { SpotlightCard } from "./spotlight-card";
import type {
  SpotlightCardFace,
  SpotlightLauncherItem,
  SpotlightPrimaryAction,
  SpotlightStepDot,
} from "./spotlight-card";

beforeEach(() => {
  // jsdom 24 has no PointerEvent constructor; RTL's fireEvent.pointer* would
  // drop clientX/clientY without a stub (same trick as MediaScene.test.tsx).
  vi.stubGlobal("PointerEvent", MouseEvent);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** 头部拖拽依赖 setPointerCapture / releasePointerCapture（jsdom 未实现）。 */
function enablePointerCapture(element: HTMLElement) {
  Object.assign(element, {
    setPointerCapture: vi.fn(),
    releasePointerCapture: vi.fn(),
  });
}

/** 头部 div（data-testid 在卡片根上，头部是其第一个子 div）。 */
function headerOf(): HTMLElement {
  return screen.getByTestId("agent-spotlight-card").firstElementChild as HTMLElement;
}

const launcherItems: SpotlightLauncherItem[] = [
  {
    id: "stage",
    label: "主舞台",
    tip: "回到当前聚光灯审阅场景",
    icon: Sparkles,
    active: true,
    testId: "spotlight-item-stage",
    onClick: vi.fn(),
  },
  {
    id: "overview",
    label: "总览",
    tip: "打开全局审查列表",
    icon: Layers,
    testId: "spotlight-item-overview",
    onClick: vi.fn(),
  },
];

const stepDots: SpotlightStepDot[] = [
  { id: "s1", title: "场景 1", detail: "点击跳转到此场景", active: true, done: false, onClick: vi.fn() },
  { id: "s2", title: "场景 2", active: false, done: true, onClick: vi.fn() },
  { id: "s3", title: "场景 3", active: false, done: false, onClick: vi.fn() },
];

const primaryAction: SpotlightPrimaryAction = {
  label: "保留并继续",
  tipTitle: "将 #2 设为「保留」并进入下一场景",
  tipDetail: "一步完成「确认保留 + 推进到下一项」",
  testId: "spotlight-cta",
  onClick: vi.fn(),
};

interface Options {
  face?: SpotlightCardFace;
  launcherItems?: SpotlightLauncherItem[];
  toolBody?: ReactNode;
  showCompletionToggle?: boolean;
  completionActive?: boolean;
  spotlightActive?: boolean;
  canBack?: boolean;
  footerStatus?: ReactNode;
  stepDots?: SpotlightStepDot[];
  primaryAction?: SpotlightPrimaryAction | null;
}

function renderCard(options: Options = {}) {
  const {
    face = "tool",
    launcherItems = [],
    toolBody = null,
    showCompletionToggle = false,
    completionActive = false,
    spotlightActive = false,
    canBack = true,
    footerStatus = null,
    stepDots = [],
    primaryAction = null,
  } = options;
  const onFlipFace = vi.fn();
  const onToggleCompletion = vi.fn();
  const onToggleSpotlight = vi.fn();
  const onBack = vi.fn();
  render(
    <SpotlightCard
      headerTitle="#2 林深"
      face={face}
      onFlipFace={onFlipFace}
      launcherItems={launcherItems}
      toolBody={toolBody}
      showCompletionToggle={showCompletionToggle}
      completionActive={completionActive}
      onToggleCompletion={onToggleCompletion}
      spotlightActive={spotlightActive}
      onToggleSpotlight={onToggleSpotlight}
      onBack={onBack}
      canBack={canBack}
      footerStatus={footerStatus}
      stepDots={stepDots}
      primaryAction={primaryAction}
    />,
  );
  return { onFlipFace, onToggleCompletion, onToggleSpotlight, onBack };
}

describe("spotlight card", () => {
  it("flips the face through the single header button", () => {
    const { onFlipFace } = renderCard({ face: "tool" });
    fireEvent.click(screen.getByTestId("spotlight-flip-btn"));
    expect(onFlipFace).toHaveBeenCalledTimes(1);
    expect(onFlipFace).toHaveBeenCalledWith("launcher");

    cleanup();
    const back = renderCard({ face: "launcher" });
    fireEvent.click(screen.getByTestId("spotlight-flip-btn"));
    expect(back.onFlipFace).toHaveBeenCalledTimes(1);
    expect(back.onFlipFace).toHaveBeenCalledWith("tool");
  });

  it("renders launcher items and forwards clicks and testids", () => {
    renderCard({ face: "launcher", launcherItems });
    expect(screen.getByText("主舞台")).toBeTruthy();
    expect(screen.getByText("总览")).toBeTruthy();
    const stage = screen.getByTestId("spotlight-item-stage");
    const overview = screen.getByTestId("spotlight-item-overview");
    fireEvent.click(overview);
    expect(launcherItems[1].onClick).toHaveBeenCalledTimes(1);
    expect(launcherItems[0].onClick).not.toHaveBeenCalled();
    // active item carries the accent surface classes.
    expect(stage.className).toContain("bg-accent/15");
    expect(overview.className).toContain("bg-[#101216]");
  });

  it("invokes the primary CTA and shows Check only in doneState", () => {
    renderCard({ primaryAction });
    const cta = screen.getByTestId("spotlight-cta");
    fireEvent.click(cta);
    expect(primaryAction.onClick).toHaveBeenCalledTimes(1);
    // CTA is the single accent-green button and is not done by default.
    expect(cta.className).toContain("bg-accent");
    expect(cta.querySelector("svg.lucide-check")).toBeNull();

    cleanup();
    renderCard({
      primaryAction: { ...primaryAction, doneState: true, label: "下一场景" },
    });
    expect(screen.getByTestId("spotlight-cta").querySelector("svg.lucide-check")).not.toBeNull();

    cleanup();
    renderCard({ primaryAction: null });
    expect(screen.queryByTestId("spotlight-cta")).toBeNull();
  });

  it("drags from the header into a fixed position, then docks back via reset", () => {
    renderCard({ primaryAction });
    const card = screen.getByTestId("agent-spotlight-card");
    const header = headerOf();
    enablePointerCapture(header);
    // jsdom reports a 0x0 box, so seed a deterministic docked origin.
    vi.spyOn(card, "getBoundingClientRect").mockReturnValue({
      left: 100, top: 60, width: 0, height: 0, right: 100, bottom: 60, x: 100, y: 60, toJSON: () => ({}),
    });

    // Docked: not fixed, no reset button.
    expect(card.style.position).toBeFalsy();
    expect(screen.queryByTestId("spotlight-card-reset")).toBeNull();

    fireEvent.pointerDown(header, { clientX: 100, clientY: 60, button: 0 });
    // A pure pointerdown (no movement) already lifts the card to fixed.
    expect(card.style.position).toBe("fixed");
    expect(screen.getByTestId("spotlight-card-reset")).toBeTruthy();

    fireEvent.pointerMove(header, { clientX: 160, clientY: 120 });
    expect(card.style.left).toBe("160px");
    expect(card.style.top).toBe("120px");

    fireEvent.pointerUp(header, { button: 0 });

    // Reset docks the card again.
    fireEvent.click(screen.getByTestId("spotlight-card-reset"));
    expect(card.style.position).toBeFalsy();
    expect(card.style.left).toBe("");
    expect(card.style.top).toBe("");
    expect(screen.queryByTestId("spotlight-card-reset")).toBeNull();
  });

  it("does not start a drag when the pointer lands on a button in the header", () => {
    renderCard({ primaryAction });
    const card = screen.getByTestId("agent-spotlight-card");
    const header = headerOf();
    enablePointerCapture(header);
    const flip = screen.getByTestId("spotlight-flip-btn");
    fireEvent.pointerDown(flip, { clientX: 300, clientY: 60, button: 0 });
    // The closest() guard ignores button targets, so the card stays docked.
    expect(card.style.position).toBeFalsy();
    expect(screen.queryByTestId("spotlight-card-reset")).toBeNull();
    // The button still works normally.
    fireEvent.click(flip);
  });

  it("renders footer status and step dots and forwards dot clicks", () => {
    renderCard({ footerStatus: <span>状态-宿主注入</span>, stepDots });
    expect(screen.getByText("状态-宿主注入")).toBeTruthy();
    const s1 = screen.getByTestId("spotlight-step-dot-s1");
    const s2 = screen.getByTestId("spotlight-step-dot-s2");
    const s3 = screen.getByTestId("spotlight-step-dot-s3");
    // active → w-3 + bg-accent, done → bg-accent/40, else → bg-white/20.
    expect(s1.className).toContain("w-3");
    expect(s1.className).toContain("bg-accent");
    expect(s2.className).toContain("bg-accent/40");
    expect(s3.className).toContain("bg-white/20");
    fireEvent.click(s1);
    fireEvent.click(s2);
    expect(stepDots[0].onClick).toHaveBeenCalledTimes(1);
    expect(stepDots[1].onClick).toHaveBeenCalledTimes(1);
    expect(stepDots[2].onClick).not.toHaveBeenCalled();
  });

  it("disables the back arrow when canBack is false", () => {
    const { onBack } = renderCard({ canBack: false });
    const back = screen.getByTestId("spotlight-back-btn") as HTMLButtonElement;
    expect(back.disabled).toBe(true);
    fireEvent.click(back);
    expect(onBack).not.toHaveBeenCalled();

    cleanup();
    const allowed = renderCard({ canBack: true });
    fireEvent.click(screen.getByTestId("spotlight-back-btn"));
    expect(allowed.onBack).toHaveBeenCalledTimes(1);
  });
});
