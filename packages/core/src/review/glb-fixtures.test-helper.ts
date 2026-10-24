/** Original, programmatically generated fixtures; repository MIT license. No third-party assets. */
import { deflateSync } from "node:zlib";

function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) { value ^= byte; for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0); }
  return (value ^ 0xffffffff) >>> 0;
}
function png(side: number): Buffer {
  const chunk = (name: string, bytes: Buffer) => { const type = Buffer.from(name); const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([type, bytes]))); return Buffer.concat([length, type, bytes, crc]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(side, 0); header.writeUInt32BE(side, 4); header[8] = 8; header[9] = 6;
  const pixels = Buffer.alloc((side * 4 + 1) * side);
  for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) { const p = y * (side * 4 + 1) + 1 + x * 4; pixels[p] = 255; pixels[p + 1] = x < side / 2 ? 40 : 180; pixels[p + 2] = 40; pixels[p + 3] = y < side / 2 ? 255 : 90; }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}
export function encodeGlb(doc: Record<string, unknown>, binary = Buffer.alloc(0)): Buffer {
  const json = Buffer.from(JSON.stringify(doc)); const paddedJson = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(paddedJson);
  const paddedBin = Buffer.alloc(Math.ceil(binary.length / 4) * 4); binary.copy(paddedBin);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67); header.writeUInt32LE(2,4); header.writeUInt32LE(28 + paddedJson.length + paddedBin.length,8); header.writeUInt32LE(paddedJson.length,12); header.writeUInt32LE(0x4e4f534a,16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(paddedBin.length); binHeader.writeUInt32LE(0x004e4942,4);
  return Buffer.concat([header,paddedJson,binHeader,paddedBin]);
}
export function modelFixture({ animated = true, color = [0.1, 0.5, 0.9, 1], triangles = 2, textureSide = 4 }: { animated?: boolean; color?: number[]; triangles?: number; textureSide?: number } = {}) {
  const chunks: Buffer[] = [], bufferViews: Record<string, unknown>[] = [], accessors: Record<string, unknown>[] = [];
  let offset = 0;
  const view = (bytes: Uint8Array) => { const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength); const padded = Buffer.alloc(Math.ceil(data.length / 4) * 4); data.copy(padded); const index = bufferViews.length; bufferViews.push({ buffer: 0, byteOffset: offset, byteLength: data.length }); chunks.push(padded); offset += padded.length; return index; };
  const accessor = (data: Float32Array | Uint16Array, type: string, count: number, extra: Record<string, unknown> = {}) => { const index = accessors.length; accessors.push({ bufferView: view(new Uint8Array(data.buffer)), componentType: data instanceof Uint16Array ? 5123 : 5126, type, count, ...extra }); return index; };
  const positions = new Float32Array(triangles * 9);
  for (let i = 0; i < triangles; i++) positions.set(i % 2 ? [-.6,-.6,0,.6,.6,0,-.6,.6,0] : [-.6,-.6,0,.6,-.6,0,.6,.6,0], i * 9);
  const position = accessor(positions,"VEC3",triangles * 3,{ min: [-.6,-.6,0], max: [.6,.6,0] });
  const normal = accessor(new Float32Array(Array.from({length: triangles * 3},() => [0,0,1]).flat()),"VEC3",triangles * 3);
  const joints = accessor(new Uint16Array(triangles * 12),"VEC4",triangles * 3);
  const weights = accessor(new Float32Array(Array.from({length: triangles * 3},() => [1,0,0,0]).flat()),"VEC4",triangles * 3);
  const morph = accessor(new Float32Array(Array.from({length: triangles * 3},(_,i) => [0, i % 3 === 2 ? .7 : 0, .2]).flat()),"VEC3",triangles * 3,{ min:[0,0,.2],max:[0,.7,.2] });
  const uv = accessor(new Float32Array(Array.from({length:triangles},(_,i) => i % 2 ? [0,0,1,1,0,1] : [0,0,1,0,1,1]).flat()),"VEC2",triangles * 3);
  const inverse = accessor(new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1]),"MAT4",1);
  const times = accessor(new Float32Array([0,1,2]),"SCALAR",3,{min:[0],max:[2]});
  const rotations = accessor(new Float32Array([0,0,0,1,0,0,.70710678,.70710678,0,0,0,1]),"VEC4",3);
  const morphWeights = accessor(new Float32Array([0,1,0]),"SCALAR",3);
  const image = view(png(textureSide));
  const doc: Record<string, any> = { asset:{version:"2.0", generator:"ReelTerminal MIT test fixture"}, scene:0, scenes:[{nodes:[0,1,2,3]}],
    nodes:[{name:"SkinnedMorph",mesh:0,...(animated ? {skin:0} : {}),translation:[-.8,0,0]}, {name:"Joint"}, {name:"PBR",mesh:1,translation:[.8,0,-.3],rotation:[0,.258819,0,.965926]}, {name:"Alpha",mesh:2,translation:[.8,0,.1],scale:[.65,.65,1]}],
    meshes:[{weights:[0],primitives:[{attributes:{POSITION:position,NORMAL:normal,...(animated ? {JOINTS_0:joints,WEIGHTS_0:weights} : {})},material:0,targets:[{POSITION:morph}]}]},
      {primitives:[{attributes:{POSITION:position,NORMAL:normal},material:1}]}, {primitives:[{attributes:{POSITION:position,NORMAL:normal,TEXCOORD_0:uv},material:2}]}],
    materials:[{pbrMetallicRoughness:{baseColorFactor:color,metallicFactor:0,roughnessFactor:.6},doubleSided:true}, {pbrMetallicRoughness:{baseColorFactor:[.7,.7,.75,1],metallicFactor:.8,roughnessFactor:.25},doubleSided:true},
      {pbrMetallicRoughness:{baseColorTexture:{index:0},metallicFactor:0,roughnessFactor:1},alphaMode:"BLEND",doubleSided:true}],
    textures:[{source:0}],images:[{bufferView:image,mimeType:"image/png"}],
    ...(animated ? {skins:[{joints:[1],inverseBindMatrices:inverse}],animations:[{name:"BoneTurn",samplers:[{input:times,output:rotations}],channels:[{sampler:0,target:{node:1,path:"rotation"}}]}, {name:"MorphRise",samplers:[{input:times,output:morphWeights}],channels:[{sampler:0,target:{node:0,path:"weights"}}]}]} : {}),
    buffers:[{byteLength:offset}],bufferViews,accessors };
  return { doc, binary: Buffer.concat(chunks), bytes: encodeGlb(doc,Buffer.concat(chunks)) };
}
