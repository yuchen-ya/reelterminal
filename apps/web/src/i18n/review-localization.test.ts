import { expect, it } from "vitest";
import i18n, { t } from "./index";
import { statusLabels, unitTitle } from "../desktop/workbench/task-review/display";
import { getProviderPreset } from "../desktop/workbench/task-review/model-presets";

it("looks up review verdicts and provider labels after each locale change", async () => {
  const previousLanguage = i18n.language;
  try {
    await i18n.changeLanguage("en");
    expect(statusLabels.kept).toBe("Keep");
    expect(getProviderPreset("magpie")?.label).toBe("Magpie (local Pi proxy)");
    expect(unitTitle({ id: "image", ordinal: 1, sourceVersionId: "source", kind: "image" })).toBe("Image");
    expect(t(" · Scope {{scope}} items, local search {{local}} items, AI candidates {{candidates}} items; ", { scope: 4, local: 3, candidates: 2 })).toBe(" · Scope 4 items, local search 3 items, AI candidates 2 items; ");
    expect(t("Saved {{v0}}/{{v1}} items; remaining items incomplete: {{v2}}", { v0: 1, v1: 3, v2: "用户内容 {{literal}} <x>" })).toBe("Saved 1/3 items; remaining items incomplete: 用户内容 {{literal}} <x>");
    await i18n.changeLanguage("zh-CN");
    expect(statusLabels.kept).toBe("保留");
    expect(getProviderPreset("magpie")?.label).toBe("Magpie (本地 Pi 代理)");
    expect(unitTitle({ id: "image", ordinal: 1, sourceVersionId: "source", kind: "image" })).toBe("图片");
    expect(t(" · Scope {{scope}} items, local search {{local}} items, AI candidates {{candidates}} items; ", { scope: 4, local: 3, candidates: 2 })).toBe(" · 范围 4 条，本地检索 3 条，AI 候选 2 条；");
    expect(t("Saved {{v0}}/{{v1}} items; remaining items incomplete: {{v2}}", { v0: 1, v1: 3, v2: "用户内容 {{literal}} <x>" })).toBe("已保存 1/3 条；剩余条目未完成：用户内容 {{literal}} <x>");
  } finally { await i18n.changeLanguage(previousLanguage); }
});
