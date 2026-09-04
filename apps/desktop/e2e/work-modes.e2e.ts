/**
 * Real-desktop acceptance for elastic Agent work modes.
 *
 * Human-side changes use only Playwright UI input. The external Agent reads
 * mode context through the shipped MCP connector and the reference
 * conversation adapter. Every launch uses the harness's isolated userData and
 * never opens the developer's current project.
 */
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { Locator } from "playwright-core";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { connectExternalAgent, type ExternalAgent } from "./harness/mcp-client";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";
import { createProjectViaUI } from "./harness/ui";
// The reference kit is plain ESM so external Agent hosts can copy it without
// taking a workspace dependency.
// @ts-expect-error JavaScript reference module intentionally has no TS surface.
import { startConversationAdapter } from "../../../scripts/conversation-adapter/adapter-kit.mjs";

interface AdapterHandle {
  close(): Promise<void>;
}

interface WorkModeContext {
  workMode: "guided" | "collaborative" | "autonomous";
  semantics: {
    id: "guided" | "collaborative" | "autonomous";
    label: string;
    summary: string;
    deliveryRequiresExplicitAuthorization: true;
  };
}

interface SessionDescription {
  runtime: "live";
  workMode: WorkModeContext["workMode"];
  workModeSemantics: WorkModeContext["semantics"];
  access: "read-only" | "write";
  writer: boolean;
  sessionId: string;
}

interface EditorContext {
  workMode: WorkModeContext["workMode"];
  workModeSemantics: WorkModeContext["semantics"];
}

async function waitForChecked(locator: Locator, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await locator.getAttribute("aria-checked")) === "true") return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("work-mode radio did not become checked");
}

async function waitForCount(
  values: readonly unknown[],
  count: number,
  label: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (values.length >= count) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`${label} did not reach ${count} event(s)`);
}

