/** All coordinates are decoded source pixels, never CSS/display coordinates. */
export interface ImageRepairRegion {
  readonly space: "source-pixels";
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
export interface ImageRepairPoint {
  readonly x: number;
  readonly y: number;
  readonly pressure: number;
}

export type ImageRepairOperation =
  | {
      readonly kind: "brush";
      readonly color: string;
      readonly size: number;
      readonly points: readonly ImageRepairPoint[];
    }
  | {
      readonly kind: "eraser";
      readonly size: number;
      readonly points: readonly ImageRepairPoint[];
    }
  | {
      readonly kind: "clone";
      readonly size: number;
      readonly source: { readonly x: number; readonly y: number };
      readonly points: readonly ImageRepairPoint[];
      readonly hardness: number;
      readonly opacity: number;
    }
  | {
      readonly kind: "patch";
      readonly resourceId: string;
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
      readonly opacity: number;
    };
