import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import {
  normalizeAgentModePreference,
  type AgentModePreference,
} from "@openreel/agent-facade";

const MAX_PREFERENCE_BYTES = 4_096;

export interface AgentModePreferenceStore {
  get(): AgentModePreference;
  set(preference: AgentModePreference): void;
  subscribe(listener: (preference: AgentModePreference) => void): () => void;
}

const readPreference = (
  filePath: string,
): { preference: AgentModePreference; canonical: boolean } => {
  try {
    if (statSync(filePath).size > MAX_PREFERENCE_BYTES) {
      return { preference: normalizeAgentModePreference(undefined), canonical: false };
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const preference = normalizeAgentModePreference(parsed);
    const record =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return {
      preference,
      canonical:
        record.version === 1 &&
        record.workMode === preference.workMode &&
        record.access === preference.access,
    };
  } catch {
    return { preference: normalizeAgentModePreference(undefined), canonical: false };
  }
};

const writePreference = (
  filePath: string,
  preference: AgentModePreference,
): void => {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ version: 1, ...preference }, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
};

/** Main-process persisted source of truth for Agent work mode and access. */
export function createAgentModePreferenceStore(
  filePath: string,
): AgentModePreferenceStore {
  const loaded = readPreference(filePath);
  let current = loaded.preference;
  const listeners = new Set<(preference: AgentModePreference) => void>();

  // Canonicalize legacy observe/assist/autonomous files immediately. The
  // observe migration retains read-only access, so this never widens rights.
  if (!loaded.canonical) {
    try {
      writePreference(filePath, current);
    } catch {
      // Persistence can be unavailable; the in-memory preference remains valid.
    }
  }

  return {
    get: () => ({ ...current }),
    set: (preference) => {
      const normalized = normalizeAgentModePreference(preference);
      if (
        normalized.workMode === current.workMode &&
        normalized.access === current.access
      ) {
        return;
      }
      writePreference(filePath, normalized);
      current = normalized;
      for (const listener of listeners) listener({ ...current });
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
