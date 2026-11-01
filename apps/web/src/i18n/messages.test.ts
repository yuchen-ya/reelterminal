import { afterEach, expect, it } from "vitest";
import i18n, { changeAppLanguage, SYSTEM_LANGUAGE } from ".";
import { localizeUiMessage, uiMessage } from "./messages";

afterEach(() => changeAppLanguage(SYSTEM_LANGUAGE));

it("retranslates retained transient messages in either direction", async () => {
  await changeAppLanguage("zh-CN");
  const retained = i18n.t("Operation failed");
  expect(retained).toBe("操作失败");
  await changeAppLanguage("en");
  expect(localizeUiMessage(retained)).toBe("Operation failed");
  await changeAppLanguage("zh-CN");
  expect(localizeUiMessage("Operation failed")).toBe("操作失败");
});

it("preserves captured user names and external diagnostics verbatim", async () => {
  await changeAppLanguage("en");
  const name = "用户命名：打开与管理", detail = "custom diagnostic /a/中文.txt";
  const message = i18n.t("Task “{{v0}}” was created, but file import failed: {{v1}}", { v0: name, v1: detail });
  await changeAppLanguage("zh-CN");
  expect(localizeUiMessage(message)).toBe(`任务“${name}”已创建，但文件导入失败：${detail}`);
  expect(localizeUiMessage(detail)).toBe(detail);
  expect(localizeUiMessage("a".repeat(20_000))).toHaveLength(20_000);
});

it("handles literal punctuation in keys and respects app date/number locale", async () => {
  const { formatDateTime, formatNumber } = await import(".");
  const date = new Date(2026, 10, 1, 13, 45);
  await changeAppLanguage("zh-CN");
  expect(i18n.t("Back to collection: {{v0}}", { v0: "我的集合" })).toBe("返回集合：我的集合");
  expect(formatDateTime(date)).toBe(date.toLocaleString("zh-CN"));
  expect(formatNumber(1234567.8)).toBe((1234567.8).toLocaleString("zh-CN"));
  await changeAppLanguage("en");
  expect(formatDateTime(date)).toBe(date.toLocaleString("en"));
});

it("keeps canonical service metadata stable and translates only recognized native errors", async () => {
  await changeAppLanguage("en");
  const canonical = uiMessage("Document capture cancelled");
  const native = "Error invoking remote method 'reelterminal:document:capture': Error: " + canonical;
  const external = "Error invoking remote method 'custom': Error: 用户自己的错误";
  await changeAppLanguage("zh-CN");
  expect(uiMessage("Document capture cancelled")).toBe(canonical);
  expect(localizeUiMessage(native)).toBe("文档截图已取消");
  expect(localizeUiMessage(external)).toBe(external);
  expect(localizeUiMessage(uiMessage("Reference unavailable: {{reference}} ({{reason}})", { reference: "Keep", reason: "Referenced file is missing" }))).toBe("引用不可用：Keep（引用文件缺失）");
  const message = uiMessage("Task “{{v0}}” was created, but file import failed: {{v1}}", { v0: "Keep", v1: canonical });
  expect(localizeUiMessage(message)).toBe("任务“Keep”已创建，但文件导入失败：文档截图已取消");
  await changeAppLanguage("en");
  expect(localizeUiMessage(localizeUiMessage(message))).toBe(message);
});
