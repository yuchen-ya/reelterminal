import type {
  LottieAnimatedProperty,
  LottieAnimation,
  LottieKeyframe,
  LottieLayer,
  LottieShape,
  LottieShapeLayer,
  LottieSolidLayer,
  LottieTextLayer,
  LottieTransform,
} from "../../types/lottie";
import { DEFAULT_SHAPE_STYLE } from "../../graphics/types";
import type { FillStyle, GradientStop, ShapeType } from "../../graphics/types";
import { motionEngine } from "../motion-engine";
import type {
  MotionComposition,
  MotionLayer,
  MotionShapeLayer,
  MotionTextLayer,
} from "../types";
import { DEFAULT_MOTION_TRANSFORM } from "../types";
import { buildMotionPathData } from "../motion-shape-path";
import type { MotionShapePathPoint } from "../motion-shape-path";

const BEZIER_FLATTEN_SAMPLES = 16;
const BEZIER_CIRCLE_FACTOR = 0.5522847498307936;
const GROUP_TRANSFORM_EPSILON = 1e-9;

const FALLBACK_LOTTIE_FRAME_RATE = 30;

function effectiveFrameRate(lottie: LottieAnimation): number {
  return lottie.fr > 0 ? lottie.fr : FALLBACK_LOTTIE_FRAME_RATE;
}

export function importLottieAsMotionComposition(
  lottie: LottieAnimation,
): MotionComposition {
  const fr = effectiveFrameRate(lottie);
  const duration = Math.max(0.1, (lottie.op - lottie.ip) / fr);
  const composition = motionEngine.createComposition({
    name: lottie.nm || "Imported Lottie Motion",
    width: lottie.w,
    height: lottie.h,
    frameRate: fr,
    duration,
    backgroundColor: "transparent",
  });
  // Lottie lists layers front-to-back (layers[0] is topmost and painted last
  // by lottie-web), while motion compositions render array order (index 0
  // drawn first, i.e. bottom). Reverse so z-order is preserved.
  const layers = lottie.layers
    .flatMap((layer) => convertLottieLayer(lottie, composition, layer))
    .reverse();

  return {
    ...composition,
    assets: [
      {
        id: uid("asset-lottie"),
        type: "lottie",
        name: lottie.nm || "Lottie",
        data: lottie,
        width: lottie.w,
        height: lottie.h,
        duration,
      },
    ],
    layers,
    markers: (lottie.markers ?? []).map((marker) => ({
      id: uid("lottie-marker"),
      time: (marker.tm - lottie.ip) / fr,
      label: marker.cm,
      color: "#14b8a6",
    })),
    modifiedAt: Date.now(),
  };
}

function convertLottieLayer(
  lottie: LottieAnimation,
  composition: MotionComposition,
  layer: LottieLayer,
): MotionLayer[] {
  if (layer.ty === 1) {
    return [convertSolidLayer(lottie, composition, layer)];
  }
  if (layer.ty === 4) {
    return convertShapeLayer(lottie, composition, layer);
  }
  if (layer.ty === 5) {
    return [convertTextLayer(lottie, layer)];
  }
  if (layer.ty === 0 || layer.ty === 2 || layer.ty === 3) {
    return [convertPlaceholderLayer(lottie, composition, layer)];
  }
  return [];
}

function convertPlaceholderLayer(
  lottie: LottieAnimation,
  composition: MotionComposition,
  layer: LottieLayer,
): MotionShapeLayer {
  const timing = layerTiming(lottie, layer);
  const fallbackName =
    layer.ty === 0 ? "Precomp" : layer.ty === 2 ? "Image" : "Null";
  const width = "w" in layer && typeof layer.w === "number" ? layer.w : 240;
  const height = "h" in layer && typeof layer.h === "number" ? layer.h : 240;
  return {
    ...baseShapeLayer(composition, layer, timing),
    name: layer.nm || `Lottie ${fallbackName}`,
    shapeType: "rectangle",
    width: Math.max(1, width),
    height: Math.max(1, height),
    visible: layer.ty !== 3,
    style: shapeStyle("#1f2937", "#374151", layer.ty === 3 ? 0 : 1),
  };
}

function convertSolidLayer(
  lottie: LottieAnimation,
  composition: MotionComposition,
  layer: LottieSolidLayer,
): MotionShapeLayer {
  const timing = layerTiming(lottie, layer);
  return {
    ...baseShapeLayer(composition, layer, timing),
    name: layer.nm || "Lottie Solid",
    shapeType: "rectangle",
    width: layer.sw,
    height: layer.sh,
    style: shapeStyle(layer.sc || "#111827", layer.sc || "#111827", 0),
  };
}

