import { changeAppLanguage, SYSTEM_LANGUAGE } from "../../i18n";
import { beforeEach } from "vitest";
beforeEach(async () => { vi.clearAllMocks(); await changeAppLanguage("zh-CN"); });
afterEach(() => changeAppLanguage(SYSTEM_LANGUAGE));
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  review: vi.fn(),
  plan: vi.fn(),
  execute: vi.fn(),
}));
vi.mock("../../stores/desktop-export-store", () => ({
  useDesktopExportStore: (select: (state: unknown) => unknown) => select({ session: null, outputs: [] }),
}));
vi.mock("../../stores/ui-store", () => ({ useUIStore: { getState: () => ({}) } }));
vi.mock("../../services/workspace-manager", () => ({
  workspaceManager: {
    getActiveWorkspace: async () => ({ projectId: "project", id: "workspace" }),
    getWorkspaceContext: async () => ({ store: { getState: () => ({ project: {} }) } }),
  },
}));
vi.mock("../../services/export-cleanup", () => ({
  getCleanupReview: mocks.review,
  createCleanupPlan: mocks.plan,
  executeCleanupPlan: mocks.execute,
}));
vi.mock("../../services/cleanup-handoff", () => ({}));
import { ExportCleanupPage } from "./ExportCleanupPage";

afterEach(cleanup);

it("previews an empty cleanup without offering an executable deletion", async () => {
  mocks.review.mockResolvedValue({
    nodes: [], unknowns: [], revision: 0,
    selected: { reclaimableBytes: 0 }, retainedSummary: { references: [] },
    workFiles: { files: [] }, failedJobs: { tasks: [], unknowns: [] },
  });
  mocks.plan.mockResolvedValue({
    planId: "plan", revision: 0, action: "purge-media", status: "ready",
    reclaimableBytes: 0, selection: { nodeIds: [], mediaIds: [], cacheKeys: [], jobIds: [] },
    candidateMedia: [], candidateCache: [], candidateJobs: [], candidateWorkFiles: [],
    retainedMedia: [], unknowns: [], blockers: [],
  });
  render(<ExportCleanupPage />);
  await screen.findByText(/还没有项目存档/);
  expect(screen.getByText("交给 Agent 协助检查（可选）").closest("details")).not.toHaveAttribute("open");
  fireEvent.click(screen.getByRole("button", { name: "预览清理内容" }));
  await screen.findByText(/没有可清理的内容/);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  expect(mocks.execute).not.toHaveBeenCalled();
  const confirmation = screen.getByTestId("cleanup-confirmation");
  const reviews = mocks.review.mock.calls.length;
  await act(() => changeAppLanguage("en"));
  expect(screen.getByTestId("cleanup-confirmation")).toBe(confirmation);
  expect(screen.getByText("Nothing to remove. Files still in use or of uncertain purpose are retained.")).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Confirm execution" })).toBeDisabled();
  expect(mocks.review).toHaveBeenCalledTimes(reviews);
  expect(mocks.plan).toHaveBeenCalledTimes(1);
  await act(() => changeAppLanguage("zh-CN"));
  expect(screen.getByTestId("cleanup-confirmation")).toBe(confirmation);
  expect(screen.getByRole("button", { name: "确认执行" })).toBeDisabled();
  expect(mocks.execute).not.toHaveBeenCalled();
});
