import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  TaskDecision,
  TaskDecisionStatus,
  TaskIssue,
  TaskReviewSnapshot,
  TaskTextReviewUnit,
} from "../../../../../desktop/src/shared/task-review";
import { StageUnitCard } from "./stage-unit-card";
import { emptySnapshot } from "./testing";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const unit: TaskTextReviewUnit = {
  id: "unit-1",
  sourceVersionId: "source-1",
  ordinal: 3,
  text: "原始台词内容，包含证据片段。",
  startLine: 3,
  endLine: 3,
  startMs: 125000,
  endMs: 126000,
};

const issue: TaskIssue = {
  id: "issue-1",
  unitId: unit.id,
  sourceVersionId: unit.sourceVersionId,
  policyRevision: 1,
  severity: "high",
  title: "称谓与前文不一致",
  evidence: "证据片段",
  hypothesis: "可能是误译",
  options: [],
};

interface Options {
  purpose?: string;
  busy?: boolean;
  stale?: boolean;
  focused?: boolean;
  compareMode?: boolean;
  analysisKnown?: boolean;
  decisions?: TaskReviewSnapshot["decisions"];
  decisionActions?: TaskReviewSnapshot["decisionActions"];
  issues?: TaskIssue[];
  onFocus?: () => void;
  onDecide?: (status: TaskDecisionStatus) => void;
  onCopyText?: (text: string) => void;
}

function buildSnapshot({
  decisions = [],
  decisionActions = [],
  issues = [],
}: Options): TaskReviewSnapshot {
  const snapshot = emptySnapshot("task-root");
  snapshot.policyRevision = 1;
  snapshot.sources.push({
    id: "source-1",
    entryId: "entry-1",
    relativePath: "剧本.txt",
    hash: "hash-1",
    format: "txt",
    text: unit.text,
    createdAt: 1,
  });
  snapshot.sourceFiles.push({
    entryId: "entry-1",
    relativePath: "剧本.txt",
    size: unit.text.length,
    mtimeMs: 1,
    currentVersionId: "source-1",
    status: "available",
  });
  snapshot.units.push(unit);
  snapshot.decisions = decisions;
  snapshot.decisionActions = decisionActions;
  snapshot.issues = issues;
  return snapshot;
}

function reworkDecision(replacementText: string): TaskDecision[] {
  const base: TaskDecision = {
    id: "decision-1",
    unitId: unit.id,
    sourceVersionId: unit.sourceVersionId,
    policyRevision: 1,
    purpose: "review",
    status: "rework",
    note: "",
    createdAt: 1,
  };
  return [replacementText !== "" ? { ...base, replacementText } : base];
}

function renderCard(options: Options = {}) {
  const {
    purpose = "review",
    busy = false,
    stale = false,
    focused = false,
    compareMode = false,
    analysisKnown = true,
    decisions = [],
    decisionActions = [],
    issues = [],
    onFocus = vi.fn(),
    onDecide = vi.fn(),
    onCopyText = vi.fn(),
  } = options;
  render(
    <StageUnitCard
      snapshot={buildSnapshot({ decisions, decisionActions, issues })}
      unit={unit}
      purpose={purpose}
      busy={busy}
      stale={stale}
      focused={focused}
      compareMode={compareMode}
      analysisKnown={analysisKnown}
      onFocus={onFocus}
      onCopyText={onCopyText}
      onDecide={onDecide}
    />,
  );
  return { onFocus, onDecide, onCopyText };
}

describe("stage unit card", () => {
  it("renders the ordinal, original text and source title", () => {
    renderCard();
    expect(screen.getByTestId("task-review-scene-target")).toHaveAttribute(
      "data-unit-id",
      unit.id,
    );
    expect(screen.getByTestId("task-review-unit-title").textContent).toBe("#3");
    expect(screen.getByTestId("task-review-unit-text").textContent).toBe(unit.text);
    // The metadata row shows the source file name with the full path as title.
    const sourceTitle = screen.getByText("剧本.txt");
    expect(sourceTitle).toHaveAttribute("title", "task-root/剧本.txt");
    // startMs 125000 formats as 02:05.
    expect(screen.getByTestId("task-review-scene-target")).toHaveTextContent("02:05");
  });

  it("highlights the first issue's evidence inside the original text", () => {
    renderCard({ issues: [issue] });
    const blockquote = screen.getByTestId("task-review-unit-text");
    const highlighted = blockquote.querySelector(".bg-rose-500\\/25") as HTMLElement;
    expect(highlighted).not.toBeNull();
    expect(highlighted.textContent).toBe(issue.evidence);
    // The one-line issue callout shows the first issue title only.
    expect(screen.getByTestId("task-review-issue-brief").textContent).toBe(issue.title);
  });

  it("decides in place through the pills and disables them while busy", () => {
    const { onDecide } = renderCard();
    fireEvent.click(screen.getByTestId("task-review-decide-rework"));
    expect(onDecide).toHaveBeenCalledTimes(1);
    expect(onDecide).toHaveBeenCalledWith("rework");
  });

  it("disables the decision pills while busy", () => {
    renderCard({ busy: true });
    for (const status of ["kept", "rework", "discarded"]) {
      expect(
        (screen.getByTestId(`task-review-decide-${status}`) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
    }
  });

  it("shows the rework preview bar when a rework decision carries replacement text", () => {
    renderCard({
      decisions: reworkDecision("改稿后的台词"),
      decisionActions: [
        { id: "action-1", kind: "decide", decisionId: "decision-1", createdAt: 1 },
      ],
    });
    const preview = screen.getByTestId("task-review-rework-preview");
    expect(preview.textContent).toContain("改稿后的台词");
    // The rework pill is the active one and carries the amber active style.
    expect(
      screen.getByTestId("task-review-decide-rework").className,
    ).toContain("bg-amber-400");
  });

  it("moves the focus to the card when the card body is clicked in compare mode", () => {
    const { onFocus } = renderCard({ compareMode: true });
    fireEvent.click(screen.getByTestId("task-review-scene-target"));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });

  it("ignores card body clicks outside compare mode", () => {
    const { onFocus } = renderCard();
    fireEvent.click(screen.getByTestId("task-review-scene-target"));
    expect(onFocus).not.toHaveBeenCalled();
  });
});
