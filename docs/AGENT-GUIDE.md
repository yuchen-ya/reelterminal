# ReelTerminal external Agent guide

The first time you allow editing in each app launch, a notification appears at
the top right. Click it to copy a startup prompt for your external Agent. It
includes this installation's absolute CLI command, the Agent workspace, and
initial status/context/capabilities commands. It contains no endpoint token.

The prompt is generated when you click Copy, using the running installation's
paths. Windows commands use PowerShell; macOS/Linux commands use a POSIX shell.
For development builds, the command requires the documented Node.js version on
PATH. Packaged commands use Electron's included Node runtime.

The CLI path follows the installation, while the workspace normally follows
`<dataRoot>/agent-workspace`. Changing Settings → Storage requires restarting
the app before the new workspace becomes active. Copy a new prompt after that
restart; text already sent to an Agent does not update itself. An absolute
`REELTERMINAL_AGENT_WORKSPACE_ROOT` override takes precedence over the default
workspace, and `REELTERMINAL_DATA_ROOT` takes precedence over the Settings
pointer. `capabilities.get` remains authoritative for the active media roots.

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
Windows packaged launchers live beside the application; use an absolute path if
their folder is not on PATH. macOS/Linux packaged prompts invoke the installed
Electron executable with `ELECTRON_RUN_AS_NODE=1` and the CLI entry in app.asar.
The desktop does not change Agent configuration.

## MCP compatibility

Configure an MCP-capable Agent to launch the CLI with `mcp serve` arguments. The
Windows `reelterminal-live-mcp.cmd` launcher invokes that adapter. Use a real
absolute path; neither a source checkout nor the installer guarantees a global
`reelctl` command on PATH.
The adapter obtains the live catalog and forwards to the authenticated Command
API.

For clients with a stdio configuration shaped as `command`, `args` and `env`,
this Windows packaged example invokes the bundled runtime directly, without
depending on the client's handling of `.cmd` files. Replace both paths with
your actual installation and adapt the surrounding configuration to your client:

```json
{
  "mcpServers": {
    "reelterminal": {
      "command": "C:\\Program Files\\ReelTerminal\\ReelTerminal.exe",
      "args": [
        "C:\\Program Files\\ReelTerminal\\resources\\app.asar\\dist\\reelctl\\index.js",
        "mcp", "serve"
      ],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

For a source build, use `node` as command and the absolute built CLI entry as
the first argument, followed by `mcp`, `serve`; omit that Electron environment
variable. For macOS/Linux packages, use the executable and entry paths from the
copied prompt with the same arguments and Electron environment variable.

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