function convertShapeLayer(
  lottie: LottieAnimation,
  composition: MotionComposition,
  layer: LottieShapeLayer,
): MotionShapeLayer[] {
  const timing = layerTiming(lottie, layer);
  const transform = baseTransform(layer.ks);
  const paint = findPaint(layer.shapes);
  const shapes = flattenShapes(layer.shapes);
  return shapes.flatMap(({ shape, groupTransform }, index) =>
    convertLottieShape(
      lottie,
      composition,
      layer,
      shape,
      transform,
      paint,
      timing,
      index,
      groupTransform,
    ),
  );
}

function convertLottieShape(
  lottie: LottieAnimation,
  composition: MotionComposition,
  layer: LottieShapeLayer,
  shape: LottieShape,
  transform: MotionLayer["transform"],
  paint: ShapePaint,
  timing: { startTime: number; duration: number },
  index: number,
  groupTransform: LottieGroupTransform = IDENTITY_GROUP_TRANSFORM,
): MotionShapeLayer[] {
  const base = (): Omit<
    MotionShapeLayer,
    "name" | "shapeType" | "width" | "height" | "style" | "pathData" | "pathClosed"
  > => ({
    ...baseShapeLayer(composition, layer, timing),
    id: uid("lottie-shape"),
    keyframes: transformKeyframes(layer.ks, effectiveFrameRate(lottie), layer.ip),
  });
  const positionedTransform = (offset: number[]): MotionLayer["transform"] => ({
    ...transform,
    position: {
      x: transform.position.x + (offset[0] ?? 0),
      y: transform.position.y + (offset[1] ?? 0),
    },
  });
  const style = (cornerRadius = 0): MotionShapeLayer["style"] => ({
    ...resolveShapeStyle(paint),
    cornerRadius,
  });
  const shapeName = (suffix: string): string =>
    shape.nm || layer.nm || `Lottie ${suffix} ${index + 1}`;
  const pathLayer = (path: ConvertedPath, suffix: string): MotionShapeLayer => ({
    ...base(),
    name: shapeName(suffix),
    transform: positionedTransform([path.centerX, path.centerY]),
    shapeType: "path",
    width: path.width,
    height: path.height,
    pathData: path.pathData,
    pathClosed: path.closed,
    style: style(),
  });

  if (shape.ty === "rc" || shape.ty === "el") {
    if (groupTransformNeedsPath(groupTransform)) {
      const path = convertLottiePrimitivePathShape(shape, groupTransform);
      return path ? [pathLayer(path, "Shape")] : [];
    }
    const size = readVector(shape.s, [240, 120]);
    const position = readVector(shape.p, [0, 0]);
    // Layer scale stays on the layer transform (applied once by the
    // renderer); only the flattened group's scale is baked into the size.
    const transformedPosition = applyGroupTransform(groupTransform, position);
    return [
      {
        ...base(),
        name: shapeName("Shape"),
        transform: positionedTransform(transformedPosition),
        shapeType: shape.ty === "el" ? "ellipse" : "rectangle",
        width: Math.max(1, size[0] * groupTransform.a),
        height: Math.max(1, size[1] * groupTransform.d),
        style: style(shape.ty === "rc" ? readNumber(shape.r, 0) : 0),
      },
    ];
  }

  if (shape.ty === "sh") {
    const path = convertLottiePathShape(shape, groupTransform);
    return path ? [pathLayer(path, "Path")] : [];
  }

  if (shape.ty === "sr") {
    const star = convertLottieStarShape(shape);
    if (!star) return [];
    if (groupTransformNeedsPath(groupTransform)) {
      const path = convertLottiePrimitivePathShape(shape, groupTransform);
      return path ? [pathLayer(path, star.shapeType === "star" ? "Star" : "Polygon")] : [];
    }
    const position = readVector(shape.p, [0, 0]);
    const transformedPosition = applyGroupTransform(groupTransform, position);
    return [
      {
        ...base(),
        name: shapeName(star.shapeType === "star" ? "Star" : "Polygon"),
        transform: positionedTransform(transformedPosition),
        shapeType: star.shapeType,
        width: Math.max(1, star.width * groupTransform.a),
        height: Math.max(1, star.height * groupTransform.d),
        style: {
          ...style(),
          points: star.points,
          innerRadius: star.innerRadius,
        },
      },
    ];
  }

  return [];
}

