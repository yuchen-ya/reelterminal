/**
 * How proactively the external Agent collaborates with the user.
 *
 * Work mode is intentionally not an authorization primitive. It changes the
 * Agent's default initiative and alignment density; the live session access
 * boundary and writer lease continue to decide whether mutations are allowed.
 */
export const AGENT_WORK_MODES = [
  "guided",
  "collaborative",
  "autonomous",
] as const;

export type AgentWorkMode = (typeof AGENT_WORK_MODES)[number];

export type AgentAccessMode = "read-only" | "write";

/** Legacy combined collaboration modes, retained only for safe migration. */
export type LegacyAgentMode = "observe" | "assist" | "autonomous";

export interface AgentWorkModeSemantics {
  readonly id: AgentWorkMode;
  readonly label: "Guided" | "Collaborative" | "Autonomous";
  readonly summary: string;
  readonly deliveryRequiresExplicitAuthorization: true;
}

export const DEFAULT_AGENT_WORK_MODE: AgentWorkMode = "collaborative";
export const DEFAULT_AGENT_ACCESS_MODE: AgentAccessMode = "write";

export const AGENT_WORK_MODE_SEMANTICS: Readonly<
  Record<AgentWorkMode, AgentWorkModeSemantics>
> = {
  guided: {
    id: "guided",
    label: "Guided",
    summary:
      "Propose sensible defaults first, ask only a few high-value questions, explain consequential choices, preview before expensive work, and invite a full review of the first cut.",
    deliveryRequiresExplicitAuthorization: true,
  },
  collaborative: {
    id: "collaborative",
    label: "Collaborative",
    summary:
      "Work as the user's peer: perform low-risk reversible actions, align on uncertain creative direction, high cost, or large changes, and follow complete user plans without tutorial detours.",
    deliveryRequiresExplicitAuthorization: true,
  },
  autonomous: {
    id: "autonomous",
    label: "Autonomous",
    summary:
      "Make most research, selection, and production decisions while exposing important assumptions and watchable results, preserving recovery points, and stopping at capability or major-risk boundaries.",
    deliveryRequiresExplicitAuthorization: true,
  },
};

export interface AgentModePreference {
  readonly workMode: AgentWorkMode;
  readonly access: AgentAccessMode;
}

export function isAgentWorkMode(value: unknown): value is AgentWorkMode {
  return (
    typeof value === "string" &&
    (AGENT_WORK_MODES as readonly string[]).includes(value)
  );
}

export function isAgentAccessMode(value: unknown): value is AgentAccessMode {
  return value === "read-only" || value === "write";
}

export function agentWorkModeSemantics(
  mode: AgentWorkMode,
): AgentWorkModeSemantics {
  return AGENT_WORK_MODE_SEMANTICS[mode];
}

/**
 * Safely migrate the old mode that mixed collaboration style with access.
 * Observe must remain read-only; renaming it to Guided may not grant writes.
 */
export function migrateLegacyAgentMode(mode: LegacyAgentMode): AgentModePreference {
  switch (mode) {
    case "observe":
      return { workMode: "guided", access: "read-only" };
    case "assist":
      return { workMode: "collaborative", access: "write" };
    case "autonomous":
      return { workMode: "autonomous", access: "write" };
  }
}

/** Parse persisted preferences without ever widening a legacy read-only mode. */
export function normalizeAgentModePreference(value: unknown): AgentModePreference {
  if (value === "observe" || value === "assist" || value === "autonomous") {
    return migrateLegacyAgentMode(value);
  }
  if (isAgentWorkMode(value)) {
    return { workMode: value, access: DEFAULT_AGENT_ACCESS_MODE };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {
      workMode: DEFAULT_AGENT_WORK_MODE,
      access: DEFAULT_AGENT_ACCESS_MODE,
    };
  }
  const record = value as Record<string, unknown>;
  const legacy = record.mode;
  if (legacy === "observe" || legacy === "assist" || legacy === "autonomous") {
    return migrateLegacyAgentMode(legacy);
  }
  return {
    workMode: isAgentWorkMode(record.workMode)
      ? record.workMode
      : DEFAULT_AGENT_WORK_MODE,
    access: isAgentAccessMode(record.access)
      ? record.access
      : DEFAULT_AGENT_ACCESS_MODE,
  };
}
