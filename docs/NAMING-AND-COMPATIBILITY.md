# Names and persisted identifiers

User-facing names use **ReelTerminal**. Workspace packages use the
`@reelterminal/*` scope; the desktop bridge is `window.reelterminal`; the live
CLI is `reelctl`; and standalone workflows use `reelterminal-agent`.
The `reelterminal-live-mcp` launcher invokes `reelctl mcp serve`.

## Configuration

Product configuration uses canonical `REELTERMINAL_*` and
`VITE_REELTERMINAL_*` names. Removed upstream cloud environment aliases are no
longer supported. Some explicit compatibility seams remain: the Blender
resolver still accepts `BLENDER_PATH` after `REELTERMINAL_BLENDER_PATH`, and the
MCP adapter exposes its catalog's compatibility tool aliases.
Cloud integrations require an explicit opt-in and a configured backend;
see [EXTERNAL-DEPENDENCIES.md](EXTERNAL-DEPENDENCIES.md).
No default deployment points at the upstream project's hosted services.

## Persisted and protocol identifiers

Browser persistence keys beginning with `openreel` remain unchanged. The current
GUI project picker accepts `.oreel` and `.json`; an older JSON project named
`.openreel` must use a supported extension to appear in that picker. Existing
serialized format markers are preserved. Their exact values are
registered in [physical-identifiers.ts](../packages/core/src/legacy/physical-identifiers.ts).
The `openreel-*` markers embedded in versioned protocol and generated asset
formats remain part of their data formats.

The live client discovers an owned `~/.openreel/live-endpoint.json` descriptor
only when the canonical `~/.reelterminal/live-endpoint.json` is absent, as
required by [AGENTS.md](../AGENTS.md). Ownership and loopback checks prevent
connecting to another product's endpoint.

These identifiers provide access to saved projects, assets, and live sessions.
Upstream copyright and license notices remain with the code and resources used.
