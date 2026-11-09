import React, { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Bot,
  CheckCircle2,
  Eye,
  EyeOff,
  ShieldCheck,
  Trash2,
} from "@/icons/lucide-compat";
import { ToolcraftButton as Button, ToolcraftText as Text } from "@reelterminal/ui";
import { toast } from "../../../stores/notification-store";
import {
  detectProviderPreset,
  getProviderPreset,
  MODEL_PROVIDER_PRESETS,
} from "../../../desktop/workbench/task-review/model-presets";
import type {
  TaskModelConfig,
  TaskModelConfigInput,
} from "../../../../../desktop/src/shared/task-review-runtime-types";

const ALL_DEFAULT_MODELS = new Set(
  MODEL_PROVIDER_PRESETS.flatMap((p) => p.models),
);

export const AgentModelSettingsPanel: React.FC = () => {
  const { t } = useTranslation();

  const isDesktop = typeof window !== "undefined" && Boolean(window.reelterminal?.taskAgent);

  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isClearing, setIsClearing] = useState(false);

  const [currentConfig, setCurrentConfig] = useState<TaskModelConfig | null>(null);
  const [provider, setProvider] = useState<string>("deepseek");
  const [endpoint, setEndpoint] = useState<string>("https://api.deepseek.com");
  const [backgroundModel, setBackgroundModel] = useState<string>("deepseek-chat");
  const [completionModel, setCompletionModel] = useState<string>("deepseek-chat");
  const [apiKey, setApiKey] = useState<string>("");
  const [showApiKey, setShowApiKey] = useState<boolean>(false);
  const [feedback, setFeedback] = useState<{
    type: "success" | "error";
    message: string;
  } | null>(null);

  const activePreset = useMemo(() => getProviderPreset(provider), [provider]);
  const availablePresetModels = useMemo(() => activePreset?.models ?? [], [activePreset]);

  // Load configuration on mount
  useEffect(() => {
    let cancelled = false;

    async function loadConfig() {
      if (!isDesktop || !window.reelterminal?.taskAgent) {
        setIsLoading(false);
        return;
      }

      try {
        const config = await window.reelterminal.taskAgent.getModelConfig();
        if (cancelled) return;

        setCurrentConfig(config);
        setEndpoint(config.endpoint);
        setBackgroundModel(config.backgroundModel);
        setCompletionModel(config.completionModel);

        const detected = detectProviderPreset(config.endpoint);
        setProvider(detected);
      } catch (err: unknown) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        setFeedback({
          type: "error",
          message: `${t("agentSettings.saveError", "获取模型配置失败")}: ${msg}`,
        });
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    void loadConfig();

    return () => {
      cancelled = true;
    };
  }, [isDesktop, t]);

  const handleProviderChange = useCallback(
    (newProviderId: string) => {
      setProvider(newProviderId);
      setFeedback(null);

      const preset = getProviderPreset(newProviderId);
      if (preset && preset.id !== "custom" && preset.endpoint) {
        setEndpoint(preset.endpoint);

        // If background model is empty or one of the known presets, update to this provider's default
        const defaultBg = preset.models[0] ?? "";
        const defaultComp =
          preset.id === "openai"
            ? "gpt-4o-mini"
            : preset.id === "dashscope"
              ? "qwen-plus"
              : preset.id === "openrouter"
                ? "deepseek/deepseek-chat-v3-0324"
                : defaultBg;

        if (!backgroundModel || ALL_DEFAULT_MODELS.has(backgroundModel)) {
          setBackgroundModel(defaultBg);
        }
        if (!completionModel || ALL_DEFAULT_MODELS.has(completionModel)) {
          setCompletionModel(defaultComp);
        }
      }
    },
    [backgroundModel, completionModel],
  );

  const handleEndpointChange = useCallback((newEndpoint: string) => {
    setEndpoint(newEndpoint);
    setFeedback(null);
    const detected = detectProviderPreset(newEndpoint);
    setProvider(detected);
  }, []);

  const handleClearApiKey = useCallback(async () => {
    if (!window.reelterminal?.taskAgent) return;

    setIsClearing(true);
    setFeedback(null);

    try {
      const updated = await window.reelterminal.taskAgent.configureModel({
        endpoint: endpoint.trim() || currentConfig?.endpoint || "https://api.deepseek.com",
        backgroundModel:
          backgroundModel.trim() || currentConfig?.backgroundModel || "deepseek-chat",
        completionModel:
          completionModel.trim() || currentConfig?.completionModel || "deepseek-chat",
        apiKey: "",
      });

      setCurrentConfig(updated);
      setApiKey("");
      const successMsg = t(
        "agentSettings.clearKeySuccess",
        "已成功清除已存储的 API 密钥",
      );
      setFeedback({ type: "success", message: successMsg });
      toast.success(successMsg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = t("agentSettings.clearKeyError", "清除密钥失败");
      setFeedback({ type: "error", message: `${errorMsg}: ${msg}` });
      toast.error(errorMsg, msg);
    } finally {
      setIsClearing(false);
    }
  }, [backgroundModel, completionModel, currentConfig, endpoint, t]);

  const handleSave = useCallback(async () => {
    if (!isDesktop || !window.reelterminal?.taskAgent) {
      const msg = t(
        "agentSettings.desktopRequired",
        "内置 Agent 模型配置需在桌面版中使用",
      );
      setFeedback({ type: "error", message: msg });
      toast.error(msg);
      return;
    }

    const trimmedEndpoint = endpoint.trim();
    const trimmedBg = backgroundModel.trim();
    const trimmedComp = completionModel.trim();
    const trimmedKey = apiKey.trim();

    if (!trimmedEndpoint) {
      const msg = t("agentSettings.endpointRequired", "请输入 API 接口地址");
      setFeedback({ type: "error", message: msg });
      return;
    }

    if (!trimmedBg) {
      const msg = t(
        "agentSettings.backgroundModelRequired",
        "请输入后台预审模型名称",
      );
      setFeedback({ type: "error", message: msg });
      return;
    }

    if (!trimmedComp) {
      const msg = t(
        "agentSettings.completionModelRequired",
        "请输入实时续写模型名称",
      );
      setFeedback({ type: "error", message: msg });
      return;
    }

    // Backend requires re-entering API key when endpoint changes if a key was previously saved
    const endpointChanged =
      currentConfig &&
      currentConfig.endpoint.replace(/\/+$/, "") !== trimmedEndpoint.replace(/\/+$/, "");

    if (currentConfig?.hasApiKey && endpointChanged && !trimmedKey) {
      const msg = t(
        "agentSettings.reenterKeyRequired",
        "更换服务商接口地址后，请重新输入对应的 API 密钥",
      );
      setFeedback({ type: "error", message: msg });
      return;
    }

    setIsSaving(true);
    setFeedback(null);

    try {
      const payload: TaskModelConfigInput = {
        endpoint: trimmedEndpoint,
        backgroundModel: trimmedBg,
        completionModel: trimmedComp,
        ...(trimmedKey ? { apiKey: trimmedKey } : {}),
      };

      const updated = await window.reelterminal.taskAgent.configureModel(payload);
      setCurrentConfig(updated);
      setApiKey(""); // Clear raw key input after successful safeStorage encryption

      const successMsg = t(
        "agentSettings.saveSuccess",
        "AI 模型与接口配置已成功保存",
      );
      setFeedback({ type: "success", message: successMsg });
      toast.success(successMsg);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const errorMsg = t("agentSettings.saveError", "保存配置失败");
      setFeedback({ type: "error", message: `${errorMsg}: ${msg}` });
      toast.error(errorMsg, msg);
    } finally {
      setIsSaving(false);
    }
  }, [apiKey, backgroundModel, completionModel, currentConfig, endpoint, isDesktop, t]);

  return (
    <div className="space-y-5 pb-4 text-xs" data-testid="agent-model-settings-panel">
      {/* Header Info */}
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <Bot size={16} className="text-primary" />
          <Text type="body" color="primary" className="text-sm font-medium">
            {t("agentSettings.title", "内置 Agent 与 AI 模型配置")}
          </Text>
        </div>
        <Text type="supporting" color="secondary" className="text-xs">
          {t(
            "agentSettings.description",
            "配置审阅工作台及智能助手调用的大语言模型服务商、接口地址与加密密钥。",
          )}
        </Text>
      </div>

      {!isDesktop && (
        <div className="flex items-start gap-2.5 rounded-lg border border-status-warning/30 bg-status-warning/10 p-3 text-[12px] text-fg-2">
          <AlertCircle size={16} className="mt-0.5 shrink-0 text-status-warning" />
          <div className="space-y-0.5">
            <p className="font-semibold text-fg">
              {t("agentSettings.desktopNoticeTitle", "仅限桌面端运行")}
            </p>
            <p className="text-fg-muted">
              {t(
                "agentSettings.desktopNoticeBody",
                "内置 Agent 模型与安全密钥配置依赖 ReelTerminal 桌面应用运行时环境 (Electron safeStorage)。",
              )}
            </p>
          </div>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center py-10 text-fg-muted">
          <span
            aria-hidden
            className="mr-2 h-4 w-4 animate-spin rounded-full border-2 border-accent border-r-transparent"
          />
          <span>{t("common.loading", "加载配置中...")}</span>
        </div>
      ) : (
        <div className="space-y-4">
          {/* Provider Preset Dropdown */}
          <div className="space-y-1.5">
            <label
              htmlFor="agent-provider-select"
              className="text-[12px] font-medium text-fg"
            >
              {t("agentSettings.providerLabel", "服务商预设 (Provider)")}
            </label>
            <select
              id="agent-provider-select"
              className="flex h-8 w-full min-w-0 cursor-pointer rounded-[7px] border border-border bg-bg-1 px-2.5 py-1 text-[13px] font-medium text-fg-2 outline-none transition-colors hover:bg-bg-2 focus:border-accent"
              value={provider}
              onChange={(e) => handleProviderChange(e.target.value)}
              aria-label={t("agentSettings.providerLabel", "服务商预设")}
            >
              {MODEL_PROVIDER_PRESETS.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-fg-muted">
              {t(
                "agentSettings.providerDescription",
                "选择常用的大模型托管服务商，或选择自定义兼容 OpenAI 标准协议的接口。",
              )}
            </p>
          </div>

          {/* Endpoint Input */}
          <div className="space-y-1.5">
            <label
              htmlFor="agent-endpoint-input"
              className="text-[12px] font-medium text-fg"
            >
              {t("agentSettings.endpointLabel", "API 接口地址 (Endpoint)")}
            </label>
            <input
              id="agent-endpoint-input"
              type="text"
              className="flex h-8 w-full min-w-0 rounded-[7px] border border-border bg-bg-1 px-2.5 py-1.5 font-mono text-[13px] text-fg-2 outline-none transition-colors placeholder:text-fg-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={endpoint}
              onChange={(e) => handleEndpointChange(e.target.value)}
              placeholder="https://api.deepseek.com"
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[11px] text-fg-muted">
              {t(
                "agentSettings.endpointDescription",
                "OpenAI 兼容协议基础 URL（本地 Ollama 可使用 http://127.0.0.1:11434/v1，其余远程服务商必须使用 HTTPS）。",
              )}
            </p>
          </div>

          <div className="h-px bg-border" />

          {/* Background Model */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="agent-bg-model-input"
                className="text-[12px] font-medium text-fg"
              >
                {t(
                  "agentSettings.backgroundModelLabel",
                  "后台预审模型 (Background Model)",
                )}
              </label>
              {availablePresetModels.length > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <span>{t("agentSettings.quickSelect", "预设快捷选择")}:</span>
                  <select
                    className="cursor-pointer rounded border border-border bg-bg-2 px-1.5 py-0.5 text-[11px] text-fg-2 outline-none hover:bg-bg-3"
                    value={
                      availablePresetModels.includes(backgroundModel)
                        ? backgroundModel
                        : ""
                    }
                    onChange={(e) => {
                      if (e.target.value) setBackgroundModel(e.target.value);
                    }}
                    aria-label={t(
                      "agentSettings.backgroundModelQuickSelect",
                      "后台预审模型预设选择",
                    )}
                  >
                    <option value="" disabled>
                      {t("agentSettings.pickPresetPlaceholder", "选择常用模型...")}
                    </option>
                    {availablePresetModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <input
              id="agent-bg-model-input"
              type="text"
              className="flex h-8 w-full min-w-0 rounded-[7px] border border-border bg-bg-1 px-2.5 py-1.5 font-mono text-[13px] text-fg-2 outline-none transition-colors placeholder:text-fg-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={backgroundModel}
              onChange={(e) => setBackgroundModel(e.target.value)}
              placeholder={t(
                "agentSettings.modelPlaceholder",
                "例如: deepseek-chat 或 gpt-4o",
              )}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[11px] text-fg-muted">
              {t(
                "agentSettings.backgroundModelDescription",
                "用于审阅工作台中的后台初审、语义检索打分与批量建议生成。",
              )}
            </p>
          </div>

          {/* Completion Model */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="agent-completion-model-input"
                className="text-[12px] font-medium text-fg"
              >
                {t(
                  "agentSettings.completionModelLabel",
                  "实时续写模型 (Completion Model)",
                )}
              </label>
              {availablePresetModels.length > 0 && (
                <div className="flex items-center gap-1.5 text-[11px] text-fg-muted">
                  <span>{t("agentSettings.quickSelect", "预设快捷选择")}:</span>
                  <select
                    className="cursor-pointer rounded border border-border bg-bg-2 px-1.5 py-0.5 text-[11px] text-fg-2 outline-none hover:bg-bg-3"
                    value={
                      availablePresetModels.includes(completionModel)
                        ? completionModel
                        : ""
                    }
                    onChange={(e) => {
                      if (e.target.value) setCompletionModel(e.target.value);
                    }}
                    aria-label={t(
                      "agentSettings.completionModelQuickSelect",
                      "实时续写模型预设选择",
                    )}
                  >
                    <option value="" disabled>
                      {t("agentSettings.pickPresetPlaceholder", "选择常用模型...")}
                    </option>
                    {availablePresetModels.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <input
              id="agent-completion-model-input"
              type="text"
              className="flex h-8 w-full min-w-0 rounded-[7px] border border-border bg-bg-1 px-2.5 py-1.5 font-mono text-[13px] text-fg-2 outline-none transition-colors placeholder:text-fg-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
              value={completionModel}
              onChange={(e) => setCompletionModel(e.target.value)}
              placeholder={t(
                "agentSettings.modelPlaceholder",
                "例如: deepseek-chat 或 gpt-4o-mini",
              )}
              spellCheck={false}
              autoComplete="off"
            />
            <p className="text-[11px] text-fg-muted">
              {t(
                "agentSettings.completionModelDescription",
                "用于用户输入时的低延迟实时补全与即时文字建议。",
              )}
            </p>
          </div>

          <div className="h-px bg-border" />

          {/* API Key */}
          <div className="space-y-1.5">
            <div className="flex items-center justify-between">
              <label
                htmlFor="agent-api-key-input"
                className="text-[12px] font-medium text-fg"
              >
                {t("agentSettings.apiKeyLabel", "API 密钥 (API Key)")}
              </label>
              {currentConfig?.hasApiKey && (
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-status-success">
                  <ShieldCheck size={13} className="shrink-0" />
                  {t(
                    "agentSettings.keyEncryptedNotice",
                    "已安全加密存储 (safeStorage)",
                  )}
                </span>
              )}
            </div>
            <div className="relative flex items-center">
              <input
                id="agent-api-key-input"
                type={showApiKey ? "text" : "password"}
                className="flex h-8 w-full min-w-0 rounded-[7px] border border-border bg-bg-1 pl-2.5 pr-24 py-1.5 font-mono text-[13px] text-fg-2 outline-none transition-colors placeholder:text-fg-muted focus:border-accent disabled:cursor-not-allowed disabled:opacity-50"
                value={apiKey}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setFeedback(null);
                }}
                placeholder={
                  currentConfig?.hasApiKey
                    ? t(
                        "agentSettings.apiKeyPlaceholderSaved",
                        "•••••••••••••••• (已保存加密密钥，如需修改请直接输入)",
                      )
                    : t(
                        "agentSettings.apiKeyPlaceholderEmpty",
                        "请输入 API Key (例如 sk-...)",
                      )
                }
                autoComplete="off"
                spellCheck={false}
              />
              <div className="absolute right-1.5 flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="flex h-6 w-6 items-center justify-center rounded text-fg-muted hover:bg-bg-2 hover:text-fg"
                  title={
                    showApiKey
                      ? t("agentSettings.hideKey", "隐藏密钥")
                      : t("agentSettings.showKey", "显示密钥")
                  }
                  aria-label={
                    showApiKey
                      ? t("agentSettings.hideKey", "隐藏密钥")
                      : t("agentSettings.showKey", "显示密钥")
                  }
                >
                  {showApiKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
                {currentConfig?.hasApiKey && (
                  <button
                    type="button"
                    onClick={handleClearApiKey}
                    disabled={isClearing || isSaving}
                    className="flex h-6 items-center gap-1 rounded px-1.5 text-[11px] text-status-error hover:bg-status-error/10 disabled:opacity-50"
                    title={t("agentSettings.clearSavedKey", "清除已存密钥")}
                    aria-label={t("agentSettings.clearSavedKey", "清除已存密钥")}
                  >
                    <Trash2 size={12} />
                    <span>{t("agentSettings.clearKeyButton", "清除")}</span>
                  </button>
                )}
              </div>
            </div>
            <p className="text-[11px] text-fg-muted">
              {t(
                "agentSettings.apiKeyDescription",
                "API Key 将使用操作系统的加密钥匙串 (Electron safeStorage) 本地保存，绝不上传云端或明文存储。",
              )}
            </p>
          </div>

          {/* Feedback & Actions */}
          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            <div className="min-w-0 flex-1">
              {feedback && (
                <div
                  className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] ${
                    feedback.type === "success"
                      ? "border-status-success/30 bg-status-success/10 text-status-success"
                      : "border-status-error/30 bg-status-error/10 text-status-error"
                  }`}
                  role="alert"
                >
                  {feedback.type === "success" ? (
                    <CheckCircle2 size={14} className="shrink-0" />
                  ) : (
                    <AlertCircle size={14} className="shrink-0" />
                  )}
                  <span className="truncate">{feedback.message}</span>
                </div>
              )}
            </div>

            <Button
              label={
                isSaving
                  ? t("common.saving", "保存中...")
                  : t("agentSettings.saveButton", "保存设置")
              }
              onClick={handleSave}
              variant="primary"
              size="md"
              isLoading={isSaving}
              disabled={!isDesktop || isLoading || isSaving}
            />
          </div>
        </div>
      )}
    </div>
  );
};
