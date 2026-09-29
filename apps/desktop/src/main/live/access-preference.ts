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
  normalizeAgentAccessPreference,
  type AgentAccessPreference,
} from "@reelterminal/agent-facade";

const MAX_PREFERENCE_BYTES = 4_096;

export interface AgentAccessPreferenceStore {
  get(): AgentAccessPreference;
  set(preference: AgentAccessPreference): void;
  subscribe(listener: (preference: AgentAccessPreference) => void): () => void;
}

const readPreference = (
  filePath: string,
): { preference: AgentAccessPreference; canonical: boolean } => {
  try {
    if (statSync(filePath).size > MAX_PREFERENCE_BYTES) {
      return { preference: normalizeAgentAccessPreference(undefined), canonical: false };
    }
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
    const preference = normalizeAgentAccessPreference(parsed);
    const record =
      typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    return {
      preference,
      canonical:
        record.version === 2 &&
        record.access === preference.access,
    };
  } catch {
    return { preference: normalizeAgentAccessPreference(undefined), canonical: false };
  }
};

const writePreference = (
  filePath: string,
  preference: AgentAccessPreference,
): void => {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  try {
    writeFileSync(
      temporary,
      JSON.stringify({ version: 2, ...preference }, null, 2),
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

/** Main-process persisted source of truth for Agent access. */
export function createAgentAccessPreferenceStore(
  filePath: string,
): AgentAccessPreferenceStore {
  const loaded = readPreference(filePath);
  let current = loaded.preference;
  const listeners = new Set<(preference: AgentAccessPreference) => void>();

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
      const normalized = normalizeAgentAccessPreference(preference);
      if (
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
