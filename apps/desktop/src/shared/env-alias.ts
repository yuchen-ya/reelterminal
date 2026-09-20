/**
 * Single env alias resolver for the desktop main process and connector
 * (docs/NAMING-AND-COMPATIBILITY.md §3). Resolution order for variables that
 * keep a legacy fallback:
 *
 * 1. new `REELTERMINAL_*` name set (`!== undefined`, an empty string counts
 *    as set-and-empty) → use the new value;
 * 2. else legacy `OPENREEL_*` name set → use the legacy value;
 * 3. else `undefined` — the call site keeps its own default / empty-value
 *    semantics exactly as before (length checks, `path.isAbsolute`, trim).
 *
 * New variables must not bypass this helper with raw `OPENREEL_*` reads.
 */
export function readEnvAlias(
  env: NodeJS.ProcessEnv,
  newName: string,
  oldName: string,
): string | undefined {
  const next = env[newName];
  if (next !== undefined) return next;
  return env[oldName];
}