function convertTextLayer(
  lottie: LottieAnimation,
  layer: LottieTextLayer,
): MotionTextLayer {
  const timing = layerTiming(lottie, layer);
  const document = layer.t.d.k[0]?.s;
  const transform = baseTransform(layer.ks);
  return {
    id: uid("lottie-text"),
    type: "text",
    name: layer.nm || "Lottie Text",
    startTime: timing.startTime,
    duration: timing.duration,
    visible: true,
    locked: false,
    transform,
    keyframes: transformKeyframes(layer.ks, lottie.fr, layer.ip),
    text: document?.t ?? layer.nm ?? "Lottie Text",
    style: {
      fontFamily: document?.f ?? "Inter",
      fontSize: document?.s ?? 64,
      fontWeight: 700,
      color: colorArrayToHex(document?.fc, "#ffffff"),
      align: document?.j === 0 ? "left" : document?.j === 2 ? "right" : "center",
      lineHeight: document?.lh && document.s ? document.lh / document.s : 1.05,
      letterSpacing: document?.tr,
    },
  };
}

function baseShapeLayer(
  composition: MotionComposition,
  layer: LottieLayer,
  timing: { startTime: number; duration: number },
): Omit<MotionShapeLayer, "name" | "shapeType" | "width" | "height" | "style"> {
  return {
    id: uid("lottie-shape"),
    type: "shape",
    startTime: timing.startTime,
    duration: timing.duration || composition.duration,
    visible: true,
    locked: false,
    transform: baseTransform(layer.ks),
    keyframes: transformKeyframes(layer.ks, composition.frameRate, layer.ip),
  };
}

function baseTransform(transform: LottieTransform): MotionLayer["transform"] {
  const position = readPosition(transform.p, [0, 0]);
  const scale = readVector(transform.s, [100, 100]);
  const anchor = readVector(transform.a, [0, 0]);
  return {
    ...DEFAULT_MOTION_TRANSFORM,
    position: { x: position[0], y: position[1] },
    scale: { x: scale[0] / 100, y: scale[1] / 100 },
    rotation: readScalar(transform.r, 0),
    anchor: { x: anchor[0], y: anchor[1] },
    opacity: readScalar(transform.o, 100) / 100,
  };
}

function transformKeyframes(
  transform: LottieTransform,
  frameRate: number,
  layerInFrame: number,
): MotionLayer["keyframes"] {
  const keyframes: MotionLayer["keyframes"] = [
    ...animatedScalarKeyframes(transform.r, "transform.rotation", frameRate, layerInFrame, 1),
    ...animatedScalarKeyframes(transform.o, "transform.opacity", frameRate, layerInFrame, 0.01),
    ...animatedVectorKeyframes(transform.s, "transform.scale", frameRate, layerInFrame, 0.01),
  ];

  if (transform.p && "s" in transform.p) {
    keyframes.push(
      ...animatedScalarKeyframes(
        transform.p.x,
        "transform.position.x",
        frameRate,
        layerInFrame,
        1,
      ),
      ...animatedScalarKeyframes(
        transform.p.y,
        "transform.position.y",
        frameRate,
        layerInFrame,
        1,
      ),
    );
  } else {
    keyframes.push(
      ...animatedVectorKeyframes(
        transform.p,
        "transform.position",
        frameRate,
        layerInFrame,
        1,
      ),
    );
  }

  return keyframes;
}

function animatedScalarKeyframes(
  property: LottieAnimatedProperty | undefined,
  motionProperty: string,
  frameRate: number,
  layerInFrame: number,
  scale: number,
): MotionLayer["keyframes"] {
  const frames = readAnimatedKeyframes(property);
  if (!frames) return [];
  return frames.map((frame) => ({
    id: uid("lottie-kf"),
    property: motionProperty,
    time: Math.max(0, (frame.t - layerInFrame) / frameRate),
    value: (frame.s[0] ?? 0) * scale,
    easing: "ease",
  }));
}

function animatedVectorKeyframes(
  property: LottieAnimatedProperty | undefined,
  motionPropertyPrefix: string,
  frameRate: number,
  layerInFrame: number,
  scale: number,
): MotionLayer["keyframes"] {
  const frames = readAnimatedKeyframes(property);
  if (!frames) return [];
  return frames.flatMap((frame) => {
    const time = Math.max(0, (frame.t - layerInFrame) / frameRate);
    return [
      {
        id: uid("lottie-kf"),
        property: `${motionPropertyPrefix}.x`,
        time,
        value: (frame.s[0] ?? 0) * scale,
        easing: "ease",
      },
      {
        id: uid("lottie-kf"),
        property: `${motionPropertyPrefix}.y`,
        time,
        value: (frame.s[1] ?? frame.s[0] ?? 0) * scale,
        easing: "ease",
      },
    ];
  });
}

