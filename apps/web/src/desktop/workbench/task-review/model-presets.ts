export interface ModelProviderPreset {
  id: string;
  label: string;
  endpoint: string;
  models: readonly string[];
}

export const MODEL_PROVIDER_PRESETS: readonly ModelProviderPreset[] = [
  {
    id: "magpie",
    label: "Magpie (本地 Pi 代理)",
    endpoint: "http://127.0.0.1:3425/v1",
    models: [
      "deepseek/deepseek-flash",
      "deepseek/deepseek-v4-pro",
      "openrouter/tencent/hy4",
      "openrouter/moonshotai/kimi-k3.1-pro",
      "openrouter/minimax/minimax-m3.1-flash",
      "amd/DeepSeek-V4.1-Flash",
      "openai/gpt-6.1-sol",
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    endpoint: "https://api.deepseek.com",
    models: [
      "deepseek-chat",
      "deepseek-reasoner",
      "deepseek-flash",
      "deepseek-v4-pro",
    ],
  },
  {
    id: "openai",
    label: "OpenAI",
    endpoint: "https://api.openai.com/v1",
    models: ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini", "gpt-6-luna"],
  },
  {
    id: "siliconflow",
    label: "硅基流动 (SiliconFlow)",
    endpoint: "https://api.siliconflow.cn/v1",
    models: ["deepseek-ai/DeepSeek-V3", "Qwen/Qwen2.5-72B-Instruct"],
  },
  {
    id: "dashscope",
    label: "阿里云百炼 (DashScope)",
    endpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    models: ["qwen-max", "qwen-plus", "deepseek-v3"],
  },
  {
    id: "qwen-token-plan-cn",
    label: "百炼 Token Plan (阿里云国内)",
    endpoint: "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    models: [
      "deepseek-v4.1-flash",
      "deepseek-v4-pro",
      "deepseek-v3.2",
      "qwen-max",
      "qwen-plus",
    ],
  },
  {
    id: "kimi-coding",
    label: "Kimi Coding (月之暗面)",
    endpoint: "https://api.kimi.com/coding/v1",
    models: ["k3.1-pro", "k3.1-pro-highspeed", "k3", "k3-256k", "kimi-for-coding"],
  },
  {
    id: "moonshotai-cn",
    label: "Moonshot AI (国内)",
    endpoint: "https://api.moonshot.cn/v1",
    models: ["kimi-k3.1-pro", "kimi-k3", "kimi-k2.7-code"],
  },
  {
    id: "zai-coding-cn",
    label: "智谱 GLM Coding (国内)",
    endpoint: "https://open.bigmodel.cn/api/coding/paas/v4",
    models: ["glm-5.3", "glm-5.3-flash", "glm-4.6v"],
  },
  {
    id: "minimax-cn",
    label: "MiniMax (国内)",
    endpoint: "https://api.minimaxi.com/anthropic",
    models: ["MiniMax-M3.1-Flash", "MiniMax-M3", "MiniMax-M2.7"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1",
    models: [
      "anthropic/claude-3.7-sonnet",
      "google/gemini-2.5-pro",
      "deepseek/deepseek-chat-v3-0324",
      "deepseek/deepseek-r1",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    endpoint: "https://api.anthropic.com",
    models: [
      "claude-3-7-sonnet-20250219",
      "claude-3-5-sonnet-20241022",
      "claude-haiku-4-5",
    ],
  },
  {
    id: "google",
    label: "Google Gemini",
    endpoint: "https://generativelanguage.googleapis.com/v1beta",
    models: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.5-flash-lite"],
  },
  {
    id: "groq",
    label: "Groq",
    endpoint: "https://api.groq.com/openai/v1",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    endpoint: "https://api.x.ai/v1",
    models: ["grok-4.5", "grok-4.3"],
  },
  {
    id: "together",
    label: "Together AI",
    endpoint: "https://api.together.ai/v1",
    models: [
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "meta-models/Muse-Spark-Open-816B-A42B",
    ],
  },
  {
    id: "ollama",
    label: "本地 Ollama",
    endpoint: "http://127.0.0.1:11434/v1",
    models: ["qwen2.5:14b", "deepseek-r1:14b", "llama3.1:8b"],
  },
  {
    id: "custom",
    label: "自定义 (OpenAI 兼容)",
    endpoint: "",
    models: [],
  },
];

export function detectProviderPreset(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  if (!trimmed) return "custom";

  // Exact or prefix match first
  for (const preset of MODEL_PROVIDER_PRESETS) {
    if (preset.id === "custom" || !preset.endpoint) continue;
    const presetNorm = preset.endpoint.replace(/\/+$/, "");
    if (trimmed === presetNorm || trimmed.startsWith(presetNorm)) {
      return preset.id;
    }
  }

  // Domain/port based fuzzy match
  if (trimmed.includes(":3425")) return "magpie";
  if (trimmed.includes("api.deepseek.com")) return "deepseek";
  if (trimmed.includes("api.openai.com")) return "openai";
  if (trimmed.includes("siliconflow.cn")) return "siliconflow";
  if (trimmed.includes("token-plan.")) return "qwen-token-plan-cn";
  if (trimmed.includes("dashscope.aliyuncs.com")) return "dashscope";
  if (trimmed.includes("api.kimi.com/coding")) return "kimi-coding";
  if (trimmed.includes("moonshot.cn")) return "moonshotai-cn";
  if (trimmed.includes("bigmodel.cn")) return "zai-coding-cn";
  if (trimmed.includes("minimaxi.com")) return "minimax-cn";
  if (trimmed.includes("openrouter.ai")) return "openrouter";
  if (trimmed.includes("api.anthropic.com")) return "anthropic";
  if (trimmed.includes("googleapis.com")) return "google";
  if (trimmed.includes("groq.com")) return "groq";
  if (trimmed.includes("api.x.ai")) return "xai";
  if (trimmed.includes("together.ai")) return "together";
  if (trimmed.includes(":11434")) return "ollama";

  return "custom";
}

export function getProviderPreset(id: string): ModelProviderPreset | undefined {
  return MODEL_PROVIDER_PRESETS.find((preset) => preset.id === id);
}
