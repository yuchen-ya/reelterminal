# The ReelTerminal data root

Managed user stores default to **one data root** so a user can find them,
back them up, and choose a new location. The root is created at first launch
and shown in **Settings → Storage**, which is also where it can be changed.
Files saved/imported outside this root retain their chosen locations.

## Layout

```text
<dataRoot>/                        default: <Videos>/ReelTerminal
  app-data/                        Electron userData profile:
                                   IndexedDB stores (project database, media
                                   bytes, the user-level material library),
                                   settings, live artifacts, caches
  projects/                        default save folder for .oreel projects
  agent-workspace/                 the Agent workspace;
                                   `capabilities.get` → `value.mediaImport.recommendedRoot`
    generated-assets/              persistent generated media, including
                                   audio-normalize/<jobId>/ WAV + provenance;
                                   referenced assets are not analysis caches
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

The current automatic move covers the Chromium `app-data/` profile and
`agent-workspace/`. It does not move existing `.oreel` files in `projects/`,
the reserved `logs/` folder, or arbitrary external originals. A new empty
`projects/` folder becomes the default for future Save As operations.
Stored absolute project-file/media references are not automatically rewritten.
Do not delete the previous location just because the profile move succeeded:
check file references, reopen moved project files, and verify file-backed Agent
preview/export tools before cleaning up originals. Old independent Chromium
profiles are not record-merged into a non-empty destination.

The startup prompt reads the active workspace at copy time. After the restart,
copy it again for the new workspace; the CLI executable path stays at the app's
installation location. `REELTERMINAL_AGENT_WORKSPACE_ROOT` can independently
override the workspace. A `REELTERMINAL_DATA_ROOT` override continues to win
over a location selected in Settings.

For the startup batch (`app-data/` and `agent-workspace/`):

- identical source/target paths or a missing source → no-op;
- all `app-data/` sources are handled before either workspace source;
- each store is copied through a `<target>.migrating` staging directory, then
  verified for file count and aggregate byte size before it is revealed; the
  original source remains in place;
- if a later store fails, the batch removes only targets it created earlier in
  that same attempt, then stops; the next attempt copies the then-current
  source contents again;
- a pre-existing non-empty target is never merged into, overwritten, or
  accepted as a verified copy based on file counts and byte totals. It is kept,
  the source is left in place, and the batch refuses to adopt the selected
  root;
- interrupted staging is removed and retried at the next launch.

Any failed item stops the batch. The app keeps using its previous root and
retries on the next launch; sources remain in place. The app adopts the
selected root only when the batch has no failed items. A small machine-config
marker records a completed source-preserving batch so retained backups are not
mistaken for a conflicting pre-existing target on later launches. An already
selected root with existing profile data remains an allowed no-migration case.
The low-level migration helper retains its same-volume rename fast path for
single-store use; the startup batch deliberately uses staged copies so one
store cannot be removed from the active root before the other store is ready.

## Uninstall

For a plain-language Windows backup and upgrade walkthrough, see
[Windows upgrade](WINDOWS-UPGRADE.md#english). Copy the complete profile
only while the app is closed; separately preserve external source media.

By default, the Windows uninstaller removes program files but preserves user-data
layers and the shared data-location configuration. Interactive uninstall shows
a preservation notice; silent uninstall and upgrades do not prompt for data
cleanup. Optional automatic data deletion is intentionally unavailable: the
cached NSIS recursive deletion follows nested directory junctions. No user-data
paths are enumerated or deleted by the custom hook. Review retained data and
clean it manually if needed. The live endpoint descriptor is left alone.

The standard electron-builder `--delete-app-data` command-line option is an
explicit exception: it separately removes the standard Windows AppData profile
folders. It is not a supported way to clean the configured data root or bypass
the legacy-upgrade guard. Do not interpret default preservation as a guarantee
under every command-line option.

Installers stop before invoking an existing uninstaller unless its registration
contains DataCleanupPolicyVersion=1. Older compiled uninstallers remain unsafe;
this guard is a conservative compatibility block, not an automatic migration.
Do not run an old uninstaller to bypass it. A supported migration is still needed.

Run the synthetic policy regressions with `pnpm --filter @reelterminal/desktop
test:installer`. On Windows, set `REELTERMINAL_NSIS_MAKENSIS` to the cached
makensis.exe to run native fixtures; missing or invalid paths fail on Windows.
Non-Windows runs only check static wiring and skip Windows fixtures. The Windows
Electron CI job uses `scripts/run-installer-policy-ci.mjs` to resolve the locked
electron-builder NSIS toolchain (reusing its cache or verified download path),
then runs the required native tests. Toolchain failures fail the job.
These fixtures are not evidence of an actual application install or upgrade.

## Related data

The desktop start screen's **Local projects** library indexes all stored
workspaces, including older local snapshots and recovery-only projects. The
title-bar project switcher retains a bounded list of ten recent projects.
Existing workspaces are authoritative; the newest recovery snapshot fills in
projects that have not yet entered the workspace index. Files elsewhere and
separate Chromium profiles are not automatically scanned.

Local projects support search, list/grid views, sorting, virtual folders,
renaming, independent copies, and bulk management. “Project size” measures the
current edit JSON, excluding source media and version history. Folders only
change grouping; deleting a folder moves its projects to Ungrouped.

New projects (including Agent-created projects) and independent copies avoid
existing names by adding ` 2`, ` 3`, and so on. Matching ignores surrounding
whitespace and letter case across folders, including the recycle bin but
excluding permanently deleted projects. Imports and legacy migrations preserve
their names. Manual renaming permits duplicate names; project and workspace IDs
remain the identities used by Agent commands, and users are responsible for
selecting the intended project when using duplicate names.

Delete moves a project, its workspaces, versions and recovery records to the
application recycle bin. Restore preserves them. Permanent deletion removes
the local snapshots and then cleans application-owned media only after checking
every retained project, recovery, history, material and task reference. External
originals, separately saved `.oreel` files and exported videos are not deleted.
Active playback is stopped before the current project is detached. Running
exports and Agent jobs block deletion; interrupted or completed task inputs do
not. Durable deletion markers prevent stale legacy saves from reappearing.

- The live endpoint descriptor is stored under `~/.reelterminal/`, outside the
  data root; see [`AGENT-GUIDE.md`](AGENT-GUIDE.md).
- Browser persistence identifiers are documented in
  [`NAMING-AND-COMPATIBILITY.md`](NAMING-AND-COMPATIBILITY.md).