function layerTiming(
  lottie: LottieAnimation,
  layer: LottieLayer,
): { startTime: number; duration: number } {
  const frameRate = effectiveFrameRate(lottie);
  const startTime = Math.max(0, (layer.ip - lottie.ip) / frameRate);
  const duration = Math.max(0.1, (layer.op - layer.ip) / frameRate);
  return { startTime, duration };
}

interface LottieGroupTransform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

const IDENTITY_GROUP_TRANSFORM: LottieGroupTransform = {
  a: 1,
  b: 0,
  c: 0,
  d: 1,
  e: 0,
  f: 0,
};

interface FlattenedShape {
  readonly shape: LottieShape;
  readonly groupTransform: LottieGroupTransform;
}

function readGroupTransform(shape: LottieShape | undefined): LottieGroupTransform {
  if (!shape || shape.ty !== "tr") return IDENTITY_GROUP_TRANSFORM;
  const position = readVector(shape.p, [0, 0]);
  const scale = readVector(shape.s, [100, 100]);
  const anchor = readVector(shape.a, [0, 0]);
  const rotation = readNumber(shape.r, 0);
  const skew = readNumber(shape.sk, 0);
  const skewAxis = readNumber(shape.sa, 0);
  return multiplyGroupTransforms(
    translationMatrix(position[0], position[1]),
    rotationMatrix(rotation),
    skewFromAxisMatrix(skew, skewAxis),
    scalingMatrix(scale[0] / 100, scale[1] / 100),
    translationMatrix(-anchor[0], -anchor[1]),
  );
}

function translationMatrix(x: number, y: number): LottieGroupTransform {
  return {
    ...IDENTITY_GROUP_TRANSFORM,
    e: x,
    f: y,
  };
}

function scalingMatrix(x: number, y: number): LottieGroupTransform {
  return { ...IDENTITY_GROUP_TRANSFORM, a: x, d: y };
}

/** Positive Lottie rotation maps to a positive CSS rotation in screen space. */
function rotationMatrix(degrees: number): LottieGroupTransform {
  const radians = (degrees * Math.PI) / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 };
}

function skewFromAxisMatrix(skewDegrees: number, axisDegrees: number): LottieGroupTransform {
  const shear = Math.tan((-skewDegrees * Math.PI) / 180);
  const shearX: LottieGroupTransform = {
    ...IDENTITY_GROUP_TRANSFORM,
    c: shear,
  };
  // Lottie applies rotate(axis), skewX(-skew), rotate(-axis) by left
  // multiplication; with these column vectors that is R(-axis) * S * R(axis).
  return multiplyGroupTransforms(
    rotationMatrix(-axisDegrees),
    shearX,
    rotationMatrix(axisDegrees),
  );
}

function multiplyGroupTransforms(
  ...matrices: readonly LottieGroupTransform[]
): LottieGroupTransform {
  return matrices.reduce(
    (first, second) => ({
      a: first.a * second.a + first.c * second.b,
      b: first.b * second.a + first.d * second.b,
      c: first.a * second.c + first.c * second.d,
      d: first.b * second.c + first.d * second.d,
      e: first.a * second.e + first.c * second.f + first.e,
      f: first.b * second.e + first.d * second.f + first.f,
    }),
    IDENTITY_GROUP_TRANSFORM,
  );
}

function composeGroupTransforms(
  parent: LottieGroupTransform,
  child: LottieGroupTransform,
): LottieGroupTransform {
  return multiplyGroupTransforms(parent, child);
}

function applyGroupTransform(
  transform: LottieGroupTransform,
  point: readonly number[],
): [number, number] {
  return [
    point[0] * transform.a + point[1] * transform.c + transform.e,
    point[0] * transform.b + point[1] * transform.d + transform.f,
  ];
}

function transformGroupVector(
  transform: LottieGroupTransform,
  vector: readonly number[],
): [number, number] {
  return [
    vector[0] * transform.a + vector[1] * transform.c,
    vector[0] * transform.b + vector[1] * transform.d,
  ];
}

function groupTransformNeedsPath(transform: LottieGroupTransform): boolean {
  return (
    Math.abs(transform.b) > GROUP_TRANSFORM_EPSILON ||
    Math.abs(transform.c) > GROUP_TRANSFORM_EPSILON ||
    transform.a <= 0 ||
    transform.d <= 0
  );
}

function flattenShapes(
  shapes: readonly LottieShape[],
  parentTransform: LottieGroupTransform = IDENTITY_GROUP_TRANSFORM,
): FlattenedShape[] {
  return shapes.flatMap((shape) => {
    if (shape.ty === "gr") {
      const groupTransform = composeGroupTransforms(
        parentTransform,
        readGroupTransform(
          shape.it.find((item) => item.ty === "tr"),
        ),
      );
      return flattenShapes(
        shape.it.filter((item) => item.ty !== "tr"),
        groupTransform,
      );
    }
    return [{ shape, groupTransform: parentTransform }];
  });
}

