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

Frame-exact production tools (see
[MEDIA-REVIEW-WORKFLOWS.md](MEDIA-REVIEW-WORKFLOWS.md)) share the same
catalog: `reelctl frames extract`, `reelctl frames sheet`,
`reelctl video compare`, `reelctl patch apply`, and the candidate analysis
types via `reelctl media analyze --media-id m1 --type sceneCuts --type
blackFrames --type duplicateFrames`. `reelctl schema <command>` shows each
command's exact arguments.

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

## Production management

`media.production_list`, `batch.start`, `batch.get` and `batch.resume` are
discovered through the shared CLI/MCP catalog. `edit.apply` adds
`media.setProduction`; `media.replace` accepts `preserveFrames: true` for
verified CFR/frame-count preservation. See
[PRODUCTION-MANAGEMENT.md](PRODUCTION-MANAGEMENT.md) for shared GUI records,
review-to-board adoption, batch persistence boundaries and rendering details.
