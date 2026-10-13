import type {
  DecodeRequest,
  DecodeResponse,
  WorkerResponse,
} from "./decode-worker";
import {
  beginPerfOperation,
  endPerfOperation,
  failPerfOperation,
  markPerfOperation,
  type PerfOperation,
} from "../performance";

export interface FrameDecodeRequest {
  clipId: string;
  blob: Blob;
  time: number;
  width: number;
  height: number;
}

export interface FrameDecodeResult {
  clipId: string;
  bitmap: ImageBitmap | null;
  time: number;
  error?: string;
}

interface PendingRequest {
  resolve: (result: FrameDecodeResult) => void;
  reject: (error: Error) => void;
  clipId: string;
  startTime: number;
}

interface WorkerState {
  worker: Worker;
  workerId: number;
  busy: boolean;
  pendingRequests: Map<string, PendingRequest>;
  totalDecodes: number;
  totalDecodeTime: number;
  mediabunnyAvailable: boolean;
  failed: boolean;
}

export class ParallelFrameDecoder {
  private workers: WorkerState[] = [];
  private startingWorkers = new Set<Worker>();
  private pendingInitializations = new Set<() => void>();
  private requestQueue: Array<{
    request: FrameDecodeRequest;
    resolve: (result: FrameDecodeResult) => void;
    reject: (error: Error) => void;
  }> = [];
  private frameCache: Map<string, { bitmap: ImageBitmap; timestamp: number }> =
    new Map();
  private maxCacheSize = 100;
  private initialized = false;
  private initializationEpoch = 0;
  private initPromise: Promise<void> | null = null;
  private requestIdCounter = 0;
  private mediabunnyAvailable = false;

  constructor(private workerCount: number = 4) {
    this.workerCount = Math.max(
      1,
      Math.min(workerCount, navigator.hardwareConcurrency || 4),
    );
  }

  isAvailable(): boolean {
    return this.initialized && this.mediabunnyAvailable;
  }