interface ShapePaint {
  readonly fill: string;
  readonly stroke: string;
  readonly strokeWidth: number;
  readonly gradient: GradientFillData | null;
}

interface GradientFillData {
  readonly type: "linear" | "radial";
  readonly stops: GradientStop[];
}

function findPaint(shapes: readonly LottieShape[]): ShapePaint {
  let fill = "#14b8a6";
  let stroke = "#14b8a6";
  let strokeWidth = 0;
  let gradient: GradientFillData | null = null;
  for (const { shape } of flattenShapes(shapes)) {
    if (shape.ty === "fl") fill = colorArrayToHex(readVector(shape.c, [0.08, 0.72, 0.65]));
    if (shape.ty === "st") {
      stroke = colorArrayToHex(readVector(shape.c, [0.08, 0.72, 0.65]));
      strokeWidth = readNumber(shape.w, 1);
    }
    if (shape.ty === "gf") {
      const parsed = parseLottieGradient(shape);
      if (parsed) {
        gradient = parsed;
        if (parsed.stops.length > 0) fill = parsed.stops[0].color;
      }
    }
    if (shape.ty === "gs") {
      const parsed = parseLottieGradient(shape);
      if (parsed && parsed.stops.length > 0) {
        stroke = parsed.stops[0].color;
        strokeWidth = readNumber(shape.w, strokeWidth || 1);
      }
    }
  }
  return { fill, stroke, strokeWidth, gradient };
}

function resolveShapeStyle(paint: ShapePaint): MotionShapeLayer["style"] {
  const fill: FillStyle =
    paint.gradient && paint.gradient.stops.length > 0
      ? {
          type: "gradient",
          color: paint.gradient.stops[0].color,
          opacity: 1,
          gradient: {
            type: paint.gradient.type,
            angle: 0,
            stops: paint.gradient.stops,
          },
        }
      : { type: "solid", color: paint.fill, opacity: 1 };
  return {
    ...DEFAULT_SHAPE_STYLE,
    fill,
    stroke: {
      color: paint.stroke,
      width: paint.strokeWidth,
      opacity: paint.strokeWidth > 0 ? 1 : 0,
    },
  };
}

function shapeStyle(fill: string, stroke: string, strokeWidth: number): MotionShapeLayer["style"] {
  return {
    ...DEFAULT_SHAPE_STYLE,
    fill: { type: "solid", color: fill, opacity: 1 },
    stroke: {
      color: stroke,
      width: strokeWidth,
      opacity: strokeWidth > 0 ? 1 : 0,
    },
  };
}

function parseLottieGradient(shape: LottieShape): GradientFillData | null {
  const typeValue = readShapeNumberField(shape, "t");
  const colorProperty = readShapeProperty(shape, "g");
  const stops = parseGradientStopsFromProperty(colorProperty);
  if (stops.length === 0) return null;
  return {
    type: typeValue === 2 ? "radial" : "linear",
    stops,
  };
}

function parseGradientStopsFromProperty(property: unknown): GradientStop[] {
  if (!property || typeof property !== "object") return [];
  const record = property as Record<string, unknown>;
  const gradientData = record.k as Record<string, unknown> | undefined;
  const colorCount =
    typeof record.p === "number"
      ? record.p
      : gradientData && typeof gradientData.p === "number"
        ? (gradientData.p as number)
        : undefined;
  const flat = readGradientValueArray(gradientData?.k ?? record.k);
  if (!flat || flat.length === 0) return [];
  const count = colorCount ?? Math.floor(flat.length / 4);
  if (count <= 0) return [];
  const stops: GradientStop[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = index * 4;
    const offset = flat[base];
    const red = flat[base + 1];
    const green = flat[base + 2];
    const blue = flat[base + 3];
    if (
      offset === undefined ||
      red === undefined ||
      green === undefined ||
      blue === undefined
    ) {
      break;
    }
    stops.push({
      offset: Math.min(1, Math.max(0, offset)),
      color: colorArrayToHex([red, green, blue]),
    });
  }
  return stops;
}

function readGradientValueArray(value: unknown): number[] | null {
  if (Array.isArray(value) && value.every((entry) => typeof entry === "number")) {
    return value as number[];
  }
  if (Array.isArray(value) && value.length > 0 && typeof value[0] === "object") {
    const firstFrame = value[0] as Record<string, unknown>;
    if (Array.isArray(firstFrame.s)) return firstFrame.s as number[];
  }
  return null;
}