describe("Agent work modes: real desktop GUI and protocol", () => {
  let launched: LaunchedApp;
  let agent: ExternalAgent | null = null;
  let adapter: AdapterHandle;
  let evidence: EvidenceRecord;
  const initializeContexts: WorkModeContext[] = [];
  const resumeContexts: WorkModeContext[] = [];
  const changedContexts: WorkModeContext[] = [];
  const promptContexts: WorkModeContext[] = [];

  beforeAll(async () => {
    launched = await launchApp();
    evidence = createEvidence("work-modes", launched.page);
    adapter = await startConversationAdapter({
      sessionId: "e2e-work-mode-session",
      agent: { name: "E2E Work Mode Agent", version: "1.0" },
      adapter: { name: "e2e-work-mode-adapter", capabilityLevel: "basic" },
      descriptorPath: launched.conversationEndpointFile,
      onInitialize: (params: { clientContext: WorkModeContext }) => {
        initializeContexts.push(params.clientContext);
      },
      onResume: (params: { clientContext: WorkModeContext }) => {
        resumeContexts.push(params.clientContext);
      },
      onWorkMode: (params: { clientContext: WorkModeContext }) => {
        changedContexts.push(params.clientContext);
      },
      onPrompt: (params: { clientContext: WorkModeContext }) => {
        promptContexts.push(params.clientContext);
        return { messageId: "work-mode-prompt" };
      },
    });
    await createProjectViaUI(launched.page);
  }, 300_000);

  afterAll(async () => {
    evidence?.flush({
      initializeContexts,
      resumeContexts,
      changedContexts,
      promptContexts,
    });
    await agent?.close();
    await launched?.close();
    await adapter?.close();
  });

  test("defaults to Collaborative and renders the Chinese three-mode control", async () => {
    const page = launched.page;
    const group = page.getByRole("radiogroup", { name: "Work mode" });
    await group.waitFor();
    expect(await group.getByRole("radio").allTextContents()).toEqual([
      "Guided",
      "Collaborative",
      "Autonomous",
    ]);
    expect(
      await group
        .getByRole("radio", { name: "Collaborative" })
        .getAttribute("aria-checked"),
    ).toBe("true");

    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const language = page.getByRole("combobox", { name: "Language" });
    await language.selectOption("zh-CN");
    expect(await page.locator("html").getAttribute("lang")).toBe("zh-CN");
    await page.getByRole("button", { name: "关闭对话框" }).click();
    await page.getByRole("radiogroup", { name: "工作模式" }).waitFor();

    const chineseGroup = page.getByRole("radiogroup", { name: "工作模式" });
    expect(await chineseGroup.getByRole("radio").allTextContents()).toEqual([
      "引导",
      "协作",
      "自主",
    ]);
    expect(
      await chineseGroup.getByRole("radio", { name: "引导" }).getAttribute("title"),
    ).toContain("合理默认方案");
    expect(
      await chineseGroup.getByRole("radio", { name: "协作" }).getAttribute("aria-checked"),
    ).toBe("true");
    await evidence.screenshot("chinese-default-collaborative");
  });

  test("switches while disabled, preserves the floating window and draft, and updates both protocols", async () => {
    const page = launched.page;
    const guided = page.getByRole("radio", { name: "引导" });
    await guided.click();
    await waitForChecked(guided);
    expect(
      await page.getByRole("switch", { name: "智能体会话" }).getAttribute("aria-checked"),
    ).toBe("false");

    await page.getByRole("button", { name: "打开智能体面板" }).click();
    await page.getByRole("button", { name: "连接智能体", exact: true }).click();
    await page.getByText("智能体已连接", { exact: true }).first().waitFor();
    await launched.waitForEndpointFile();
    await waitForCount(initializeContexts, 1, "initialize context");
    await waitForCount(resumeContexts, 1, "resume context");
    expect(initializeContexts[0]?.workMode).toBe("guided");
    expect(resumeContexts[0]?.workMode).toBe("guided");

    const window = page.getByTestId("floating-window");
    const composer = page.getByRole("textbox", { name: "给外部 Agent 发送消息" });
    await composer.fill("保留这个未发送草稿");
    const beforeBounds = await window.boundingBox();
    expect(beforeBounds).not.toBeNull();

    const autonomous = page.getByRole("radio", { name: "自主" });
    await autonomous.click();
    await waitForChecked(autonomous);
    await waitForCount(changedContexts, 1, "work-mode notification");
    expect(changedContexts.at(-1)?.workMode).toBe("autonomous");
    expect(
      changedContexts.at(-1)?.semantics.deliveryRequiresExplicitAuthorization,
    ).toBe(true);
    expect(await composer.inputValue()).toBe("保留这个未发送草稿");
    expect(await window.boundingBox()).toEqual(beforeBounds);

    agent = await connectExternalAgent(launched.endpointFile);
    const described = await agent.callTool<SessionDescription>("session_describe");
    expect(described.ok).toBe(true);
    expect(described.value).toMatchObject({
      runtime: "live",
      workMode: "autonomous",
      access: "write",
      writer: true,
    });
    expect(
      described.value?.workModeSemantics.deliveryRequiresExplicitAuthorization,
    ).toBe(true);
    const sessionId = described.value?.sessionId;

    const context = await agent.callTool<EditorContext>("editor_get_context");
    expect(context.ok).toBe(true);
    expect(context.value).toMatchObject({
      workMode: "autonomous",
      workModeSemantics: {
        id: "autonomous",
        deliveryRequiresExplicitAuthorization: true,
      },
    });

    await composer.press("Enter");
    await waitForCount(promptContexts, 1, "prompt context");
    expect(promptContexts.at(-1)?.workMode).toBe("autonomous");

    await guided.click();
    await waitForChecked(guided);
    const sameSession = await agent.callTool<SessionDescription>("session_describe");
    expect(sameSession.ok).toBe(true);
    expect(sameSession.value).toMatchObject({
      sessionId,
      workMode: "guided",
      access: "write",
      writer: true,
    });
    await evidence.screenshot("guided-same-session");
  });

  test("persists Guided across a full Electron relaunch with the same isolated profile", async () => {
    const saved = await agent!.callTool<{ revision: number }>("project_save");
    expect(saved.ok).toBe(true);
    await agent!.close();
    agent = null;

    launched = await launched.relaunch();
    evidence.bindPage(launched.page);
    await launched.page.getByText("最近项目", { exact: true }).waitFor({ timeout: 60_000 });
    await launched.page.getByLabel("打开 Horizontal").click();
    await launched.page.getByRole("radiogroup", { name: "工作模式" }).waitFor({
      timeout: 120_000,
    });
    expect(
      await launched.page.getByRole("radio", { name: "引导" }).getAttribute("aria-checked"),
    ).toBe("true");
    await evidence.screenshot("guided-after-relaunch");
  });
});
