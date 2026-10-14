import { afterEach, expect, it, vi } from "vitest";
import { WebGPURenderer } from "./webgpu-renderer-impl";

afterEach(() => vi.unstubAllGlobals());
it("keeps distinct transform uniforms for every queued layer until submission", () => {
  vi.stubGlobal("OffscreenCanvas", class {});
  vi.stubGlobal("GPUBufferUsage", { UNIFORM: 64, COPY_DST: 8 });
  const contents = new Map<object, Float32Array>();
  const device = {
    destroy: vi.fn(),
    createBuffer: vi.fn(() => ({ destroy: vi.fn() })),
    createBindGroup: (descriptor: any) => descriptor,
    queue: { writeBuffer: (buffer: object, _offset: number, bytes: ArrayBuffer) => contents.set(buffer, new Float32Array(bytes.slice(0))) },
  };
  const renderer = new WebGPURenderer({ canvas: {} as HTMLCanvasElement, width: 1920, height: 1080 });
  const r = renderer as any;
  Object.assign(r, { device, textureSampler: {}, transformPipeline: {}, borderRadiusPipeline: {}, transformUniformLayout: {}, transformTextureLayout: {}, borderRadiusUniformLayout: {}, borderRadiusTextureLayout: {} });
  r.createUniformBuffers();
  const bound: object[] = [];
  let current: any;
  const pass = { setPipeline() {}, setBindGroup(index: number, group: any) { if (index === 0) current = group.entries[0].resource.buffer; }, draw() { bound.push(current); } };
  const layer = (x: number, radius = 0) => ({ texture: { createView: () => ({}) }, transform: { position: { x, y: 0 }, scale: { x: .3, y: .3 }, rotation: 0, anchor: { x: .5, y: .5 }, opacity: 1 }, opacity: 1, effects: [], borderRadius: radius });
  renderer.beginFrame();
  [layer(-500), layer(500), layer(0, 10), layer(100, 10)].forEach(l => renderer.renderLayer(l as any));
  r.renderLayersToPass(pass);
  expect(new Set(bound).size).toBe(4);
  expect(contents.get(bound[0]!)).not.toEqual(contents.get(bound[1]!));
  expect(contents.get(bound[2]!)).not.toEqual(contents.get(bound[3]!));
  const allocated = device.createBuffer.mock.calls.length;
  renderer.beginFrame();
  [layer(-500), layer(500)].forEach(l => renderer.renderLayer(l as any));
  r.renderLayersToPass(pass);
  expect(device.createBuffer.mock.calls.length).toBe(allocated);
  renderer.destroy();
  for (const { value } of device.createBuffer.mock.results) expect(value.destroy).toHaveBeenCalledOnce();
});
