import { useChineseReviewLocale } from "../../../test/review-locale";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TaskAgentBridge } from "../../../../../desktop/src/shared/task-review-runtime-types";
import { AgentPanel } from "./AgentPanel";
import { emptySnapshot, fakeJob } from "./testing";
import { preflightCoverage } from "./useTaskAgentState";
import type { TaskAgentRuntime } from "./useTaskAgentState";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const snapshot = (units: string[]) => ({
  ...emptySnapshot(),
  policyRevision: 1,
  sources: [
    {
      id: "source-1",
      entryId: "entry-1",
      relativePath: "lines.txt",
      hash: "h",
      format: "txt" as const,
      text: "t",
      createdAt: 1,
    },
  ],
  sourceFiles: [
    {
      entryId: "entry-1",
      relativePath: "lines.txt",
      size: 1,
      mtimeMs: 1,
      currentVersionId: "source-1",
      status: "available" as const,
    },
  ],
  units: units.map((id, index) => ({
    id,
    sourceVersionId: "source-1",
    ordinal: index + 1,
    text: `line ${index + 1}`,
    startLine: index + 1,
    endLine: index + 1,
  })),
});

function runtimeOf(state: TaskAgentRuntime["state"]) {
  return {
    state,
    error: null,
    refresh: vi.fn(),
    authorize: vi.fn().mockResolvedValue(undefined),
    revoke: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    retryJob: vi.fn().mockResolvedValue(undefined),
    startPreflight: vi.fn().mockResolvedValue(undefined),
    continueAnalysis: vi.fn().mockResolvedValue(undefined),
  } as unknown as TaskAgentRuntime;
}

const agent = {
  getModelConfig: async () => ({
    endpoint: "https://model.example.com/v1",
    backgroundModel: "review-model",
    completionModel: "writer-model",
    hasApiKey: true,
  }),
  configureModel: vi.fn(),
} as unknown as TaskAgentBridge;

