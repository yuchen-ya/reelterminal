# Audit probes

Reproducible, read-only probes for the extraction audit at baseline
`2566c34e0f8ea22992a85f3ff16e048307b49365`. Pure Node ≥22.22, no package install
required (the monorepo ships TS sources directly; third-party imports are
stubbed by a loader hook so the real registry/action modules execute without
`node_modules`).

## Run (from repo root)

```sh
node --experimental-transform-types audit/probes/dump-tool-catalog.mjs
node --experimental-transform-types audit/probes/dump-action-map.mjs
```

## What each probe proves

| Probe | Proof |
| --- | --- |
| `dump-tool-catalog.mjs` | Loads `packages/agent/src/registry.ts` for real and dumps `toolDefs()` — the exact runtime registry (name/domain/flags/inputSchema). Cross-checks a static split of the `TOOLS` array (line spans, helper kind, `actionType`, `host.*` method usage, `@openreel/core` symbol usage) and parses every `implements EditingHost` class for a mechanical availability matrix. Fails loudly (`static_runtime_match: false`) if static and runtime disagree. |
| `dump-action-map.mjs` | Imports `action-executor.ts` (side-effect: registers all `handlers/*`), unions action types from all four dispatch layers (registry / executor switch / validator switch / inverse-generator switch), then live-probes `ActionValidator.validate(dummy)` and `invert(dummy)` per type. |

## Files

- `lib/scan.mjs` — comment-safe import-closure scanner + third-party stub planner (repo-relative paths only).
- `lib/openreel-loader.mjs` — ESM resolve/load hooks: maps `@openreel/*` to workspace sources, stubs third-party packages with inert proxies, neutralizes asset imports.
- `out/` — probe summaries (`tool-catalog-summary.json`, `action-map-summary.json`) regenerated on every run.

Outputs are written to `audit/tool-catalog.jsonl`, `audit/action-map.jsonl` and
`audit/probes/out/*.json`. The probes never write outside `audit/`.
