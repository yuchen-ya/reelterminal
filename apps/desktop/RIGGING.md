# 3D rigging

The desktop can use Blender as an optional rigging backend. It invokes Blender
as a separate process for model inspection, rigging, and GLB/glTF export.

The implementation is available through the restricted desktop renderer IPC
bridge: `window.reelterminal.rigging.probeBackend()` and
`rigHumanoidModel(args)`. These are internal renderer APIs, not public Command
API/CLI/MCP verbs. The current live catalog does not expose the former
`probe_rigging_backend`, `inspect_3d_model`, `rig_humanoid_model`, or
`set_model_animation` Agent tools.

The backend checks `REELTERMINAL_BLENDER_PATH`, the packaged resource slot,
then common system locations. Bundle resources under
`resources/rigging/blender/<platform>-<arch>/`. Desktop packaging includes
helper scripts in `resources/rigging/`, but the `blender/` binary directory is
excluded by the current package configuration. Install Blender separately and
configure `REELTERMINAL_BLENDER_PATH`. Any future bundled Blender must follow the
[Blender license notice](LICENSES/BLENDER.md).
