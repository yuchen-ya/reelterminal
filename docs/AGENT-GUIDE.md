# ReelTerminal external Agent guide

Start ReelTerminal, open a project, and enable **Agent Access**. Run:

```powershell
reelctl status
reelctl context --compact
reelctl requirements list --status ready --compact
reelctl schema edit.apply
reelctl help media inspect
```

Use [SKILL.md](../SKILL.md) for the editing workflow and
[AGENT-WORKSPACE.md](AGENT-WORKSPACE.md) before generating media.
[The CLI architecture decision](adr/0010-cli-command-api.md) describes the
contract, concurrency boundaries and migration.

For a source build, run `pnpm --filter @reelterminal/desktop build:main` and use
`node /absolute/path/to/apps/desktop/dist/reelctl/index.js` in place of `reelctl`.
Installed launchers live beside the application; use an absolute path if their
folder is not on PATH. The desktop does not change Agent configuration.

## MCP compatibility

Configure an MCP-capable Agent to launch `reelctl mcp serve`. Existing
`reelterminal-live-mcp` and `openreel-live-mcp` launcher names remain aliases.
The adapter obtains the live catalog and forwards to the authenticated Command
API. No desktop `/mcp` route or conversation adapter is required.

The endpoint descriptor is a credential. Never print it or copy its token to a
prompt. The client reads it privately and probes loopback liveness. A missing or
stale descriptor requires preparing the GUI, not switching to headless.

## Product boundary

Agents own installation, login, conversations, history and context compression.
ReelTerminal provides project/editor state and guarded editing commands. The
in-app conversation panel and three collaboration modes have been removed.
Read-only/write authorization remains independent. Voiceover/music submission
and retry through the old prompt channel are disabled; existing records and
artifacts are retained pending an independent task mechanism.
