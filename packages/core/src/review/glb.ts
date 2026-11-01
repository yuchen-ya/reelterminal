import { uiMessageKey } from "../ui-message";
/** GLB preflight before GLTFLoader sees any bytes or allocates decoded buffers. */
// Each preview is bounded independently; a comparison opens at most two.
export const MODEL_PREVIEW_BUDGET = { fileBytes: 8 * 1024 * 1024, decodedBytes: 8 * 1024 * 1024,
  texturePixels: 512 * 512, textureSide: 512, nodes: 256, instances: 32, primitives: 32, triangles: 600 } as const;
export const MODEL_PREVIEW_EXTENSIONS = ["KHR_materials_unlit", "KHR_texture_transform", "KHR_mesh_quantization", "KHR_materials_emissive_strength"] as const;
export interface GlbReport { scenes: number; meshes: number; triangles: number; instances: number; decodedBytes: number; texturePixels: number; warnings: string[] }
function fail(message: string): never { throw Object.assign(new Error(message), { code: "UNSUPPORTED" }); }
interface Entry { [key: string]: unknown; byteLength: number; byteOffset?: number; buffer: number; uri?: string }
interface GlbDocument {
  asset: { version: string; minVersion?: string }; extensionsRequired?: string[]; extensionsUsed?: string[];
  buffers?: Entry[]; bufferViews?: Entry[];
  accessors?: { count: number; type: string; componentType: number }[];
  images?: { uri?: string; mimeType?: string; bufferView?: number }[];
  textures?: { source?: number }[];
  nodes?: { mesh?: number; children?: number[] }[];
  meshes?: { primitives?: { indices?: number; mode?: number; attributes?: { POSITION?: number } }[] }[];
  scenes?: { nodes?: number[] }[];
}

function imageSize(bytes: Uint8Array, mime: string | undefined): [number, number] {
  const d = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (mime === "image/png" && bytes.length >= 24 && d.getUint32(0) === 0x89504e47 && d.getUint32(12) === 0x49484452) return [d.getUint32(16), d.getUint32(20)];
  if (mime === "image/jpeg" && bytes[0] === 255 && bytes[1] === 216) {
    let offset = 2;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 255) break;
      const marker = bytes[offset++];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = d.getUint16(offset);
      if (length < 2 || offset + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2].includes(marker) && length >= 7) return [d.getUint16(offset + 5), d.getUint16(offset + 3)];
      offset += length;
    }
  }
  return fail(uiMessageKey("Preview supports only valid embedded PNG/JPEG textures"));
}

