/**
 * Creation scene schema — the planning layer for agent-ifying the native
 * creation engine (`packages/creation-core` / `packages/creation-bindings`,
 * still live in the desktop renderer). It has had no in-repo consumer since
 * the creation-agent verbs were removed; it is kept deliberately, and its
 * disposition criterion is registered in docs/CLEANUP-DECISIONS-2026-09.md.
 */
export * from "./types";
export * from "./primitives";
export * from "./product-cinematic";
export * from "./validate";
