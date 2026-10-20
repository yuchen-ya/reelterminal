# Attended Windows legacy migration

This is a one-off recovery procedure, not automatic upgrade support. Existing
uninstallers are immutable and may delete shared data-location settings. Do not
run them, add a false policy marker, or remove the installer guard to proceed.

Before changing registration:

1. Obtain authorization for the exact current-user registration and shortcuts.
   Reject unknown products, other users and machine-wide installations. Inspect
   both registry views. A malformed installation path requires explicit,
   independent identification of the old payload; do not guess its location.
2. Identify the active data root and writers. Do not terminate a user's service.
   Back up the quiescent complete profile, database journals/WAL/blob files,
   saved projects and root configuration outside installation and data roots.
   Hash the snapshot and verify recovery on a separate copy with the appropriate
   database engines. State which media is excluded and the snapshot date.
3. Export both current-user registration keys and copy existing desktop/start
   menu shortcut bytes. Record absence too. Re-read these objects immediately
   before each mutation. Keep a durable journal outside the installation tree.
4. Require a new, empty installation destination with no reparse-point ancestors,
   a verified candidate hash and no running ReelTerminal instance. Preserve the
   old installation directory and every original data file.

For ReelTerminal's current app ID `video.reelterminal.desktop`, the two keys are:

- `HKCU\Software\028d27d5-c5ef-571c-a449-30084a704a54`
- `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\028d27d5-c5ef-571c-a449-30084a704a54`

Temporarily detach only these verified registrations, then run the **new**
installer with a properly quoted Windows destination and current-user scope.
Do not invoke the old uninstall command. Do not auto-launch the user's profile.
Record each completed step. On success, verify both new registrations, shortcut
targets, installed payload/source identity, unchanged root configuration and
retained old payload. Test the new installation with a private profile/endpoint
and synthetic projects or a separate recovery copy.

Before the new installer starts, a detached key may be restored only while it
remains absent; preserve intervening changes to other objects. Once the installer
has started, an unsuccessful or uncertain outcome requires inspection: do not
blindly import old registry exports or overwrite shortcuts. Their writes cannot
be attributed safely to this operation merely because they differ from the
snapshot. Keep the journal and partial new directory; never use an uninstaller
as rollback. Registry comparisons are not an atomic transaction against external
editors. An interrupted handoff is recoverable from the snapshots but may require
attended repair.

`apps/desktop/scripts/legacy-upgrade-rehearsal.mjs` deliberately operates only on
synthetic files. Its tests exercise failure/concurrency decisions without touching
the Windows registry or private backup contents. They are not dynamic installer,
registry rollback, or general legacy-upgrade acceptance evidence.