export function inspectGlb(buffer: ArrayBuffer): GlbReport {
  if (buffer.byteLength > MODEL_PREVIEW_BUDGET.fileBytes) fail(uiMessageKey("3D preview supports simple scenes only: GLB must not exceed 8 MiB; the original can still be exported"));
  if (buffer.byteLength < 20) fail(uiMessageKey("Incomplete GLB header"));
  const view = new DataView(buffer);
  if (view.getUint32(0, true) !== 0x46546c67 || view.getUint32(4, true) !== 2 || view.getUint32(8, true) !== buffer.byteLength) fail(uiMessageKey("A GLB 2.0 file with a valid length is required"));
  let json: GlbDocument | undefined;
  let binary = new Uint8Array();
  let offset = 12;
  while (offset < buffer.byteLength) {
    if (offset + 8 > buffer.byteLength) fail(uiMessageKey("Incomplete GLB chunk header"));
    const length = view.getUint32(offset, true), type = view.getUint32(offset + 4, true);
    if (length % 4 || offset + 8 + length > buffer.byteLength) fail(uiMessageKey("Invalid GLB chunk length"));
    if (offset === 12 && type !== 0x4e4f534a) fail(uiMessageKey("The first GLB chunk must be JSON"));
    if (type === 0x4e4f534a) {
      if (json) fail(uiMessageKey("GLB contains duplicate JSON chunks"));
      json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(buffer, offset + 8, length))) as GlbDocument;
    } else if (type === 0x004e4942) {
      if (binary.length) fail(uiMessageKey("GLB contains duplicate BIN chunks"));
      binary = new Uint8Array(buffer, offset + 8, length);
    }
    offset += 8 + length;
  }
  if (!json || json.asset?.version !== "2.0" || (json.asset.minVersion && json.asset.minVersion !== "2.0")) fail(uiMessageKey("glTF 2.0 is required"));
  const doc = json!;
  for (const key of ["buffers", "bufferViews", "accessors", "images", "textures", "nodes", "meshes", "scenes"] as const) if (doc[key] !== undefined && !Array.isArray(doc[key])) fail(uiMessageKey(`GLB ${key} must be an array`));
  if ((doc.nodes?.length ?? 0) > MODEL_PREVIEW_BUDGET.nodes) fail(uiMessageKey("3D preview supports simple scenes only: at most 256 nodes; the original can still be exported"));
  const visiting = new Set<number>(), visited = new Set<number>(), parents = new Set<number>();
  const visit = (index: number, depth: number): void => {
    if (!Number.isInteger(index) || !doc.nodes?.[index]) fail(uiMessageKey("Invalid GLB node reference"));
    if (visiting.has(index) || depth > 128) fail(uiMessageKey("GLB nodes contain a cycle or exceed the nesting limit"));
    if (visited.has(index)) return;
    visiting.add(index);
    for (const child of doc.nodes[index].children ?? []) {
      if (parents.has(child)) fail(uiMessageKey("A GLB node has multiple parents"));
      parents.add(child); visit(child, depth + 1);
    }
    visiting.delete(index); visited.add(index);
  };
  for (let index = 0; index < (doc.nodes?.length ?? 0); index++) visit(index, 0);
  const allowed = new Set<string>(MODEL_PREVIEW_EXTENSIONS);
  for (const ext of doc.extensionsRequired ?? []) if (!allowed.has(ext)) fail(uiMessageKey(`3D preview supports simple scenes only: required extension ${ext} is unsupported; the original can still be exported`));
  for (const ext of doc.extensionsUsed ?? []) if (!allowed.has(ext)) fail(uiMessageKey(`3D preview supports simple scenes only: extension ${ext} is unsupported; the original can still be exported`));
  // Inspect every URI, including unknown optional extensions, before any loader work.
  const walk = (entry: unknown, depth = 0): void => {
    if (depth > 64) fail(uiMessageKey("GLB JSON exceeds the nesting limit"));
    if (!entry || typeof entry !== "object") return;
    for (const [key, child] of Object.entries(entry)) {
      if (key === "extensions" && child && typeof child === "object") for (const ext of Object.keys(child)) if (!allowed.has(ext)) fail(uiMessageKey(`3D preview supports simple scenes only: extension ${ext} is unsupported; the original can still be exported`));
      if (key === "uri" && (typeof child !== "string" || !/^data:(image\/(png|jpeg)|application\/octet-stream|application\/gltf-buffer);base64,[a-zA-Z0-9+/=\s]*$/.test(child))) fail(uiMessageKey("External URIs cannot be previewed; provide a self-contained GLB (no network access)"));
      if (key === "extensions" && child && typeof child === "object" && ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu", "EXT_mesh_gpu_instancing"].some(ext => ext in child)) fail(uiMessageKey("This preview does not support compression or instancing extensions; provide a standard GLB"));
      walk(child, depth + 1);
    }
  };
  walk(doc);
  const buffers: Uint8Array[] = (doc.buffers ?? []).map((b: Entry, index: number) => {
    const bytes = b.uri ? Uint8Array.from(atob(b.uri.split(",")[1]), x => x.charCodeAt(0)) : index === 0 ? binary : fail(uiMessageKey("Missing GLB buffer"));
    if (!Number.isSafeInteger(b.byteLength) || b.byteLength < 0 || b.byteLength > bytes.length) fail(uiMessageKey("Invalid GLB buffer length"));
    return bytes;
  });
  const views: Uint8Array[] = (doc.bufferViews ?? []).map((b: Entry) => {
    const source = buffers[b.buffer], start = b.byteOffset ?? 0;
    if (!source || !Number.isSafeInteger(start) || start < 0 || !Number.isSafeInteger(b.byteLength) || b.byteLength < 0 || start + b.byteLength > source.length) fail(uiMessageKey("GLB bufferView is out of bounds"));
    return source.subarray(start, start + b.byteLength);
  });
  let decodedBytes = buffers.reduce((n, b) => n + b.length, 0), texturePixels = 0;
  for (const a of doc.accessors ?? []) {
    const dimensions: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT2: 4, MAT3: 9, MAT4: 16 };
    if (!Number.isSafeInteger(a.count) || a.count < 0 || !dimensions[a.type] || ![5120,5121,5122,5123,5125,5126].includes(a.componentType)) fail(uiMessageKey("Invalid GLB accessor"));
    decodedBytes += a.count * dimensions[a.type] * 4; // conservative expanded component storage, includes sparse/morph/animation
  }
  const imagePixels: number[] = [];
  for (const image of doc.images ?? []) {
    const bytes = image.uri ? Uint8Array.from(atob(image.uri.split(",")[1]), x => x.charCodeAt(0)) : views[image.bufferView!];
    if (!bytes) fail(uiMessageKey("Missing GLB texture data"));
    const mime = image.mimeType ?? image.uri?.slice(5, image.uri.indexOf(";"));
    const [width, height] = imageSize(bytes, mime);
    if (!width || !height || width > MODEL_PREVIEW_BUDGET.textureSide || height > MODEL_PREVIEW_BUDGET.textureSide) fail(uiMessageKey("3D preview supports simple scenes only: texture sides must not exceed 512 pixels; the original can still be exported"));
    imagePixels.push(width * height);
    texturePixels += width * height;
  }
  texturePixels = Math.max(texturePixels, (doc.textures ?? []).reduce((sum, texture) => sum + (imagePixels[texture.source!] ?? 0), 0));
  if (decodedBytes > MODEL_PREVIEW_BUDGET.decodedBytes || texturePixels > MODEL_PREVIEW_BUDGET.texturePixels || (doc.nodes?.length ?? 0) > MODEL_PREVIEW_BUDGET.nodes) fail(uiMessageKey("3D preview supports simple scenes only: decoded or texture budget exceeded (8 MiB, 262144 pixels); the original can still be exported"));
  let triangles = 0, instances = 0, primitives = 0;
  for (const node of doc.nodes ?? []) if (node.mesh !== undefined) {
    instances++;
    const mesh = doc.meshes?.[node.mesh];
    if (!mesh) fail(uiMessageKey("Invalid model mesh reference"));
    for (const p of mesh.primitives ?? []) {
      primitives++;
      const count = doc.accessors?.[(p.indices ?? p.attributes?.POSITION)!]?.count ?? 0;
      if ((p.mode ?? 4) === 4) triangles += Math.floor(count / 3);
      else if (p.mode === 5 || p.mode === 6) triangles += Math.max(0, count - 2);
      else fail(uiMessageKey("3D preview supports simple triangle meshes only, not point or line primitives; the original can still be exported"));
    }
  }
  if (instances > MODEL_PREVIEW_BUDGET.instances || primitives > MODEL_PREVIEW_BUDGET.primitives || triangles > MODEL_PREVIEW_BUDGET.triangles) fail(uiMessageKey("3D preview supports simple scenes only: at most 32 mesh instances, 32 draw units and 600 instanced triangles; the original can still be exported"));
  if (!triangles) fail(uiMessageKey("The default preview requires a non-empty triangle-mesh scene"));
  return { scenes: doc.scenes?.length ?? 0, meshes: doc.meshes?.length ?? 0, triangles, instances, decodedBytes, texturePixels,
    warnings: (doc.extensionsUsed ?? []).filter((ext: string) => !allowed.has(ext)).map((ext: string) => uiMessageKey(`Extension appearance is not guaranteed: ${ext}`)) };
}
