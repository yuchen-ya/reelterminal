import { act, cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { changeAppLanguage, SYSTEM_LANGUAGE } from "../i18n";
import { toast, useNotificationStore } from "../stores/notification-store";
import { ToastContainer } from "./Toast";

afterEach(async () => { cleanup(); useNotificationStore.getState().clearAll(); await changeAppLanguage(SYSTEM_LANGUAGE); });

it("updates retained app diagnostics without translating custom notification bodies", async () => {
  await changeAppLanguage("en");
  toast.error("Operation failed", "Document capture cancelled");
  toast.success("User note", "Keep", { localizeMessage: false });
  render(<ToastContainer />);
  const app = screen.getByText("Operation failed").closest('[data-testid="notification-toast"]')! as HTMLElement;
  const custom = screen.getByText("User note").closest('[data-testid="notification-toast"]')! as HTMLElement;
  expect(within(app).getByText("Document capture cancelled")).toBeInTheDocument();
  await act(() => changeAppLanguage("zh-CN"));
  expect(within(app).getByText("操作失败")).toBeInTheDocument();
  expect(within(app).getByText("文档截图已取消")).toBeInTheDocument();
  expect(within(custom).getByText("Keep")).toBeInTheDocument();
  expect(useNotificationStore.getState().notifications).toHaveLength(2);
  await act(() => changeAppLanguage("en"));
  expect(within(app).getByText("Document capture cancelled")).toBeInTheDocument();
});
