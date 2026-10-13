/**
 * Public exports of the performance contract layer (design phase P0).
 *
 * Everything here is types and pure functions plus the NOOP/sink slot —
 * safe to import from any process role without pulling UI or Node
 * dependencies into the graph.
 */
export * from "./types";
export * from "./noop";
export * from "./sink";
