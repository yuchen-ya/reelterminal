import * as ort from "onnxruntime-node";
import { performance } from "node:perf_hooks";
import { EmbeddingCache } from "./embedding-cache";
import { displaySize, frameCacheKey, MODEL_INPUT_SIZE, promptTensors } from "./geometry";
import { preprocessFrame } from "./preprocess";
import { RefinementState } from "./refinement-state";
import type { SegmentationMask, SegmentationRequest } from "./types";

/** Worker-only CPU implementation for the pinned source-derived MobileSAM FP32 pair. */
export class MobileSamCpu {
  private sessions: Promise<{ encoder: ort.InferenceSession; decoder: ort.InferenceSession }> | undefined;
  private readonly embeddings = new EmbeddingCache<ort.Tensor>();
  private readonly refinement = new RefinementState<Float32Array>();
  private cacheGeneration = 0;

  constructor(private readonly encoderPath: string, private readonly decoderPath: string) {}

  clearCache(): void {
    this.cacheGeneration++;
    this.embeddings.clear();
    this.resetRefinement();
  }

  resetRefinement(): void { this.refinement.reset(); }
  accept(sequence: number): void { this.refinement.accept(sequence); }
  cancel(sequence: number): void { this.refinement.cancel(sequence); }

  private load() {
    this.sessions ??= (async () => {
      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1,
      };
      const encoder = await ort.InferenceSession.create(this.encoderPath, options);
      let decoder: ort.InferenceSession;
      try {
        decoder = await ort.InferenceSession.create(this.decoderPath, options);
      } catch (error) {
        await encoder.release();
        throw error;
      }
      if (encoder.inputNames.join(",") !== "images" || encoder.outputNames.join(",") !== "image_embeddings" ||
          decoder.inputNames.join(",") !== "image_embeddings,point_coords,point_labels,mask_input,has_mask_input,orig_im_size" ||
          decoder.outputNames.join(",") !== "masks,iou_predictions,low_res_masks") {
        await Promise.all([encoder.release(), decoder.release()]);
        throw new Error("ONNX models do not match the MobileSAM split contract");
      }
      return { encoder, decoder };
    })();
    return this.sessions;
  }

  async segment(request: SegmentationRequest, sequence: number, cancelled: () => boolean): Promise<SegmentationMask | null> {
    const started = performance.now();
    const generation = this.cacheGeneration;
    const timings = { loadMs: 0, preprocessMs: 0, encoderMs: 0, decoderMs: 0, workerMs: 0 };
    const loading = performance.now();
    const sessions = await this.load();
    timings.loadMs = performance.now() - loading;
    if (cancelled()) return null;
    const { frame, prompts, refinementId } = request;
    const { width, height } = displaySize(frame);
    const key = frameCacheKey(frame);
    const refinementVersion = this.refinement.begin(key, refinementId);
    const prior = this.refinement.prior(prompts);
    let embedding = this.embeddings.get(key);
    const embeddingReused = !!embedding;
    if (!embedding) {
      const preparing = performance.now();
      const pixels = preprocessFrame(frame);
      timings.preprocessMs = performance.now() - preparing;
      const encoding = performance.now();
      const output = await sessions.encoder.run({
        images: new ort.Tensor("float32", pixels, [1, 3, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE]),
      });
      timings.encoderMs = performance.now() - encoding;
      embedding = output.image_embeddings;
      if (embedding.type !== "float32" || embedding.dims.join(",") !== "1,256,64,64") {
        throw new Error("Unexpected MobileSAM image embedding shape/type");
      }
      if (generation === this.cacheGeneration) this.embeddings.set(key, embedding, 4 * 1024 * 1024);
    }
    if (cancelled()) return null;
    const { coords, labels } = promptTensors(prompts, width, height);
    const decoding = performance.now();
    const outputs = await sessions.decoder.run({
      image_embeddings: embedding,
      point_coords: new ort.Tensor("float32", coords, [1, labels.length, 2]),
      point_labels: new ort.Tensor("float32", labels, [1, labels.length]),
      mask_input: new ort.Tensor("float32", prior ?? new Float32Array(256 * 256), [1, 1, 256, 256]),
      has_mask_input: new ort.Tensor("float32", Float32Array.of(prior ? 1 : 0), [1]),
      orig_im_size: new ort.Tensor("float32", Float32Array.of(height, width), [2]),
    });
    timings.decoderMs = performance.now() - decoding;
    if (cancelled()) return null;
    const masks = outputs.masks;
    const scores = outputs.iou_predictions;
    const lowres = outputs.low_res_masks;
    if (masks.type !== "float32" || scores.type !== "float32" || lowres.type !== "float32" ||
        masks.dims.join(",") !== `1,4,${height},${width}` || scores.dims.join(",") !== "1,4" ||
        lowres.dims.join(",") !== "1,4,256,256") {
      throw new Error("Unexpected MobileSAM decoder mask shape/type");
    }
    const ious = scores.data as Float32Array;
    if (!ious.every(Number.isFinite)) throw new Error("MobileSAM produced non-finite IoU predictions");
    // Official predictor: 1..3 for an ambiguous single click; 0 for multiclick/box correction.
    let candidateIndex = 0;
    if (prompts.points.length === 1 && !prompts.box) {
      candidateIndex = 1;
      for (let index = 2; index < 4; index++) if (ious[index] > ious[candidateIndex]) candidateIndex = index;
    }
    const logits = masks.data as Float32Array;
    const alpha = new Uint8Array(width * height);
    const offset = candidateIndex * alpha.length;
    for (let index = 0; index < alpha.length; index++) {
      const logit = logits[offset + index];
      if (!Number.isFinite(logit)) throw new Error("MobileSAM produced non-finite mask logits");
      alpha[index] = logit > 0 ? 255 : 0;
    }
    const selectedLowres = Float32Array.from((lowres.data as Float32Array).subarray(candidateIndex * 256 * 256, (candidateIndex + 1) * 256 * 256));
    if (!selectedLowres.every(Number.isFinite)) throw new Error("MobileSAM produced non-finite refinement logits");
    if (generation === this.cacheGeneration) this.refinement.stage(sequence, prompts, selectedLowres, refinementVersion);
    timings.workerMs = performance.now() - started;
    return {
      frameId: frame.id, frameRevision: frame.revision, refinementId, width, height, alpha,
      predictedIou: ious[candidateIndex], embeddingReused, priorMaskUsed: !!prior, candidateIndex, timings,
    };
  }
}