function readShapeProperty(shape: LottieShape, key: string): unknown {
  return (shape as unknown as Record<string, unknown>)[key];
}

function readUnknownScalar(property: unknown, fallback: number): number {
  if (typeof property === "number") return property;
  if (!property || typeof property !== "object") return fallback;
  const value = (property as Record<string, unknown>).k;
  if (typeof value === "number") return value;
  if (Array.isArray(value)) {
    if (typeof value[0] === "number") return value[0];
    const firstFrame = value[0] as Record<string, unknown> | undefined;
    const start = firstFrame?.s;
    if (Array.isArray(start) && typeof start[0] === "number") return start[0];
  }
  return fallback;
}

function readShapeNumberField(shape: LottieShape, key: string): number | undefined {
  const value = (shape as unknown as Record<string, unknown>)[key];
  return typeof value === "number" ? value : undefined;
}

interface ConvertedPath {
  readonly pathData: string;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
  readonly closed: boolean;
}

interface LottieBezierData {
  readonly vertices: number[][];
  readonly inTangents: number[][];
  readonly outTangents: number[][];
  readonly closed: boolean;
}

function convertLottiePathShape(
  shape: LottieShape,
  groupTransform: LottieGroupTransform = IDENTITY_GROUP_TRANSFORM,
): ConvertedPath | null {
  const bezier = readBezierData(readShapeProperty(shape, "ks"));
  if (!bezier || bezier.vertices.length < 2) return null;
  return convertLottieBezier(bezier, groupTransform);
}

function convertLottiePrimitivePathShape(
  shape: LottieShape,
  groupTransform: LottieGroupTransform,
): ConvertedPath | null {
  const bezier = primitiveLottieBezier(shape);
  if (!bezier) return null;
  return convertLottieBezier(bezier, groupTransform);
}

function convertLottieBezier(
  bezier: LottieBezierData,
  groupTransform: LottieGroupTransform,
): ConvertedPath | null {
  // Transform vertices and relative handles with the same affine matrix so
  // curves remain cubic and keep their original control points.
  const transformedBezier: LottieBezierData = {
    vertices: bezier.vertices.map((vertex) =>
      applyGroupTransform(groupTransform, vertex),
    ),
    inTangents: bezier.inTangents.map((tangent) =>
      transformGroupVector(groupTransform, tangent),
    ),
    outTangents: bezier.outTangents.map((tangent) =>
      transformGroupVector(groupTransform, tangent),
    ),
    closed: bezier.closed,
  };
  const flat = flattenLottieBezier(transformedBezier);
  if (flat.length < 2) return null;

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of flat) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const centered = lottieBezierToHandledPoints(transformedBezier).map((point) =>
    centerLottieHandledPoint(point, centerX, centerY),
  );
  return {
    pathData: buildMotionPathData(centered),
    width: Math.max(1, maxX - minX),
    height: Math.max(1, maxY - minY),
    centerX,
    centerY,
    closed: bezier.closed,
  };
}