  async initialize(parent?: PerfOperation): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.doInitialize(parent);
    return this.initPromise;
  }

  private async doInitialize(parent?: PerfOperation): Promise<void> {
    const epoch = this.initializationEpoch;
    const initializeOperation = beginPerfOperation("parallel_decoder.initialize", parent);
    if (initializeOperation) {
      markPerfOperation(initializeOperation, "parallel_decoder.initialize_started", {
        worker_count: this.workerCount,
      });
    }
    const workerPromises: Promise<WorkerState>[] = [];
    for (let i = 0; i < this.workerCount; i++) {
      workerPromises.push(this.createWorker(i, initializeOperation));
    }

    try {
      const workers = await Promise.all(workerPromises);
      if (epoch !== this.initializationEpoch) throw new Error("Decoder disposed");
      this.workers = workers.filter((worker) => !worker.failed);
    } catch (error) {
      failPerfOperation(initializeOperation, error);
      // Init failed: terminate all created workers (ready or still starting),
      // then rethrow the original rejection to preserve its timing/identity.
      if (epoch === this.initializationEpoch) {
        this.stopStartingWorkers();
        this.workers = [];
      }
      throw error;
    }
    this.startingWorkers.clear();
    this.mediabunnyAvailable = this.workers.some((w) => w.mediabunnyAvailable);
    this.initialized = true;
    endPerfOperation(
      initializeOperation,
      "ok",
      initializeOperation
        ? {
            worker_count: this.workers.length,
            available_worker_count: this.workers.filter((worker) => worker.mediabunnyAvailable).length,
          }
        : undefined,
    );
  }

  private async createWorker(
    index: number,
    parent: PerfOperation | undefined,
  ): Promise<WorkerState> {
    return new Promise((resolve, reject) => {
      const operation = beginPerfOperation("parallel_decoder.worker_initialize", parent);
      if (operation) {
        markPerfOperation(operation, "parallel_decoder.worker_initialize_started", {
          worker_index: index,
        });
      }
      let worker: Worker;
      try {
        worker = new Worker(new URL("./decode-worker.ts", import.meta.url), { type: "module" });
        this.startingWorkers.add(worker);
        if (operation) {
          markPerfOperation(operation, "parallel_decoder.worker_spawned", {
            worker_index: index,
          });
        }
      } catch (error) {
        failPerfOperation(operation, error);
        reject(error);
        return;
      }

      const state: WorkerState = {
        worker,
        workerId: index,
        busy: false,
        pendingRequests: new Map(),
        totalDecodes: 0,
        totalDecodeTime: 0,
        mediabunnyAvailable: false,
        failed: false,
      };

      let initializationSettled = false;
      const failInitialization = (error: unknown, outcome?: "timeout") => {
        if (initializationSettled) return;
        initializationSettled = true;
        clearTimeout(initTimeout);
        this.pendingInitializations.delete(cancelInitialization);
        if (outcome === "timeout") endPerfOperation(operation, "timeout");
        else failPerfOperation(operation, error);
        reject(error);
      };

      const initTimeout = setTimeout(() => {
        const error = new Error(`Worker ${index} initialization timed out`);
        failInitialization(error, "timeout");
      }, 10000);
      const cancelInitialization = () => failInitialization(new Error("Decoder disposed"));
      this.pendingInitializations.add(cancelInitialization);

      worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const response = event.data;

        if (response.type === "ready") {
          if (initializationSettled) return;
          initializationSettled = true;
          clearTimeout(initTimeout);
          this.pendingInitializations.delete(cancelInitialization);
          state.workerId = response.workerId;
          state.mediabunnyAvailable = response.mediabunnyAvailable ?? false;
          if (operation) {
            markPerfOperation(operation, "parallel_decoder.worker_ready", {
              mediabunny_available: state.mediabunnyAvailable,
            });
          }
          endPerfOperation(
            operation,
            "ok",
            operation ? { mediabunny_available: state.mediabunnyAvailable } : undefined,
          );
          resolve(state);
          return;
        }

        if (response.type === "decoded") {
          this.handleDecodeResponse(state, response);
        }
      };

      worker.onerror = (error) => {
        console.error(`[ParallelFrameDecoder] Worker ${index} error:`, error);
        clearTimeout(initTimeout);
        if (!initializationSettled) {
          failInitialization(error);
          return;
        }
        // A ready worker can still crash. Retire it and settle its requests so
        // callers can use the existing sequential decoder instead of hanging.
        state.failed = true;
        worker.onerror = null;
        state.mediabunnyAvailable = false;
        this.startingWorkers.delete(worker);
        this.workers = this.workers.filter((entry) => entry !== state);
        worker.terminate();
        for (const pending of state.pendingRequests.values()) {
          pending.reject(new Error("Decode worker failed"));
        }
        state.pendingRequests.clear();
        this.mediabunnyAvailable = this.workers.some((entry) => entry.mediabunnyAvailable);
        if (this.workers.length === 0) {
          for (const item of this.requestQueue) item.reject(new Error("Decode workers unavailable"));
          this.requestQueue = [];
        } else {
          this.processQueue();
        }
      };

      try {
        worker.postMessage({ type: "init" });
      } catch (error) {
        clearTimeout(initTimeout);
        failInitialization(error);
      }
    });
  }

  private async handleDecodeResponse(
    state: WorkerState,
    response: DecodeResponse,
  ): Promise<void> {
    const pending = state.pendingRequests.get(response.requestId);
    if (!pending) {
      response.bitmap?.close();
      console.warn(
        `[ParallelFrameDecoder] No pending request for ${response.requestId}`,
      );
      return;
    }

    state.pendingRequests.delete(response.requestId);
    state.busy = state.pendingRequests.size > 0;

    const decodeTime = performance.now() - pending.startTime;
    state.totalDecodes++;
    state.totalDecodeTime += decodeTime;

    let bitmapForCaller: ImageBitmap | null = null;

    if (response.bitmap) {
      const cacheKey = `${response.clipId}:${response.time.toFixed(3)}`;
      this.addToCache(cacheKey, response.bitmap);
      try {
        bitmapForCaller = await createImageBitmap(response.bitmap);
      } catch {
        bitmapForCaller = null;
      }
    }

    pending.resolve({
      clipId: response.clipId,
      bitmap: bitmapForCaller,
      time: response.time,
      error: response.error,
    });

    this.processQueue();
  }

  private addToCache(key: string, bitmap: ImageBitmap): void {
    if (this.frameCache.size >= this.maxCacheSize) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;

      for (const [k, v] of this.frameCache) {
        if (v.timestamp < oldestTime) {
          oldestTime = v.timestamp;
          oldestKey = k;
        }
      }

      if (oldestKey) {
        const old = this.frameCache.get(oldestKey);
        old?.bitmap.close();
        this.frameCache.delete(oldestKey);
      }
    }

    this.frameCache.set(key, { bitmap, timestamp: performance.now() });
  }

  private getLeastBusyWorker(): WorkerState | null {
    let leastBusy: WorkerState | null = null;
    let minPending = Infinity;

    for (const worker of this.workers) {
      if (worker.pendingRequests.size < minPending) {
        minPending = worker.pendingRequests.size;
        leastBusy = worker;
      }
    }

    return leastBusy;
  }

  private processQueue(): void {
    while (this.requestQueue.length > 0) {
      const worker = this.getLeastBusyWorker();
      if (!worker || worker.pendingRequests.size >= 2) {
        break;
      }

      const item = this.requestQueue.shift();
      if (item) {
        this.sendDecodeRequest(worker, item.request, item.resolve, item.reject);
      }
    }
  }

  private sendDecodeRequest(
    worker: WorkerState,
    request: FrameDecodeRequest,
    resolve: (result: FrameDecodeResult) => void,
    reject: (error: Error) => void,
  ): void {
    const requestId = `req_${this.requestIdCounter++}`;

    const pending: PendingRequest = {
      resolve,
      reject,
      clipId: request.clipId,
      startTime: performance.now(),
    };

    worker.pendingRequests.set(requestId, pending);
    worker.busy = true;

    const decodeRequest: DecodeRequest = {
      type: "decode",
      requestId,
      clipId: request.clipId,
      blob: request.blob,
      time: request.time,
      width: request.width,
      height: request.height,
    };

    worker.worker.postMessage(decodeRequest);
  }

  clearCache(): void {
    for (const [, cached] of this.frameCache) {
      cached.bitmap.close();
    }
    this.frameCache.clear();
  }

  private stopStartingWorkers(): void {
    for (const cancel of this.pendingInitializations) cancel();
    for (const worker of this.startingWorkers) worker.terminate();
    this.pendingInitializations.clear();
    this.startingWorkers.clear();
  }

  dispose(): void {
    this.initializationEpoch++;
    this.stopStartingWorkers();
    for (const worker of this.workers) {
      for (const [, pending] of worker.pendingRequests) {
        pending.reject(new Error("Decoder disposed"));
      }
      worker.worker.terminate();
    }
    this.workers = [];

    this.clearCache();

    for (const item of this.requestQueue) {
      item.reject(new Error("Decoder disposed"));
    }
    this.requestQueue = [];

    this.initialized = false;
    this.initPromise = null;
  }
}

let parallelDecoderInstance: ParallelFrameDecoder | null = null;

export function getParallelFrameDecoder(): ParallelFrameDecoder {
  if (!parallelDecoderInstance) {
    const workerCount = Math.min(4, navigator.hardwareConcurrency || 4);
    parallelDecoderInstance = new ParallelFrameDecoder(workerCount);
  }
  return parallelDecoderInstance;
}

export async function initializeParallelDecoder(
  workerCount?: number,
): Promise<ParallelFrameDecoder> {
  if (parallelDecoderInstance) {
    parallelDecoderInstance.dispose();
  }
  parallelDecoderInstance = new ParallelFrameDecoder(workerCount);
  await parallelDecoderInstance.initialize();
  return parallelDecoderInstance;
}

export function disposeParallelDecoder(): void {
  if (parallelDecoderInstance) {
    parallelDecoderInstance.dispose();
    parallelDecoderInstance = null;
  }
}
