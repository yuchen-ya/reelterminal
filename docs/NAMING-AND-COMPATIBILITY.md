# Names and compatibility

New user-facing names use **ReelTerminal**. Workspace packages use the
`@reelterminal/*` scope; the desktop bridge is `window.reelterminal`; the live
CLI is `reelctl`; and standalone workflows use `reelterminal-agent`.

## Supported aliases

| Current name | Compatible name | Behavior |
|---|---|---|
| `window.reelterminal` | `window.openreel` | Both expose the same desktop bridge. |
| `reelterminal-live-mcp` | `openreel-live-mcp` | Starts the same `reelctl mcp serve` adapter. |
| `reelterminal-agent` | `agent-video` | Starts the same headless CLI. |
| `~/.reelterminal/live-endpoint.json` | `~/.openreel/live-endpoint.json` | An owned legacy endpoint may be discovered when the canonical file is absent. |
| `REELTERMINAL_*` environment names | Explicit `OPENREEL_*` aliases | The current name takes precedence when both are defined. |
| `VITE_REELTERMINAL_*` environment names | Explicit `VITE_OPENREEL_*` aliases | The current name takes precedence when both are defined. |

Only aliases implemented at their call sites are supported. The desktop uses
the shared environment resolver; web cloud settings use
[`api-endpoints.ts`](../apps/web/src/config/api-endpoints.ts). An empty value
counts as set for resolver pairs; URL settings may separately treat empty as
unset.

## Persisted and protocol identifiers

Existing project files with the `.openreel` extension and browser persistence
keys beginning with `openreel` remain readable. Their exact values are
registered in [`physical-identifiers.ts`](../packages/core/src/legacy/physical-identifiers.ts).
The `openreel-*` markers embedded in versioned protocol and generated asset
formats also remain part of their data formats.

Do not rename persisted keys, project extensions, or versioned protocol markers
without preserving access to existing projects and assets.

## External service names

Configured service URLs remain their actual deployment addresses, including
`openreel.video` hosts. They are runtime endpoints, not product branding. See
[`EXTERNAL-DEPENDENCIES.md`](EXTERNAL-DEPENDENCIES.md) for current network
behavior.
