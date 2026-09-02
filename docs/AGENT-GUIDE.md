# ReelTerminal external Agent guide

ReelTerminal does not bundle a conversational Agent or generative model and does
not manage conversations. Use the Agent you already trust for its chat,
model, credentials, permissions, and history;
connect that Agent to the open ReelTerminal desktop project through MCP.

## Connect to the open desktop project

1. Build the desktop main process:

   ```sh
   corepack pnpm --filter @openreel/desktop build:main
   ```

2. Open a project and enable **Agent Session** in the collaboration bar.
3. Configure your Agent's MCP client to launch:

   ```text
   node /absolute/path/to/apps/desktop/dist/live-mcp/index.js
   ```

The connector reads `~/.openreel/live-endpoint.json`, forwards stdio MCP to
the authenticated loopback endpoint, and exposes exactly the 17 live tools
listed in the root [`SKILL.md`](../SKILL.md). Do not copy the endpoint token
into prompts, project files, or logs.

The Agent and GUI edit the same canonical project with revision checks and one
undo history. Use `editor_get_context` before an edit; it includes current
selection, playhead, context revision, and stable numbered references (`#1`,
`#2`, …). If a referenced item has been deleted, it remains visibly stale and
its number is never rebound.

## Current limit

The ReelTerminal-side conversation client is a protocol foundation only and is not
yet attached to a real external session transport. For now, converse in your
Agent's native window. ReelTerminal will not fall back to an embedded model.

For deterministic headless workflows without a GUI, the optional
`agent-video serve/run` facade transport remains documented in
[`SKILL.md`](../SKILL.md). It exposes editor tools; it does not choose a model,
store provider keys, or run an LLM inference loop.
