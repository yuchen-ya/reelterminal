import { expect, test } from "vitest";
import { inspectGlb } from "./glb";
import { encodeGlb, modelFixture } from "./glb-fixtures.test-helper";
const array = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
test("real embedded PBR/alpha, skeletal and morph fixture passes bounded preflight", () => {
  const fixture = modelFixture();
  expect(inspectGlb(array(fixture.bytes))).toMatchObject({ scenes:1, meshes:3, triangles:6, instances:3, texturePixels:16, warnings:[] });
});
test("simple-preview budgets count instantiated triangles and texture size before loading", () => {
  const supported = modelFixture({ animated:false, triangles:200, textureSide:512 });
  expect(inspectGlb(array(supported.bytes))).toMatchObject({ triangles:600, instances:3, texturePixels:512*512 });
  const tooMany = modelFixture({ animated:false, triangles:201 });
  expect(() => inspectGlb(array(tooMany.bytes))).toThrow(/600.*原件/);
  const tooLarge = modelFixture({ animated:false, textureSide:513 });
  expect(() => inspectGlb(array(tooLarge.bytes))).toThrow(/512.*原件/);
  const tooManyInstances = { ...supported.doc, nodes: Array.from({length:33}, () => ({mesh:0})) };
  expect(() => inspectGlb(array(encodeGlb(tooManyInstances,supported.binary)))).toThrow(/32.*原件/);
  const base = modelFixture();
  const tooManyDraws = { ...base.doc, nodes:[{mesh:0}], scenes:[{nodes:[0]}], meshes:[{primitives:Array.from({length:33}, () => base.doc.meshes[0].primitives[0])}] };
  expect(() => inspectGlb(array(encodeGlb(tooManyDraws,base.binary)))).toThrow(/32.*绘制/);
  const points = { ...base.doc, meshes:[{primitives:[{...base.doc.meshes[0].primitives[0],mode:0}]}, ...base.doc.meshes.slice(1)] };
  expect(() => inspectGlb(array(encodeGlb(points,base.binary)))).toThrow(/点或线/);
});
test("external images, unknown required codecs, malformed GLB, empty and expanded budgets fail before loader", () => {
  const {doc,binary,bytes} = modelFixture();
  expect(() => inspectGlb(array(bytes.subarray(0, 50)))).toThrow(/长度/);
  expect(() => inspectGlb(array(encodeGlb({...doc,images:[{uri:"https://example.invalid/texture.png"}]},binary)))).toThrow(/URI/);
  expect(() => inspectGlb(array(encodeGlb({...doc,extensionsRequired:["KHR_draco_mesh_compression"]},binary)))).toThrow(/required/);
  expect(() => inspectGlb(array(encodeGlb({...doc,extensionsRequired:["NOT_SUPPORTED"]},binary)))).toThrow(/required/);
  expect(() => inspectGlb(array(encodeGlb({asset:{version:"2.0"},scenes:[{nodes:[]}]},Buffer.alloc(0))))).toThrow(/非空/);
  expect(() => inspectGlb(array(encodeGlb({...doc, accessors:[{type:"VEC3",componentType:5126,count:100000000}]},binary)))).toThrow(/预算/);
  expect(() => inspectGlb(array(encodeGlb({...doc,extensionsUsed:["OPTIONAL_UNKNOWN"]},binary)))).toThrow(/不支持扩展/);
  expect(() => inspectGlb(array(encodeGlb({...doc,materials:[{extensions:{KHR_materials_transmission:{transmissionFactor:1}}}]},binary)))).toThrow(/KHR_materials_transmission/);
});
