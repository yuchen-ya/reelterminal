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

Never print or `cat` the descriptor while diagnosing a connection. Read it only
inside the connector/client process and pass the token directly to the loopback
Authorization header. A descriptor left by an unclean exit may be stale, so
probe liveness without echoing credentials and let a newly prepared desktop
session replace it. Bypass system HTTP proxies for `127.0.0.1` and `localhost`.

No endpoint file means the GUI session is not ready; it does not select the
headless workflow. For normal user-facing creation, an Agent with local-app
control should launch ReelTerminal and complete the project/Agent Session steps
through the GUI. Otherwise it should ask the user to do so. Headless is used
only when the user explicitly asks for it or GUI-visible collaboration is not
part of the task.

When a project is already open, its format and current edits are user-provided
context. Continue in that project unless the user explicitly asks to replace it
or change format; do not hunt for a different project merely because another
aspect ratio seems more conventional.

The Agent and GUI edit the same canonical project with revision checks and one
undo history. Use `editor_get_context` before an edit; it includes current
selection, playhead, context revision, and stable numbered references (`#1`,
`#2`, …). If a referenced item has been deleted, it remains visibly stale and
its number is never rebound.

## Interactive edits stay light; delivery is explicit

An interactive change request gets the light loop: read only what the edit
needs, apply one atomic `edit_apply` batch, confirm once (the user is watching
the GUI), and reply. Do not save, export, poll jobs, run ffprobe, or extract
frame batches unless the user explicitly asked for a deliverable. The full
save → export → poll → verify → evidence pipeline runs only on that explicit
delivery request; the contract details live in
[`SKILL.md`](../SKILL.md#two-engagement-tiers-interactive-edits-vs-delivery).

## Keep every creation task in one workspace

Start by calling `capabilities_get`. Create one task directory under
`mediaImport.recommendedRoot/jobs`, following the fixed structure documented in
[`AGENT-WORKSPACE.md`](AGENT-WORKSPACE.md). Do not put generated assets,
recording frames, helper scripts, or finished videos in the repository root.
The desktop app creates the recommended `ReelTerminal Agent Workspace`
automatically; the older `ReelTerminal Agent Imports` path remains readable for
compatibility only.

## Current limit

The ReelTerminal-side conversation client is a protocol foundation only and is not
yet attached to a real external session transport. For now, converse in your
Agent's native window. ReelTerminal will not fall back to an embedded model.

For deterministic headless workflows without a GUI, the optional
`agent-video serve/run` facade transport remains documented in
[`SKILL.md`](../SKILL.md). It exposes editor tools; it does not choose a model,
store provider keys, or run an LLM inference loop.
