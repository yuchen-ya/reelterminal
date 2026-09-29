# The ReelTerminal data root

Everything user-scoped lives under **one relocatable data root** so a user can
find it, move it to another drive, back it up, and decide at uninstall time
what stays. The root is created at first launch and shown in **Settings →
Storage**, which is also where it can be changed.

## Layout

```text
<dataRoot>/                        default: <Videos>/ReelTerminal
  app-data/                        Electron userData profile:
                                   IndexedDB stores (project database, media
                                   bytes, the user-level material library),
                                   settings, live artifacts, caches
  projects/                        default save folder for .oreel projects
  agent-workspace/                 the Agent workspace (jobs/ + shared/);
                                   `capabilities_get.mediaImport.recommendedRoot`
  logs/                            reserved
```

Default root: `ReelTerminal` under the OS Videos folder (a media app's data
belongs next to media; it also keeps the legacy Agent workspace on the same
volume so adopting it is an atomic rename). The root is deliberately NOT
under the installation directory — uninstall must never be the thing that
deletes user data.

## Choosing a location

Precedence (see `apps/desktop/src/shared/data-root.ts`):

1. `REELTERMINAL_DATA_ROOT` — absolute path, no legacy alias (new knob). An
   empty or relative value is ignored, same convention as
   `REELTERMINAL_AGENT_WORKSPACE_ROOT`.
2. The pointer file `<machineConfigDir>/data-root.json` written by
   Settings → Storage ("Change data folder"). `<machineConfigDir>` is
   `%LOCALAPPDATA%\ReelTerminal` on Windows,
   `~/Library/Application Support/ReelTerminal` on macOS,
   `$XDG_CONFIG_HOME/ReelTerminal` (or `~/.config/ReelTerminal`) elsewhere.
   It sits OUTSIDE the root so it can be found before the root is known.
3. The default under Videos.

`REELTERMINAL_USER_DATA_DIR` remains the isolated-test seam: when set, the
data-root machinery is bypassed entirely and userData points where it says.

## Migration

Data moves only at startup, **before the Chromium profile is first touched**
(never a live copy of in-use data). Sources are, in order: the previous root
recorded in the pointer when the user changed the location, then the
pre-data-root flat locations (`%APPDATA%\@reelterminal\desktop` as Electron's
old default userData, and `Videos\ReelTerminal Agent Workspace`).

Per item (`apps/desktop/src/main/data-root-migration.ts`):

- missing source → no-op (fresh installs never migrate);
- non-empty target → never merged or overwritten; the item is skipped and
  the source is left in place, reported in Settings → Storage;
- fast path: directory rename (atomic-ish, leaves no copy behind);
- rename impossible (cross-volume/locked) → verified copy through a
  `<target>.migrating` staging directory (file-count + byte parity), revealed
  with one rename; the source is kept as the backup — nothing is deleted;
- an interrupted copy leaves only staging, which the next run drops and
  retries; reruns are idempotent.

If an item fails and nothing has moved yet, the session abstains: it runs
from the previous location and retries next launch. If a later item fails
after earlier moves, the session adopts the root (the data is already there)
and reports the leftovers.

## Uninstall

The installer's uninstaller removes the program files as usual and then
offers layered cleanup (see `apps/desktop/build/installer.nsh`): projects +
app data, the Agent workspace, caches/logs — each with its own prompt, so
"keep my data" is still the default answer. The uninstaller reads
`<machineConfigDir>\uninstall-info.ini` (written by the app) to find the
root. `~/.reelterminal/live-endpoint.json` is a cross-process contract with
local CLI and compatibility connectors and is left alone.

## Not (yet) in the root

- The endpoint descriptors under `~/.reelterminal/` — external contract, see
  `AGENT-GUIDE.md`.
- Physical storage identifiers (`openreel-*` database/key names) are legacy
  by policy (`NAMING-AND-COMPATIBILITY.md` §4) and unchanged here; a rename
  is a separate, versioned migration decision.
