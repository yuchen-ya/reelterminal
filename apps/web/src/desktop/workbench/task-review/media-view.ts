import { taskMediaPromptsSchema, type TaskMediaPrompts } from "../../../../../desktop/src/shared/task-review-media";

export interface MediaView {
  prompts: TaskMediaPrompts;
  mode: "positive" | "negative" | "box";
  zoom: number;
  label: string;
  previewResult?: boolean;
  videoTimeSec?: number;
}

export function readMediaView(key: string, initial: MediaView): MediaView {
  const raw = localStorage.getItem(key);
  if (!raw) return initial;
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch (problem) { if (problem instanceof SyntaxError) return initial; throw problem; }
  if (!value || typeof value !== "object") return initial;
  const view = value as Partial<MediaView>;
  if (!view.prompts || typeof view.label !== "string" || !Number.isFinite(view.zoom) || view.zoom! < 0.25 || view.zoom! > 4 ||
      !["positive", "negative", "box"].includes(view.mode ?? "") ||
      (view.videoTimeSec !== undefined && (!Number.isFinite(view.videoTimeSec) || view.videoTimeSec < 0))) return initial;
  const prompts = view.prompts;
  if (!(Array.isArray(prompts.points) && prompts.points.length === 0 && prompts.box === undefined) && !taskMediaPromptsSchema.safeParse(prompts).success) return initial;
  return view as MediaView;
}

/** The served image is physically EXIF-normalized; its visible rect includes zoom. */
export function normalizedMediaPoint(clientX: number, clientY: number, rect: Pick<DOMRect, "left" | "top" | "width" | "height">) {
  return {
    x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
    y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
  };
}

export const promptTokens = (prompts: TaskMediaPrompts) => prompts.points.length + (prompts.box ? 2 : 0);
