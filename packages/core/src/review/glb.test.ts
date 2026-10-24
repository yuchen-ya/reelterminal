import { expect, test } from "vitest";
import { inspectGlb } from "./glb";
import { encodeGlb, modelFixture } from "./glb-fixtures.test-helper";
const array = (bytes: Buffer) => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
test("real embedded PBR/alpha, skeletal and morph fixture passes bounded preflight", () => {
  const fixture = modelFixture();
  expect(inspectGlb(array(fixture.bytes))).toMatchObject({ scenes:1, meshes:3, triangles:6, instances:3, texturePixels:16, warnings:[] });
});
test("external images, unknown required codecs, malformed GLB, empty and expanded budgets fail before loader", () => {
  const {doc,binary,bytes} = modelFixture();
  expect(() => inspectGlb(array(bytes.subarray(0, 50)))).toThrow(/长度/);
  expect(() => inspectGlb(array(encodeGlb({...doc,images:[{uri:"https://example.invalid/texture.png"}]},binary)))).toThrow(/URI/);
  expect(() => inspectGlb(array(encodeGlb({...doc,extensionsRequired:["KHR_draco_mesh_compression"]},binary)))).toThrow(/required/);
  expect(() => inspectGlb(array(encodeGlb({...doc,extensionsRequired:["NOT_SUPPORTED"]},binary)))).toThrow(/required/);
  expect(() => inspectGlb(array(encodeGlb({asset:{version:"2.0"},scenes:[{nodes:[]}]},Buffer.alloc(0))))).toThrow(/非空/);
  expect(() => inspectGlb(array(encodeGlb({...doc, accessors:[{type:"VEC3",componentType:5126,count:100000000}]},binary)))).toThrow(/预算/);
  expect(inspectGlb(array(encodeGlb({...doc,extensionsUsed:["OPTIONAL_UNKNOWN"]},binary))).warnings).toHaveLength(1);
});
