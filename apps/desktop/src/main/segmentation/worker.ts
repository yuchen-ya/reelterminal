import { parentPort, workerData } from "node:worker_threads";
import { MobileSamCpu } from "./mobile-sam";
import { validateRequest } from "./geometry";
import type { SegmentationBackendOptions, WorkerRequest, WorkerResponse } from "./types";

const port = parentPort!;
const options = workerData as Pick<SegmentationBackendOptions, "encoderPath" | "decoderPath">;
const engine = new MobileSamCpu(options.encoderPath, options.decoderPath);
let activeSequence: number | undefined;
let cancelled = false;

port.on("message", async (message: WorkerRequest) => {
  if (message.type === "clear") { engine.clearCache(); return; }
  if (message.type === "reset-refinement") { engine.resetRefinement(); return; }
  if (message.type === "accept") { engine.accept(message.sequence); return; }
  if (message.type === "cancel") {
    if (activeSequence === message.sequence) cancelled = true;
    engine.cancel(message.sequence);
    return;
  }
  const { sequence, request } = message;
  if (activeSequence !== undefined) throw new Error("Segmentation worker received overlapping inference");
  activeSequence = sequence;
  cancelled = false;
  let response: WorkerResponse;
  try {
    validateRequest(request);
    const mask = await engine.segment(request, sequence, () => cancelled);
    response = mask ? { type: "result", sequence, mask } : { type: "cancelled", sequence };
  } catch (error) {
    // The worker boundary converts inference failures to an explicit request error.
    response = { type: "error", sequence, message: error instanceof Error ? error.message : String(error) };
  }
  activeSequence = undefined;
  if (response.type === "result") port.postMessage(response, [response.mask.alpha.buffer]);
  else port.postMessage(response);
});
