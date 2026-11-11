import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewAdminMenu } from "./ReviewAdminMenu";
import type { ReactNode } from "react";

// Radix focus/portal interaction is exercised by real Electron workbench E2E.
// This unit seam checks the menu's offered actions and their callbacks.
vi.mock("@reelterminal/ui", () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div role="menu">{children}</div>,
  DropdownMenuItem: ({ children, onSelect, ...props }: { children: ReactNode; onSelect?: () => void }) => <button {...props} onClick={onSelect}>{children}</button>,
  DropdownMenuSeparator: () => <hr />,
}));

afterEach(cleanup);
it("keeps the existing project workbench entry without offering retired batch migration or restore", async () => {
  const openProject = vi.fn();
  render(<ReviewAdminMenu hasProject projectName="Existing project" onOpenLegacyProject={openProject} />);
  const item = await screen.findByTestId("review-legacy-project");
  expect(screen.queryByTestId("review-migration-open")).toBeNull();
  expect(screen.queryByTestId("review-backup-open")).toBeNull();
  expect(screen.queryByTestId("review-restore-open")).toBeNull();
  fireEvent.click(item);
  expect(openProject).toHaveBeenCalledOnce();
});