function primitiveLottieBezier(shape: LottieShape): LottieBezierData | null {
  if (shape.ty === "rc" || shape.ty === "el") {
    const size = readVector(shape.s, [240, 120]);
    const position = readVector(shape.p, [0, 0]);
    const halfWidth = Math.abs(size[0] ?? 0) / 2;
    const halfHeight = Math.abs(size[1] ?? 0) / 2;
    if (halfWidth === 0 || halfHeight === 0) return null;

    if (shape.ty === "el") {
      const controlX = halfWidth * BEZIER_CIRCLE_FACTOR;
      const controlY = halfHeight * BEZIER_CIRCLE_FACTOR;
      return {
        vertices: [
          [position[0], position[1] - halfHeight],
          [position[0] + halfWidth, position[1]],
          [position[0], position[1] + halfHeight],
          [position[0] - halfWidth, position[1]],
        ],
        inTangents: [
          [-controlX, 0],
          [0, -controlY],
          [controlX, 0],
          [0, controlY],
        ],
        outTangents: [
          [controlX, 0],
          [0, controlY],
          [-controlX, 0],
          [0, -controlY],
        ],
        closed: true,
      };
    }

    const radius = Math.min(
      halfWidth,
      halfHeight,
      Math.max(0, readNumber(shape.r, 0)),
    );
    const left = position[0] - halfWidth;
    const right = position[0] + halfWidth;
    const top = position[1] - halfHeight;
    const bottom = position[1] + halfHeight;
    if (radius === 0) {
      return {
        vertices: [
          [left, top],
          [right, top],
          [right, bottom],
          [left, bottom],
        ],
        inTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        outTangents: [[0, 0], [0, 0], [0, 0], [0, 0]],
        closed: true,
      };
    }

    const control = radius * BEZIER_CIRCLE_FACTOR;
    return {
      vertices: [
        [right - radius, top],
        [right, top + radius],
        [right, bottom - radius],
        [right - radius, bottom],
        [left + radius, bottom],
        [left, bottom - radius],
        [left, top + radius],
        [left + radius, top],
      ],
      inTangents: [
        [0, 0],
        [0, -control],
        [0, 0],
        [control, 0],
        [0, 0],
        [0, control],
        [0, 0],
        [-control, 0],
      ],
      outTangents: [
        [control, 0],
        [0, 0],
        [0, control],
        [0, 0],
        [-control, 0],
        [0, 0],
        [0, -control],
        [0, 0],
      ],
      closed: true,
    };
  }

  if (shape.ty === "sr") {
    const star = convertLottieStarShape(shape);
    if (!star) return null;
    const position = readVector(shape.p, [0, 0]);
    const isStar = star.shapeType === "star";
    const vertexCount = isStar ? star.points * 2 : star.points;
    const startAngle =
      (readUnknownScalar(readShapeProperty(shape, "r"), 0) * Math.PI) / 180 -
      Math.PI / 2;
    const outerRadius = star.width / 2;
    const vertices = Array.from({ length: vertexCount }, (_, index) => {
      const radius =
        isStar && index % 2 === 1
          ? outerRadius * star.innerRadius
          : outerRadius;
      const angle = startAngle + (index * Math.PI * 2) / vertexCount;
      return [
        position[0] + Math.cos(angle) * radius,
        position[1] + Math.sin(angle) * radius,
      ];
    });
    return {
      vertices,
      inTangents: vertices.map(() => [0, 0]),
      outTangents: vertices.map(() => [0, 0]),
      closed: true,
    };
  }

  return null;
}

function lottieBezierToHandledPoints(
  bezier: LottieBezierData,
): MotionShapePathPoint[] {
  const points: MotionShapePathPoint[] = bezier.vertices.map((vertex, index) => {
    const out = bezier.outTangents[index];
    const inTangent = bezier.inTangents[index];
    const x = vertex[0] ?? 0;
    const y = vertex[1] ?? 0;
    return {
      x,
      y,
      ...(out && (out[0] || out[1])
        ? { outX: x + (out[0] ?? 0), outY: y + (out[1] ?? 0) }
        : {}),
      ...(inTangent && (inTangent[0] || inTangent[1])
        ? { inX: x + (inTangent[0] ?? 0), inY: y + (inTangent[1] ?? 0) }
        : {}),
    };
  });
  if (bezier.closed && bezier.vertices.length > 1) {
    const first = bezier.vertices[0];
    const firstIn = bezier.inTangents[0];
    const x = first[0] ?? 0;
    const y = first[1] ?? 0;
    points.push({
      x,
      y,
      ...(firstIn && (firstIn[0] || firstIn[1])
        ? { inX: x + (firstIn[0] ?? 0), inY: y + (firstIn[1] ?? 0) }
        : {}),
    });
  }
  return points;
}

function centerLottieHandledPoint(
  point: MotionShapePathPoint,
  centerX: number,
  centerY: number,
): MotionShapePathPoint {
  return {
    x: point.x - centerX,
    y: point.y - centerY,
    ...(point.inX !== undefined && point.inY !== undefined
      ? { inX: point.inX - centerX, inY: point.inY - centerY }
      : {}),
    ...(point.outX !== undefined && point.outY !== undefined
      ? { outX: point.outX - centerX, outY: point.outY - centerY }
      : {}),
  };
}

function readBezierData(property: unknown): LottieBezierData | null {
  if (!property || typeof property !== "object") return null;
  const record = property as Record<string, unknown>;
  const value = record.a === 1 ? readFirstKeyframeBezier(record.k) : record.k;
  if (!value || typeof value !== "object") return null;
  const bezier = value as Record<string, unknown>;
  const vertices = readPointArray(bezier.v);
  if (vertices.length === 0) return null;
  return {
    vertices,
    inTangents: readPointArray(bezier.i),
    outTangents: readPointArray(bezier.o),
    closed: bezier.c === true,
  };
}

function readFirstKeyframeBezier(value: unknown): unknown {
  if (!Array.isArray(value) || value.length === 0) return null;
  const firstFrame = value[0] as Record<string, unknown>;
  const start = firstFrame.s;
  if (Array.isArray(start) && start.length > 0) return start[0];
  return start ?? null;
}

function readPointArray(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry): entry is number[] =>
        Array.isArray(entry) && typeof entry[0] === "number",
    )
    .map((entry) => [entry[0] ?? 0, entry[1] ?? 0]);
}

