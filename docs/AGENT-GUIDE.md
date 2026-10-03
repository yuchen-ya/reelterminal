# ReelTerminal external Agent guide

Start ReelTerminal and open a project. The command service becomes available
automatically with read-only access. For edits, click the **Agent · Read-only** button in the status strip. It switches
to **Agent · Editable**; click again to revoke write access. Run:

```powershell
reelctl status
reelctl context --compact
reelctl requirements list --status ready --compact
reelctl schema edit.apply
reelctl help media inspect
```

Use [SKILL.md](../SKILL.md) for the editing workflow and
[AGENT-WORKSPACE.md](AGENT-WORKSPACE.md) before generating media.
See [COMMAND-API.md](COMMAND-API.md) for the live service and CLI contract.

For a source build, run `pnpm --filter @reelterminal/desktop build:main` and use
`node /absolute/path/to/apps/desktop/dist/reelctl/index.js` in place of `reelctl`.
Installed launchers live beside the application; use an absolute path if their
folder is not on PATH. The desktop does not change Agent configuration.

## MCP compatibility

Configure an MCP-capable Agent to launch `reelctl mcp serve`. Existing
`reelterminal-live-mcp` and `openreel-live-mcp` launcher names remain aliases.
The adapter obtains the live catalog and forwards to the authenticated Command
API.

The endpoint descriptor is a credential. Never print it or copy its token to a
prompt. The client reads it privately and probes loopback liveness. A missing or
stale descriptor requires preparing the GUI, not switching to headless.

## Product boundary

Agents own installation, login, conversations, history and context compression.
ReelTerminal provides project state, editor context, and guarded editing
commands. Voiceover and music generation are handled by the external Agent;
import generated files as ordinary media.

## Board and project assets

The **Board** stores tasks for external agents to pull; publishing a task does
not launch an agent. Use `reelctl requirements get Q1` to read the full task,
including its execution instruction, acceptance criteria, and `references`.
Each reference persists its entity kind and ID plus an A-label/name/time snapshot;
resolve by kind and ID, since A numbers belong to the original editor session.
`workAsset` references identify saved clips or combinations in `project.workAssets`.

Report work with `requirement.update`, using `in_progress`, `blocked` (with an
explanation in `agentNote`), or `review` (with notes and `resultMediaIds`). Agent
updates using `done` also enter `review`; the user confirms completion in the
Board. Existing completed tasks remain completed.

**Project assets** combines source media with saved clips and combinations.
Import external files, or save a named timeline selection from the same panel.
Saved clips reference their source media and retain supported edit parameters;
removing a saved clip does not delete the source. The separate **Personal library**
continues to hold cross-project materials.
