# Rigging resources

This directory is the desktop app's optional rigging resource root. Blender
can be configured with `REELTERMINAL_BLENDER_PATH` or `BLENDER_PATH`.

Local development Blender candidates use these platform paths:

- `blender/darwin-arm64/Blender.app/Contents/MacOS/Blender`
- `blender/darwin-x64/Blender.app/Contents/MacOS/Blender`
- `blender/win32-x64/blender.exe`
- `blender/linux-x64/blender`

Desktop packages copy helper scripts to `process.resourcesPath/rigging`, but
exclude `blender/`. Users install Blender separately and configure its path.
If distribution is changed to include Blender, first provide its applicable
license and corresponding source materials; see
[`../../LICENSES/BLENDER.md`](../../LICENSES/BLENDER.md).
