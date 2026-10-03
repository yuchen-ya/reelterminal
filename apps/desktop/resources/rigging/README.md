# Rigging resources

This directory is the desktop app's optional rigging resource root. Blender
can be configured with `REELTERMINAL_BLENDER_PATH` or `BLENDER_PATH`.

To bundle Blender, use these platform paths:

- `blender/darwin-arm64/Blender.app/Contents/MacOS/Blender`
- `blender/darwin-x64/Blender.app/Contents/MacOS/Blender`
- `blender/win32-x64/blender.exe`
- `blender/linux-x64/blender`

Desktop packages copy this directory to `process.resourcesPath/rigging`.
Include the applicable license and corresponding source materials for any
Blender binary placed here; see
[`../../LICENSES/BLENDER.md`](../../LICENSES/BLENDER.md).
