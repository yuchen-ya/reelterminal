import { Input, ALL_FORMATS, BlobSource, CanvasSink } from "mediabunny";

export interface DecodeRequest {
  type: "decode";
  requestId: string;
  clipId: string;
  blob: Blob;
  time: number;
  width: number;
  height: number;
}

export interface DecodeResponse {
  type: "decoded";
  requestId: string;
  clipId: string;
  bitmap: ImageBitmap | null;
  time: number;
  error?: string;
}

export interface InitResponse {
  type: "ready";
  workerId: number;
  mediabunnyAvailable: boolean;
}

export type WorkerResponse = DecodeResponse | InitResponse;

// This entry is bundled with the installed decoder dependency. It never
// resolves a bare module from a Blob URL or downloads a second decoder version.
const scope = globalThis as unknown as {
  onmessage: (event: MessageEvent<DecodeRequest | { type: "init" }>) => void;
  postMessage(response: WorkerResponse, transfer?: Transferable[]): void;
};
const resourceCache = new Map<string, { input: Input; sink: CanvasSink }>();

async function getOrCreateResources(request: DecodeRequest) {
  const { clipId, blob, width, height } = request;
  const cacheKey = `${clipId}:${width}x${height}`;
  const cached = resourceCache.get(cacheKey);
  if (cached) return cached;

  const input = new Input({ source: new BlobSource(blob), formats: ALL_FORMATS });
  try {
    const videoTrack = await input.getPrimaryVideoTrack();
    if (!videoTrack) {
      input.dispose();
      return null;
    }
    const resource = {
      input,
      sink: new CanvasSink(videoTrack, { width, height, fit: "contain" }),
    };
    resourceCache.set(cacheKey, resource);
    return resource;
  } catch (error) {
    input.dispose();
    throw error;
  }
}

async function decodeFrame(request: DecodeRequest): Promise<DecodeResponse> {
  const response: DecodeResponse = {
    type: "decoded",
    requestId: request.requestId,
    clipId: request.clipId,
    bitmap: null,
    time: request.time,
  };
  try {
    const resources = await getOrCreateResources(request);
    if (!resources) return { ...response, error: "No video track" };
    const frame = await resources.sink.getCanvas(request.time);
    if (!frame?.canvas) return { ...response, error: "No frame at requested time" };
    return { ...response, bitmap: await createImageBitmap(frame.canvas) };
  } catch (error) {
    return {
      ...response,
      error: error instanceof Error ? error.message : "Unknown decode error",
    };
  }
}

scope.onmessage = async (event) => {
  if (event.data.type === "init") {
    // Receiving this message proves the local dependency finished loading.
    scope.postMessage({ type: "ready", workerId: 0, mediabunnyAvailable: true });
    return;
  }
  const response = await decodeFrame(event.data);
  scope.postMessage(response, response.bitmap ? [response.bitmap] : []);
};