describe("agent panel", () => {
  it("offers one explicit extra budget window only for deferred units, never for unknown counts alone", () => {
    const runtime = runtimeOf({ grant: { taskId: "task-1", scope: "task", sourceEntryIds: [], endpoint: "model", createdAt: 1 }, jobs: [], deferredUnitIds: ["u2"], remainingUnitCount: 99 });
    const view = render(<AgentPanel agent={agent} snapshot={snapshot(["u1", "u2"])} runtime={runtime} />);
    expect(runtime.continueAnalysis).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("task-review-continue-analysis"));
    expect(runtime.continueAnalysis).toHaveBeenCalledTimes(1);
    view.rerender(<AgentPanel agent={agent} snapshot={snapshot(["u1", "u2"])} runtime={runtimeOf({ ...runtime.state!, deferredUnitIds: [] })} />);
    expect(screen.queryByTestId("task-review-continue-analysis")).toBeNull();
  });
  it("keeps risk unknown when only old-policy or wrong-source analysis exists", () => {
    const task = snapshot(["a", "b"]);
    const old = { ...fakeJob("old", "completed", ["a"]), policyRevision: task.policyRevision - 1 };
    const wrongSource = { ...fakeJob("wrong-source", "completed", ["b"]), sourceVersionIds: ["superseded-source"] };
    expect(preflightCoverage(task, { jobs: [old, wrongSource] })).toMatchObject({ analyzed: 0, failed: 0, unanalyzed: 2 });
    const failed = { ...fakeJob("failed", "failed", ["a", "b"]), completedUnitIds: ["a"] };
    expect(preflightCoverage(task, { jobs: [failed] })).toMatchObject({ analyzed: 1, failed: 1, unanalyzed: 0 });
  });
  it("shows preflight coverage totals, failure and pause/retry per job", () => {
    const units = ["u1", "u2", "u3", "u4"];
    render(
      <AgentPanel
        agent={agent}
        snapshot={snapshot(units)}
        runtime={runtimeOf({
          grant: {
            taskId: "task-1",
            scope: "task",
            sourceEntryIds: [],
            endpoint: "https://model.example.com/v1",
            createdAt: 1,
          },
          jobs: [
            {
              id: "job-done",
              taskId: "task-1",
              key: "job-done",
              sourceVersionIds: ["source-1"],
              unitIds: ["u1", "u2"],
              policyRevision: 1,
              status: "completed",
              attempts: 1,
              completedUnitIds: ["u1", "u2"],
              maxOutputTokens: 1,
              reservedOutputTokens: 0,
              createdAt: 1,
              updatedAt: 2,
            },
            {
              id: "job-failed",
              taskId: "task-1",
              key: "job-failed",
              sourceVersionIds: ["source-1"],
              unitIds: ["u3"],
              policyRevision: 1,
              status: "failed",
              attempts: 2,
              completedUnitIds: [],
              maxOutputTokens: 1,
              reservedOutputTokens: 0,
              createdAt: 1,
              updatedAt: 2,
              error: "模型超时",
            },
            {
              id: "job-running",
              taskId: "task-1",
              key: "job-running",
              sourceVersionIds: ["source-1"],
              unitIds: ["u4"],
              policyRevision: 1,
              status: "running",
              attempts: 1,
              completedUnitIds: [],
              maxOutputTokens: 1,
              reservedOutputTokens: 0,
              createdAt: 1,
              updatedAt: 2,
            },
          ],
        })}
      />,
    );
    const coverage = screen.getByTestId("task-review-coverage").textContent!;
    expect(coverage).toContain("总 4");
    expect(coverage).toContain("已分析 2");
    expect(coverage).toContain("进行中 1");
    expect(coverage).toContain("失败 1");
    expect(coverage).toContain("未分析 0");

    fireEvent.click(screen.getByTestId("task-review-job-retry"));
    fireEvent.click(screen.getAllByTestId("task-review-job-cancel")[0]);
    expect((screen.getByText("模型超时").textContent ?? "")).toBeTruthy();

    const jobs = screen.getAllByTestId("task-review-job");
    expect(jobs.map((job) => job.dataset.status)).toEqual([
      "completed",
      "failed",
      "running",
    ]);
  });

  it("authorizes the task with the current source versions", async () => {
    const runtime = runtimeOf({ jobs: [] });
    render(<AgentPanel agent={agent} snapshot={snapshot(["u1"])} runtime={runtime} />);
    fireEvent.click(await screen.findByTestId("task-review-authorize"));
    await waitFor(() => expect(runtime.authorize).toHaveBeenCalledWith(["source-1"]));
    // The manual-review path stays visible without a model.
    expect(
      screen.getByText("授权只覆盖本任务；未配置模型时仍可全程人工审阅与导出"),
    ).toBeTruthy();
  });

  it("saves the model channel without persisting the key in the renderer", async () => {
    const configureModel = vi.fn().mockResolvedValue({
      endpoint: "https://model.example.com/v1",
      backgroundModel: "review-model",
      completionModel: "writer-model",
      hasApiKey: true,
    });
    const fakeAgent = {
      getModelConfig: async () => ({
        endpoint: "https://model.example.com/v1",
        backgroundModel: "review-model",
        completionModel: "writer-model",
        hasApiKey: false,
      }),
      configureModel,
    } as unknown as TaskAgentBridge;
    render(
      <AgentPanel agent={fakeAgent} snapshot={snapshot(["u1"])} runtime={runtimeOf({ jobs: [] })} />,
    );
    const key = await screen.findByLabelText("模型 API 密钥");
    fireEvent.change(key, { target: { value: "secret-token" } });
    fireEvent.click(screen.getByTestId("task-review-model-save"));
    await waitFor(() => expect(configureModel).toHaveBeenCalledTimes(1));
    expect(configureModel).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "secret-token" }),
    );
    // The form forgets the token right after submitting it to safeStorage.
    await waitFor(() => expect((key as HTMLInputElement).value).toBe(""));
  });

  it("revokes the authorization", async () => {
    const runtime = runtimeOf({
      grant: {
        taskId: "task-1",
        scope: "task",
        sourceEntryIds: [],
        endpoint: "https://model.example.com/v1",
        createdAt: 1,
      },
      jobs: [],
    });
    render(<AgentPanel agent={agent} snapshot={snapshot(["u1"])} runtime={runtime} />);
    fireEvent.click(await screen.findByTestId("task-review-revoke"));
    await waitFor(() => expect(runtime.revoke).toHaveBeenCalledTimes(1));
  });
});

useChineseReviewLocale();
