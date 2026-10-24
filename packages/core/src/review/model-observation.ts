import type { ModelObservation } from "../types/workbench";

/** Validate persisted/external observation data before it reaches the camera. */
export function isModelObservation(value: unknown): value is ModelObservation {
  if (!value || typeof value !== "object") return false;
  const v = value as ModelObservation;
  const keys = (object: unknown, allowed: string[]) => !!object && typeof object === "object" && !Array.isArray(object) && Object.keys(object).every(key => allowed.includes(key));
  if (!keys(v, ["preset", "background", "camera", "animation", "viewport"]) || !keys(v.camera, ["position", "quaternion", "target", "fov", "near", "far"]) || !keys(v.viewport, ["width", "height"]) || (v.animation !== null && !keys(v.animation, ["index", "name", "time"]))) return false;
  const vector = (x: unknown, n: number) => Array.isArray(x) && x.length === n && x.every(y => typeof y === "number" && Number.isFinite(y) && Math.abs(y) <= 1e12);
  return v.preset === "neutral-r182-v1" && ["light", "dark"].includes(v.background) && !!v.camera &&
    vector(v.camera.position, 3) && vector(v.camera.target, 3) && vector(v.camera.quaternion, 4) &&
    Math.abs(Math.hypot(...v.camera.quaternion) - 1) < 0.001 &&
    v.camera.fov > 0 && v.camera.fov < 180 && v.camera.near > 0 && Number.isFinite(v.camera.far) && v.camera.far > v.camera.near &&
    !!v.viewport && Number.isInteger(v.viewport.width) && v.viewport.width > 0 && v.viewport.width <= 16384 &&
    Number.isInteger(v.viewport.height) && v.viewport.height > 0 && v.viewport.height <= 16384 &&
    (v.animation === null || (!!v.animation && Number.isInteger(v.animation.index) && v.animation.index >= 0 &&
      typeof v.animation.name === "string" && v.animation.name.length <= 2000 && Number.isFinite(v.animation.time) && v.animation.time >= 0));
}
