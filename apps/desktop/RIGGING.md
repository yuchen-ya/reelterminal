# 3D rigging

The desktop can use Blender as an optional rigging backend. It invokes Blender
as a separate process for model inspection, rigging, and GLB/glTF export.

The desktop exposes these Agent tools:

- `probe_rigging_backend` reports whether Blender is available.
- `inspect_3d_model` reports model structure and animation data.
- `rig_humanoid_model` creates or repairs a humanoid rig and exports a GLB.
- `set_model_animation` selects a GLB/glTF animation for a scene object.

The backend checks `REELTERMINAL_BLENDER_PATH`, the packaged resource slot,
then common system locations. Bundle resources under
`resources/rigging/blender/<platform>-<arch>/`. Desktop packaging includes
resources in `resources/rigging/`; bundled Blender packages must follow the
[Blender license notice](LICENSES/BLENDER.md).
