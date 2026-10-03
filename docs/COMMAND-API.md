# Command API

The desktop exposes the open project's command catalog on loopback. The GUI
owns the project; an external Agent reads and edits that same state through
`reelctl`.

## Access

The command service starts with read-only access when a project is open. Use
**Allow editing** in the status strip to grant write access and **Set
read-only** to revoke it. The endpoint token is a credential; clients read it
privately and must not print or log it.

## CLI

Use `reelctl` to inspect the session, get current context, discover commands,
validate changes, and apply edits:

```powershell
reelctl status
reelctl context --compact
reelctl schema edit.apply
reelctl edit validate --file validation.json
reelctl edit apply --file changes.json
```

Edit requests use the current project identity, project epoch, and revision.
The desktop applies a batch through the shared action history, so Agent edits
are visible in the GUI and can be undone there.

## MCP and headless sessions

MCP clients can start `reelctl mcp serve`. It uses the same command catalog and
live session as the CLI. The `reelterminal-live-mcp` and
`openreel-live-mcp` launchers are aliases for that command.

For a standalone workflow, use `reelterminal-agent` and configure its project,
media, artifact, and delivery roots. A headless session owns its own project;
it does not open or replace the desktop project.

Package-level API details are in
[`../packages/agent-facade/README.md`](../packages/agent-facade/README.md) and
[`../packages/runtime-chromium/README.md`](../packages/runtime-chromium/README.md).
