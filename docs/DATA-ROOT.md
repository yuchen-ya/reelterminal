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

Default root: `ReelTerminal` under the OS Videos folder. The root is outside
the installation directory so uninstall does not remove user data.

## Choosing a location

Precedence (see `apps/desktop/src/shared/data-root.ts`):

1. `REELTERMINAL_DATA_ROOT` — absolute path. An empty or relative value is
   ignored, same convention as
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

## Moving the data root

Data moves at startup, before the Chromium profile is first touched. The app
does not copy live, in-use data.

Per item (`apps/desktop/src/main/data-root-migration.ts`):

- missing source → no-op;
- non-empty target → never merged or overwritten; the item is skipped and
  the source is left in place, reported in Settings → Storage;
- fast path: directory rename;
- rename impossible (cross-volume/locked) → verified copy through a
  `<target>.migrating` staging directory, then one rename; the source remains
  as a backup;
- interrupted staging is removed and retried at the next launch.

If an item fails before any data has moved, the app keeps the source root and
retries next launch. If a later item fails, the app uses the selected root and
reports the remaining source items.

## Uninstall

The installer's uninstaller removes the program files as usual and then
offers layered cleanup (see `apps/desktop/build/installer.nsh`): projects +
app data, the Agent workspace, caches/logs — each with its own prompt, so
"keep my data" is still the default answer. The uninstaller reads
`<machineConfigDir>\uninstall-info.ini` (written by the app) to find the
root. `~/.reelterminal/live-endpoint.json` is a cross-process contract with
local CLI and compatibility connectors and is left alone.

## Related data

- The live endpoint descriptor is stored under `~/.reelterminal/`, outside the
  data root; see [`AGENT-GUIDE.md`](AGENT-GUIDE.md).
- Browser persistence identifiers are documented in
  [`NAMING-AND-COMPATIBILITY.md`](NAMING-AND-COMPATIBILITY.md).
