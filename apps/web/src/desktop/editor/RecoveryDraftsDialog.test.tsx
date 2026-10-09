import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useNotificationStore } from "../../stores/notification-store";

const fixture = vi.hoisted(() => ({
  listRecoveryDrafts: vi.fn(),
  recoverDraft: vi.fn(),
}));

vi.mock("../../services/workspace-manager", () => ({
  workspaceManager: {
    listRecoveryDrafts: fixture.listRecoveryDrafts,
    recoverDraft: fixture.recoverDraft,
  },
}));

import { RecoveryDraftsDialog } from "./RecoveryDraftsDialog";

const target = { projectId: "project-a", workspaceId: "workspace-a" };

beforeEach(() => {
  vi.clearAllMocks();
  useNotificationStore.getState().clearAll();
  fixture.recoverDraft.mockResolvedValue({ revision: 5, replayed: false });
});

describe("RecoveryDraftsDialog", () => {
  it("lists drafts with creation time and source, and restores on click", async () => {
    fixture.listRecoveryDrafts.mockResolvedValue([
      { id: "draft-1", projectId: "project-a", workspaceId: "workspace-a", source: "restore-protection", createdAt: 1_700_000_000_000, baseNodeId: null, revision: 3, project: {}, mediaIds: [] },
    ]);
    const onClose = vi.fn();
    render(<RecoveryDraftsDialog target={target} onClose={onClose} />);

    const dialog = await screen.findByTestId("recovery-drafts-dialog");
    expect(dialog).toBeInTheDocument();
    const row = await screen.findByTestId("recovery-draft-row");
    expect(row).toHaveTextContent(new Date(1_700_000_000_000).toLocaleString());
    expect(row).toHaveTextContent("Edits before switching versions");

    fireEvent.click(row);
    await waitFor(() => expect(fixture.recoverDraft).toHaveBeenCalledWith(target, "draft-1"));
    await waitFor(() =>
      expect(useNotificationStore.getState().notifications.some((entry) => entry.type === "success")).toBe(true),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it("shows the empty state when no drafts exist", async () => {
    fixture.listRecoveryDrafts.mockResolvedValue([]);
    render(<RecoveryDraftsDialog target={target} onClose={vi.fn()} />);
    await screen.findByTestId("recovery-drafts-dialog");
    expect(await screen.findByText("No protected recovery drafts")).toBeInTheDocument();
  });

  it("closes via the cancel button without recovering", async () => {
    fixture.listRecoveryDrafts.mockResolvedValue([]);
    const onClose = vi.fn();
    render(<RecoveryDraftsDialog target={target} onClose={onClose} />);
    await screen.findByTestId("recovery-drafts-dialog");
    fireEvent.click(screen.getByTestId("recovery-drafts-cancel"));
    expect(onClose).toHaveBeenCalled();
    expect(fixture.recoverDraft).not.toHaveBeenCalled();
  });
});