function flattenLottieBezier(bezier: LottieBezierData): MotionShapePathPoint[] {
  const { vertices, inTangents, outTangents, closed } = bezier;
  const points: MotionShapePathPoint[] = [{ x: vertices[0][0], y: vertices[0][1] }];
  const segmentCount = closed ? vertices.length : vertices.length - 1;
  for (let index = 0; index < segmentCount; index += 1) {
    const startVertex = vertices[index];
    const endVertex = vertices[(index + 1) % vertices.length];
    const outTangent = outTangents[index] ?? [0, 0];
    const inTangent = inTangents[(index + 1) % vertices.length] ?? [0, 0];
    const control1 = {
      x: startVertex[0] + outTangent[0],
      y: startVertex[1] + outTangent[1],
    };
    const control2 = {
      x: endVertex[0] + inTangent[0],
      y: endVertex[1] + inTangent[1],
    };
    const start = { x: startVertex[0], y: startVertex[1] };
    const end = { x: endVertex[0], y: endVertex[1] };
    for (let step = 1; step <= BEZIER_FLATTEN_SAMPLES; step += 1) {
      const t = step / BEZIER_FLATTEN_SAMPLES;
      points.push({
        x: cubicAt(start.x, control1.x, control2.x, end.x, t),
        y: cubicAt(start.y, control1.y, control2.y, end.y, t),
      });
    }
  }
  return points;
}

function cubicAt(
  start: number,
  control1: number,
  control2: number,
  end: number,
  t: number,
): number {
  const inverse = 1 - t;
  return (
    inverse ** 3 * start +
    3 * inverse ** 2 * t * control1 +
    3 * inverse * t ** 2 * control2 +
    t ** 3 * end
  );
}

interface ConvertedStar {
  readonly shapeType: ShapeType;
  readonly width: number;
  readonly height: number;
  readonly points: number;
  readonly innerRadius: number;
}

function convertLottieStarShape(shape: LottieShape): ConvertedStar | null {
  const starType = readUnknownScalar(readShapeProperty(shape, "sy"), 1);
  const pointCount = Math.max(
    3,
    Math.round(readUnknownScalar(readShapeProperty(shape, "pt"), 5)),
  );
  const outerRadius = readUnknownScalar(readShapeProperty(shape, "or"), 100);
  const innerRadius = readUnknownScalar(
    readShapeProperty(shape, "ir"),
    outerRadius * 0.5,
  );
  if (outerRadius <= 0) return null;
  const diameter = outerRadius * 2;
  const isStar = starType === 1;
  return {
    shapeType: isStar ? "star" : "polygon",
    width: diameter,
    height: diameter,
    points: pointCount,
    innerRadius: isStar
      ? Math.min(1, Math.max(0.05, innerRadius / outerRadius))
      : 1,
  };
}

function readPosition(
  property: LottieTransform["p"],
  fallback: number[],
): number[] {
  if (property && "s" in property) {
    return [readScalar(property.x, fallback[0]), readScalar(property.y, fallback[1])];
  }
  return readVector(property, fallback);
}

function readVector(
  property: LottieAnimatedProperty | undefined,
  fallback: number[],
): number[] {
  const value = property?.k;
  if (typeof value === "number") return [value];
  if (!Array.isArray(value)) return fallback;
  if (typeof value[0] === "number") return value as number[];
  const firstFrame = value[0] as LottieKeyframe | undefined;
  return firstFrame?.s ?? fallback;
}

function readScalar(
  property: LottieAnimatedProperty | undefined,
  fallback: number,
): number {
  const value = property?.k;
  if (typeof value === "number") return value;
  if (!Array.isArray(value)) return fallback;
  if (typeof value[0] === "number") return value[0] as number;
  const firstFrame = value[0] as LottieKeyframe | undefined;
  return firstFrame?.s?.[0] ?? fallback;
}

function readNumber(
  property: LottieAnimatedProperty | undefined,
  fallback: number,
): number {
  return readScalar(property, fallback);
}

function readAnimatedKeyframes(
  property: LottieAnimatedProperty | undefined,
): LottieKeyframe[] | null {
  if (!property || property.a !== 1 || !Array.isArray(property.k)) return null;
  return typeof property.k[0] === "object"
    ? (property.k as LottieKeyframe[])
    : null;
}

function colorArrayToHex(value: number[] | undefined, fallback = "#ffffff"): string {
  if (!value || value.length < 3) return fallback;
  const channels = value.slice(0, 3).map((channel) =>
    Math.max(0, Math.min(255, Math.round(channel * 255))),
  );
  return `#${channels
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")}`;
}

function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}
