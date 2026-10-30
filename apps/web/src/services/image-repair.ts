import type { ImageRepairOperation, ImageRepairRegion } from "@reelterminal/core/review/image-repair";
import { drawStrokeOnContext } from "../desktop/workbench/components/image/image-canvas-utils";

export function createImageCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(blob => {
      if (blob) resolve(blob);
      else reject(new Error("PNG encoding failed"));
    }, "image/png");
  });
}

export function validateImageRepairRegion(region: ImageRepairRegion, width: number, height: number): void {
  if (region.space !== "source-pixels" || ![region.x, region.y, region.width, region.height].every(Number.isSafeInteger) ||
      region.x < 0 || region.y < 0 || region.width <= 0 || region.height <= 0 || region.x + region.width > width || region.y + region.height > height) {
    throw Object.assign(new Error("Repair region must be an integer source-pixel rectangle inside the image"), { code: "INVALID_PARAMS" });
  }
}

/** Execute a prevalidated batch on disposable canvases. The caller owns persistence. */
export function executeImageRepair(input: {
  base: HTMLCanvasElement;
  layer?: HTMLCanvasElement;
  current?: HTMLCanvasElement;
  region: ImageRepairRegion;
  operations: readonly ImageRepairOperation[];
  patches?: ReadonlyMap<string, CanvasImageSource>;
}): { layer: HTMLCanvasElement; composite: HTMLCanvasElement; changedRegion: ImageRepairRegion | null } {
  const { base, region, operations } = input;
  validateImageRepairRegion(region, base.width, base.height);
  if (!operations.length || operations.length > 100) {
    throw Object.assign(new Error("Repair needs 1–100 operations"), { code: "INVALID_PARAMS" });
  }
  // Resolve every external patch before painting anything, including earlier valid strokes.
  for (const operation of operations) {
    if (operation.kind === "patch" && !input.patches?.has(operation.resourceId)) {
      throw Object.assign(new Error("Patch image is missing"), { code: "NOT_FOUND" });
    }
  }
  const layer = createImageCanvas(base.width, base.height);
  const ctx = layer.getContext("2d")!;
  if (input.layer) {
    if (input.layer.width !== base.width || input.layer.height !== base.height) {
      throw new Error("Repair layer dimensions differ from base");
    }
    ctx.drawImage(input.layer, 0, 0);
  }
  const before = createImageCanvas(base.width, base.height);
  const beforeContext = before.getContext("2d")!;
  if (input.current) {
    beforeContext.drawImage(input.current, 0, 0);
  } else {
    beforeContext.drawImage(base, 0, 0);
    beforeContext.drawImage(layer, 0, 0);
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(region.x, region.y, region.width, region.height);
  ctx.clip();
  for (const operation of operations) {
    if (operation.kind === "brush" || operation.kind === "eraser") {
      drawStrokeOnContext(ctx, {
        ...operation,
        id: "batch",
        tool: operation.kind,
        color: operation.kind === "brush" ? operation.color : "#000000",
      });
    } else if (operation.kind === "patch") {
      ctx.save();
      ctx.globalAlpha = operation.opacity;
      ctx.drawImage(input.patches!.get(operation.resourceId)!, operation.x, operation.y, operation.width, operation.height);
      ctx.restore();
    } else {
      const radius = operation.size / 2;
      const stamp = createImageCanvas(Math.ceil(operation.size) + 2, Math.ceil(operation.size) + 2);
      const stampContext = stamp.getContext("2d")!;
      const center = stamp.width / 2;
      const first = operation.points[0];
      const stampAt = (x: number, y: number) => {
        stampContext.clearRect(0, 0, stamp.width, stamp.height);
        stampContext.globalCompositeOperation = "source-over";
        stampContext.drawImage(before, operation.source.x + x - first.x - center, operation.source.y + y - first.y - center,
          stamp.width, stamp.height, 0, 0, stamp.width, stamp.height);
        stampContext.globalCompositeOperation = "destination-in";
        const mask = stampContext.createRadialGradient(center, center, radius * Math.min(operation.hardness, 0.9999), center, center, radius);
        mask.addColorStop(0, `rgba(0,0,0,${operation.opacity})`);
        mask.addColorStop(1, "rgba(0,0,0,0)");
        stampContext.fillStyle = mask;
        stampContext.fillRect(0, 0, stamp.width, stamp.height);
        ctx.drawImage(stamp, x - center, y - center);
      };
      stampAt(first.x, first.y);
      for (let index = 1; index < operation.points.length; index++) {
        const a = operation.points[index - 1];
        const b = operation.points[index];
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / Math.max(0.5, radius / 4)));
        for (let step = 1; step <= steps; step++) {
          stampAt(a.x + (b.x - a.x) * step / steps, a.y + (b.y - a.y) * step / steps);
        }
      }
    }
  }
  ctx.restore();
  const composite = createImageCanvas(base.width, base.height);
  const resultContext = composite.getContext("2d")!;
  // Copy untouched pixels from the actual preceding composite. Reconstructing
  // its semitransparent layers may round differently after PNG decode.
  resultContext.drawImage(before, 0, 0);
  resultContext.save();
  resultContext.beginPath();
  resultContext.rect(region.x, region.y, region.width, region.height);
  resultContext.clip();
  resultContext.clearRect(region.x, region.y, region.width, region.height);
  resultContext.drawImage(base, 0, 0);
  resultContext.drawImage(layer, 0, 0);
  resultContext.restore();
  const previous = beforeContext.getImageData(region.x, region.y, region.width, region.height).data;
  const current = resultContext.getImageData(region.x, region.y, region.width, region.height).data;
  let left = region.width;
  let top = region.height;
  let right = -1;
  let bottom = -1;
  for (let y = 0; y < region.height; y++) {
    for (let x = 0; x < region.width; x++) {
      const offset = (y * region.width + x) * 4;
      if ([0, 1, 2, 3].some(channel => previous[offset + channel] !== current[offset + channel])) {
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
  }
  return {
    layer,
    composite,
    changedRegion: right < 0 ? null : {
      space: "source-pixels",
      x: region.x + left,
      y: region.y + top,
      width: right - left + 1,
      height: bottom - top + 1,
    },
  };
}
