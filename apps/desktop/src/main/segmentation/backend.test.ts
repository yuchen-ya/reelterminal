import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { PromptableSegmentationBackend } from "./backend";
import type { SegmentationRequest } from "./types";

let directory: string;
let backend: PromptableSegmentationBackend;

function request(id: string): SegmentationRequest {
  return {
    refinementId: "edit-1",
    frame: { id, revision: "v1", width: 2, height: 1, rotation: 0, rgba: new Uint8Array(8) },
    prompts: { points: [{ x: 0.5, y: 0.5, foreground: true }] },
  };
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "reel-segmentation-scheduler-"));
  const workerPath = join(directory, "scheduler-fixture.cjs");
  // Protocol fixture tests ordering/cancellation only; it is not a segmentation model.
  await writeFile(workerPath, `
    const {parentPort}=require('node:worker_threads');
    const emitted=new Map();
    const accepted=new Set();
    parentPort.on('message', message=>{
      if(message.type==='accept'){accepted.add(emitted.get(message.sequence));return;}
      if(message.type==='reset-refinement'||message.type==='clear'){accepted.clear();return;}
      if(message.type!=='segment') return;
      setTimeout(()=>{emitted.set(message.sequence,message.request.frame.id);parentPort.postMessage({type:'result',sequence:message.sequence,mask:{
        frameId:message.request.frame.id,frameRevision:message.request.frame.revision,refinementId:message.request.refinementId,
        width:2,height:1,alpha:new Uint8Array([0,255]),predictedIou:message.sequence,embeddingReused:false,priorMaskUsed:accepted.has(message.request.frame.id)
      }})},50);
    });
  `);
  backend = new PromptableSegmentationBackend({ workerPath, encoderPath: join(directory, "encoder"), decoderPath: join(directory, "decoder") });
});

afterEach(async () => {
  await backend.dispose();
  await rm(directory, { recursive: true, force: true });
});

it("keeps only the latest correction, rejects superseded requests and never accepts another image's result", async () => {
  const first = backend.segment(request("image-a")).catch(error => error.name);
  const second = backend.segment(request("image-a")).catch(error => error.name);
  const third = backend.segment(request("image-b")).catch(error => error.name);
  const latest = backend.segment(request("image-c"));
  expect(await first).toBe("AbortError");
  expect(await second).toBe("AbortError");
  expect(await third).toBe("AbortError");
  expect(await latest).toMatchObject({ frameId: "image-c", predictedIou: 4 });
});

it("cancels active and queued work with AbortSignal and remains usable for the next image", async () => {
  const activeController = new AbortController();
  const active = backend.segment(request("a"), activeController.signal).catch(error => error.name);
  activeController.abort();
  expect(await active).toBe("AbortError");
  const queuedController = new AbortController();
  const queued = backend.segment(request("b"), queuedController.signal).catch(error => error.name);
  queuedController.abort();
  expect(await queued).toBe("AbortError");
  expect(await backend.segment(request("c"))).toMatchObject({ frameId: "c" });
});

it("cancels outstanding requests on cache reset and disposal", async () => {
  const pending = backend.segment(request("a")).catch(error => error.name);
  backend.clearCache();
  expect(await pending).toBe("AbortError");
  const next = backend.segment(request("b")).catch(error => error.name);
  await backend.dispose();
  expect(await next).toBe("AbortError");
  await expect(backend.segment(request("c"))).rejects.toThrow(/disposed/);
});

it("requires an explicit stable refinement ID and exposes the real prompt capacity", async () => {
  expect(backend.promptTokenLimit).toBe(32);
  await expect(backend.segment({ ...request("a"), refinementId: "" })).rejects.toThrow(/refinementId/);
  const pending = backend.segment(request("a")).catch(error => error.name);
  backend.resetRefinement();
  expect(await pending).toBe("AbortError");
});

it("acknowledges only the latest result, and refinement reset clears accepted history", async () => {
  const old = backend.segment(request("same-image")).catch(error => error.name);
  const latest = backend.segment(request("same-image"));
  expect(await old).toBe("AbortError");
  expect((await latest).priorMaskUsed).toBe(false);
  expect((await backend.segment(request("same-image"))).priorMaskUsed).toBe(true);
  backend.resetRefinement();
  expect((await backend.segment(request("same-image"))).priorMaskUsed).toBe(false);
});
