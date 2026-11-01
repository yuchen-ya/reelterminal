import type { TOptions } from "i18next";
import i18n from ".";

interface MessageTemplate { key: string; parts: string[]; names: string[]; weight: number }
let catalog: { exact: Map<string, string>; templates: MessageTemplate[] } | undefined;

function messageCatalog() {
  if (catalog) return catalog;
  const exact = new Map<string, string>();
  const templates: MessageTemplate[] = [];
  for (const locale of ["en", "zh-CN"]) {
    const entries = i18n.getResourceBundle(locale, "translation") as Record<string, unknown>;
    for (const [key, value] of Object.entries(entries)) {
      if (typeof value !== "string") continue;
      const names: string[] = [];
      const parts = value.split(/{{\s*([\w]+)(?:,[^}]*)?\s*}}/g).filter((part, index) => {
        if (index % 2) { names.push(part); return false; }
        return true;
      });
      if (!names.length) {
        if (!exact.has(value)) exact.set(value, key);
      } else {
        const weight = parts.reduce((sum, part) => sum + part.length, 0);
        // An unconstrained placeholder is user data, not an identifiable UI message.
        if (weight >= 8 && parts.slice(1, -1).every(Boolean)) templates.push({ key, parts, names, weight });
      }
    }
  }
  templates.sort((a, b) => b.weight - a.weight);
  return catalog = { exact, templates };
}

/** Linear full-message matching; captured names, paths and user text remain untouched. */
function valuesFor(message: string, { parts, names }: MessageTemplate): Record<string, string> | undefined {
  if (!message.startsWith(parts[0]) || !message.endsWith(parts.at(-1)!)) return;
  const values: Record<string, string> = {};
  let offset = parts[0].length;
  for (let index = 0; index < names.length; index++) {
    const next = parts[index + 1];
    const end = index === names.length - 1 ? message.length - next.length : message.indexOf(next, offset);
    if (end < offset) return;
    const value = message.slice(offset, end), name = names[index];
    if (Object.hasOwn(values, name) && values[name] !== value) return;
    values[name] = value;
    offset = end + next.length;
  }
  return offset === message.length ? values : undefined;
}

/**
 * Presentation boundary for transient app errors, progress and toasts only.
 * Existing messages can survive a language switch; never call this for saved
 * board/task names, document text, Agent output or persisted handoff identities.
 */
// Older migrated call sites use positional placeholders. New diagnostic messages
// should name these arguments error/reason. Captured user names/paths are never translated.
const ERROR_ARGUMENTS: Readonly<Record<string, readonly string[]>> = {
  "Task “{{v0}}” was created, but file import failed: {{v1}}": ["v1"],
  "{{v0}} failed: {{v1}}": ["v1"],
  "Publication failed: {{v0}}": ["v0"],
  "Submission failed: {{v0}}": ["v0"],
  "Execution failed: {{v0}}": ["v0"],
  "Reopening failed: {{v0}}": ["v0"],
  "Failed {{v0}}: {{v1}}": ["v1"],
  "Skipped {{v0}}: {{v1}}": ["v1"],
  "Review again: {{v0}}": ["v0"],
  "{{v0}} (draft preserved)": ["v0"],
  "The new version has not loaded. Showing the previous loaded image: {{v0}}": ["v0"],
  "The repair is unavailable. Showing the original: {{v0}}": ["v0"],
  "Review content has not loaded; the latest version is not shown: {{v0}}": ["v0"],
  "Output reference scanning failed; all intermediate files are retained: {{v0}}": ["v0"],
};

function knownMessage(message: string, depth: number): string | undefined {
  if (i18n.exists(message)) return i18n.t(message);
  const { exact, templates } = messageCatalog();
  const key = exact.get(message);
  if (key) return i18n.t(key);
  for (const template of templates) {
    const values = valuesFor(message, template);
    if (!values) continue;
    if (depth < 2) {
      const english = i18n.getResource("en", "translation", template.key) ?? template.key;
      for (const name of new Set(["error", "reason", ...(ERROR_ARGUMENTS[String(english)] ?? [])])) {
        if (values[name]) values[name] = localizeMessage(values[name], depth + 1);
      }
    }
    return i18n.t(template.key, values);
  }
  return undefined;
}

function localizeMessage(message: string, depth: number): string {
  if (!message || message.length > 16_384) return message;
  const translated = knownMessage(message, depth);
  if (translated !== undefined) return translated;
  // Electron wraps rejected invoke errors. Only strip the wrapper when its
  // complete inner message is recognized; unknown diagnostics remain verbatim.
  const wrapped = /^Error invoking remote method '[^'\r\n]+': (?:Error: )?([\s\S]+)$/.exec(message);
  return wrapped ? knownMessage(wrapped[1], depth) ?? message : message;
}

export function localizeUiMessage(message: string): string {
  return localizeMessage(message, 0);
}

/** Canonical app-generated metadata/error text; locale is applied only at the UI boundary. */
export function uiMessage(key: string, values?: TOptions): string {
  return i18n.t(key, { ...values, lng: "en" });
}
