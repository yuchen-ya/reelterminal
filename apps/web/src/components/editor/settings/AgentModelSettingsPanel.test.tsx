import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentModelSettingsPanel } from "./AgentModelSettingsPanel";
import i18n from "../../../i18n";
import type { TaskModelConfig, TaskModelConfigInput } from "../../../../../desktop/src/shared/task-review-runtime-types";

describe("AgentModelSettingsPanel", () => {
  it("preserves unsaved endpoint, model and key input when switching languages", async () => {
    const previousLanguage = i18n.language;
    try {
      await i18n.changeLanguage("en");
      render(<AgentModelSettingsPanel />);
      await waitFor(() => expect(document.getElementById("agent-endpoint-input")).toHaveValue(initialConfig.endpoint));
      const endpoint = document.getElementById("agent-endpoint-input") as HTMLInputElement;
      const model = document.getElementById("agent-bg-model-input") as HTMLInputElement;
      const key = document.getElementById("agent-api-key-input") as HTMLInputElement;
      fireEvent.change(endpoint, { target: { value: "https://example.invalid/v1" } });
      fireEvent.change(model, { target: { value: "user-draft-model" } });
      fireEvent.change(key, { target: { value: "synthetic-test-key" } });
      await act(async () => { await i18n.changeLanguage("zh-CN"); });
      expect(screen.getByText("内置 Agent 与 AI 模型配置")).toBeVisible();
      expect(endpoint).toHaveValue("https://example.invalid/v1");
      expect(model).toHaveValue("user-draft-model");
      expect(key).toHaveValue("synthetic-test-key");
      expect(mockGetModelConfig).toHaveBeenCalledTimes(1);
      expect(mockConfigureModel).not.toHaveBeenCalled();
    } finally {
      await act(async () => { await i18n.changeLanguage(previousLanguage); });
    }
  });

  const initialConfig: TaskModelConfig = {
    endpoint: "https://api.deepseek.com",
    backgroundModel: "deepseek-chat",
    completionModel: "deepseek-chat",
    hasApiKey: true,
  };

  let mockGetModelConfig: ReturnType<typeof vi.fn>;
  let mockConfigureModel: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockGetModelConfig = vi.fn().mockResolvedValue(initialConfig);
    mockConfigureModel = vi.fn().mockImplementation(async (input: TaskModelConfigInput) => ({
      endpoint: input.endpoint,
      backgroundModel: input.backgroundModel,
      completionModel: input.completionModel,
      hasApiKey: input.apiKey !== undefined ? input.apiKey !== "" : initialConfig.hasApiKey,
    }));

    Object.defineProperty(window, "reelterminal", {
      configurable: true,
      value: {
        taskAgent: {
          getModelConfig: mockGetModelConfig,
          configureModel: mockConfigureModel,
        },
      },
    });
  });

  it("loads and displays existing configuration on mount", async () => {
    render(<AgentModelSettingsPanel />);

    await waitFor(() => {
      expect(mockGetModelConfig).toHaveBeenCalledTimes(1);
    });

    const endpointInput = screen.getByLabelText(/API 接口地址|API Endpoint/i) as HTMLInputElement;
    const bgModelInput = screen.getByLabelText(/^后台预审模型|^Background Model$/i) as HTMLInputElement;
    const compModelInput = screen.getByLabelText(/^实时续写模型|^Completion Model$/i) as HTMLInputElement;

    expect(endpointInput.value).toBe("https://api.deepseek.com");
    expect(bgModelInput.value).toBe("deepseek-chat");
    expect(compModelInput.value).toBe("deepseek-chat");

    // Has key badge
    expect(screen.getByText(/已安全加密存储|Securely stored/i)).toBeInTheDocument();
  });

  it("switches provider presets and updates endpoints and models", async () => {
    render(<AgentModelSettingsPanel />);

    await waitFor(() => {
      expect(mockGetModelConfig).toHaveBeenCalledTimes(1);
    });

    const providerSelect = screen.getByLabelText(/服务商预设|Provider Preset/i) as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: "openai" } });

    const endpointInput = screen.getByLabelText(/API 接口地址|API Endpoint/i) as HTMLInputElement;
    const bgModelInput = screen.getByLabelText(/^后台预审模型|^Background Model$/i) as HTMLInputElement;
    const compModelInput = screen.getByLabelText(/^实时续写模型|^Completion Model$/i) as HTMLInputElement;

    expect(endpointInput.value).toBe("https://api.openai.com/v1");
    expect(bgModelInput.value).toBe("gpt-4.1");
    expect(compModelInput.value).toBe("gpt-4o-mini");
  });

  it("supports quick-selecting a model from preset dropdown", async () => {
    render(<AgentModelSettingsPanel />);

    await waitFor(() => {
      expect(mockGetModelConfig).toHaveBeenCalledTimes(1);
    });

    const bgQuickSelect = screen.getByLabelText(/后台预审模型预设选择|Background model preset quick-select/i);
    fireEvent.change(bgQuickSelect, { target: { value: "deepseek-reasoner" } });

    const bgModelInput = screen.getByLabelText(/^后台预审模型|^Background Model$/i) as HTMLInputElement;
    expect(bgModelInput.value).toBe("deepseek-reasoner");
  });

  it("submits updated model configuration when saving", async () => {
    render(<AgentModelSettingsPanel />);

    await waitFor(() => {
      expect(mockGetModelConfig).toHaveBeenCalledTimes(1);
    });

    const apiKeyInput = screen.getByPlaceholderText(/••••••••••••••••/i) as HTMLInputElement;
    fireEvent.change(apiKeyInput, { target: { value: "sk-test-secret-key" } });

    const saveButton = screen.getByRole("button", { name: /保存设置|Save Settings/i });
    fireEvent.click(saveButton);

    await waitFor(() => {
      expect(mockConfigureModel).toHaveBeenCalledWith({
        endpoint: "https://api.deepseek.com",
        backgroundModel: "deepseek-chat",
        completionModel: "deepseek-chat",
        apiKey: "sk-test-secret-key",
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/已成功保存|saved successfully/i);
  });

  it("clears stored API key when clear button is clicked", async () => {
    render(<AgentModelSettingsPanel />);

    await waitFor(() => {
      expect(screen.getByLabelText(/清除已存密钥|Clear stored API key/i)).toBeInTheDocument();
    });

    const clearButton = screen.getByLabelText(/清除已存密钥|Clear stored API key/i);
    fireEvent.click(clearButton);

    await waitFor(() => {
      expect(mockConfigureModel).toHaveBeenCalledWith({
        endpoint: "https://api.deepseek.com",
        backgroundModel: "deepseek-chat",
        completionModel: "deepseek-chat",
        apiKey: "",
      });
    });

    expect(await screen.findByRole("alert")).toHaveTextContent(/已成功清除已存储的 API 密钥|cleared successfully/i);
  });

  it("shows desktop required notice when running outside electron bridge", async () => {
    Object.defineProperty(window, "reelterminal", {
      configurable: true,
      value: undefined,
    });

    render(<AgentModelSettingsPanel />);

    expect(screen.getByText(/仅限桌面端运行|Desktop Application Required/i)).toBeInTheDocument();
  });
});
