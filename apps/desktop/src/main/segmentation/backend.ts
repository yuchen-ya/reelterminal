import { isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";
import { displaySize, MAX_PROMPT_TOKENS, validateRequest } from "./geometry";
import type { SegmentationBackendOptions, SegmentationMask, SegmentationRequest, WorkerRequest, WorkerResponse } from "./types";

interface Pending {
  sequence: number;
  request: SegmentationRequest;
  resolve: (mask: SegmentationMask) => void;
  reject: (error: Error) => void;
  removeAbort: () => void;
  settled: boolean;
}

function aborted(): Error {
  return Object.assign(new Error("Segmentation request cancelled or superseded"), { name: "AbortError" });
}

/** One instance per task. At most one native inference and one latest queued request. */
export class PromptableSegmentationBackend {
  readonly promptTokenLimit = MAX_PROMPT_TOKENS;
  private worker: Worker | undefined;
  private sequence = 0;
  private active: Pending | undefined;
  private queued: Pending | undefined;
  private disposed = false;

  get isDisposed(): boolean { return this.disposed; }

  constructor(private readonly options: SegmentationBackendOptions) {
    if (![options.workerPath, options.encoderPath, options.decoderPath].every(isAbsolute)) {
      throw new Error("Worker and model paths must be absolute");
    }
  }

  /** Caller keeps the decoded RGBA buffer immutable until this promise settles. */
  async segment(request: SegmentationRequest, signal?: AbortSignal): Promise<SegmentationMask> {
    if (this.disposed) throw new Error("Segmentation backend is disposed");
    validateRequest(request);
    if (signal?.aborted) throw aborted();
    this.cancelPending();
    return new Promise((resolve, reject) => {
      const pending: Pending = {
        sequence: ++this.sequence, request, resolve, reject, settled: false, removeAbort: () => {},
      };
      if (signal) {
        const cancel = () => {
          if (this.queued === pending) this.queued = undefined;
          if (this.active === pending) this.post({ type: "cancel", sequence: pending.sequence });
          this.finish(pending, aborted());
        };
        signal.addEventListener("abort", cancel, { once: true });
        pending.removeAbort = () => signal.removeEventListener("abort", cancel);
      }
      this.queued = pending;
      this.pump();
    });
  }

  clearCache(): void {
    this.cancelPending();
    if (this.worker) this.post({ type: "clear" });
  }

  /** Clear accepted/staged low-res mask history while retaining cached image embeddings. */
  resetRefinement(): void {
    this.cancelPending();
    if (this.worker) this.post({ type: "reset-refinement" });
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.cancelPending();
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }

  private cancelPending(): void {
    if (this.queued) { this.finish(this.queued, aborted()); this.queued = undefined; }
    if (this.active && !this.active.settled) {
      this.post({ type: "cancel", sequence: this.active.sequence });
      this.finish(this.active, aborted());
    }
  }

  private finish(pending: Pending, error?: Error, mask?: SegmentationMask): void {
    if (pending.settled) return;
    pending.settled = true;
    pending.removeAbort();
    if (error) pending.reject(error);
    else pending.resolve(mask!);
  }

  private post(message: WorkerRequest): void { this.worker!.postMessage(message); }

  private pump(): void {
    if (this.active || !this.queued || this.disposed) return;
    if (!this.worker) {
      try {
        this.worker = new Worker(this.options.workerPath, { workerData: {
          encoderPath: this.options.encoderPath, decoderPath: this.options.decoderPath,
        } });
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      this.worker.on("message", (response: WorkerResponse) => this.receive(response));
      this.worker.on("error", error => this.fail(error));
      this.worker.on("exit", code => {
        if (!this.disposed) this.fail(new Error(`Segmentation worker exited unexpectedly (${code})`));
      });
    }
    this.active = this.queued;
    this.queued = undefined;
    this.post({ type: "segment", sequence: this.active.sequence, request: this.active.request });
  }

  private receive(response: WorkerResponse): void {
    const pending = this.active;
    if (!pending || response.sequence !== pending.sequence) {
      this.fail(new Error("Segmentation worker returned an unexpected sequence"));
      return;
    }
    this.active = undefined;
    if (!pending.settled) {
      if (response.type === "result") {
        const { frame } = pending.request;
        const size = displaySize(frame);
        const mask = response.mask;
        if (mask.frameId !== frame.id || mask.frameRevision !== frame.revision || mask.refinementId !== pending.request.refinementId ||
            mask.width !== size.width || mask.height !== size.height || mask.alpha.length !== size.width * size.height) {
          this.finish(pending, new Error("Segmentation result does not belong to the requested frame"));
        } else {
          this.post({ type: "accept", sequence: pending.sequence });
          this.finish(pending, undefined, mask);
        }
      } else this.finish(pending, response.type === "error" ? new Error(response.message) : aborted());
    }
    this.pump();
  }

  private fail(error: Error): void {
    this.disposed = true;
    if (this.active) this.finish(this.active, error);
    if (this.queued) this.finish(this.queued, error);
    this.active = this.queued = undefined;
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }
}
