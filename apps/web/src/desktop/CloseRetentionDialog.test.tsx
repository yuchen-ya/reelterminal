/**
 * Close-time version retention dialog contract (docs/VERSION-NODES-UX.md
 * 关闭应用时留存版本): lists the workspaces with retention-worthy changes,
 * resolves the awaited decision, commits the "next time" preference only on
 * an affirmative close, and offers retry / save-only-close after a failed
 * retention while the mandatory workspace save has already succeeded.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CloseRetentionDialog,
  requestCloseRetention,
  type CloseRetentionCandidate,
  type CloseRetentionDecision,
} from "./CloseRetentionDialog";
import { useSettingsStore } from "../stores/settings-store";
import { t } from "../i18n";

const candidates: CloseRetentionCandidate[] = [
  {
    projectId: "p1",
    projectName: "宣传片",
    workspaceId: "w1",
    workspaceName: "主剪辑",
  },
  {
    projectId: "p2",
    projectName: "Vlog",
    workspaceId: "w2",
    workspaceName: "初剪",
  },
];

type PromiseRef = { current?: Promise<CloseRetentionDecision> };

function openDialog(options?: {
  runRetention?: () => Promise<void>;
  startInFailure?: boolean;
}): { promise: PromiseRef; runRetention: () => Promise<void> } {
  const runRetention = options?.runRetention ?? vi.fn(async () => {});
  const promise: PromiseRef = {};
  act(() => {
    promise.current = requestCloseRetention(candidates, {
      runRetention,
      startInFailure: options?.startInFailure,
    });
  });
  render(<CloseRetentionDialog />);
  return { promise, runRetention };
}

async function click(testId: string): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByTestId(testId));
  });
}

function changePreference(value: string): void {
  const wrapper = screen.getByTestId("close-pref-select");
  const select = wrapper.querySelector("select");
  if (!select) throw new Error("preference select not found");
  fireEvent.change(select, { target: { value } });
}

describe("CloseRetentionDialog", () => {
  beforeEach(() => {
    useSettingsStore.getState().setCloseRetention("ask");
  });

  afterEach(() => {
    useSettingsStore.getState().setCloseRetention("ask");
  });

  it("lists every workspace with retention-worthy changes", () => {
    openDialog();

    expect(screen.getByTestId("close-retention-dialog")).toBeTruthy();
    expect(screen.getByText("宣传片 · 主剪辑")).toBeTruthy();
    expect(screen.getByText("Vlog · 初剪")).toBeTruthy();
    expect(screen.getByTestId("close-retain-button")).toBeTruthy();
    expect(screen.getByTestId("close-directly-button")).toBeTruthy();
    expect(screen.getByTestId("close-cancel-button")).toBeTruthy();
    expect(screen.getByTestId("close-pref-select")).toBeTruthy();
  });

  it("retains, commits the chosen preference, and allows the close", async () => {
    const runRetention = vi.fn(async () => {});
    const { promise } = openDialog({ runRetention });

    changePreference("skip");
    await click("close-retain-button");

    expect(await promise.current).toBe("retain");
    expect(runRetention).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().closeRetention).toBe("skip");
  });

  it("closes directly, commits the preference, and never runs retention", async () => {
    const runRetention = vi.fn(async () => {});
    const { promise } = openDialog({ runRetention });

    changePreference("retain");
    await click("close-directly-button");

    expect(await promise.current).toBe("close");
    expect(runRetention).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().closeRetention).toBe("retain");
  });

  it("cancel aborts the close and commits no preference", async () => {
    const runRetention = vi.fn(async () => {});
    const { promise } = openDialog({ runRetention });

    changePreference("skip");
    await click("close-cancel-button");

    expect(await promise.current).toBe("cancel");
    expect(runRetention).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().closeRetention).toBe("ask");
  });

  it("shows the failure state after a failed retention and closes without the version on request", async () => {
    const runRetention = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce();
    const { promise } = openDialog({ runRetention });

    changePreference("skip");
    await click("close-retain-button");

    expect(screen.getByText(t("closeRetention.retainFailed"))).toBeTruthy();
    expect(screen.getByTestId("close-retry-button")).toBeTruthy();

    // "仅保存并关闭" relies on the flush that already succeeded; it closes
    // without retaining and without committing the unfulfilled preference.
    await click("close-save-only-button");
    expect(await promise.current).toBe("close");
    expect(runRetention).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().closeRetention).toBe("ask");
  });

  it("retries a failed retention and allows the close once it succeeds", async () => {
    const runRetention = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("disk full"))
      .mockResolvedValueOnce();
    const { promise } = openDialog({ runRetention });

    await click("close-retain-button");
    expect(screen.getByText(t("closeRetention.retainFailed"))).toBeTruthy();

    await click("close-retry-button");

    expect(await promise.current).toBe("retain");
    expect(runRetention).toHaveBeenCalledTimes(2);
    expect(useSettingsStore.getState().closeRetention).toBe("ask");
  });

  it("opens straight into the failure state for the auto-retain path", () => {
    openDialog({ startInFailure: true });

    expect(screen.getByText(t("closeRetention.retainFailed"))).toBeTruthy();
    expect(screen.queryByTestId("close-retain-button")).toBeNull();
    expect(screen.getByTestId("close-save-only-button")).toBeTruthy();
  });
});
