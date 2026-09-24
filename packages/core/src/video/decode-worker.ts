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
  mediabunnyAvailable?: boolean;
}

export type WorkerResponse = DecodeResponse | InitResponse;

export const decodeWorkerCode = `
const resourceCache = new Map();
let workerId = 0;
let mediabunnyModule = null;
let mediabunnyAvailable = false;

async function loadMediaBunny() {
 if (mediabunnyModule) {
 return mediabunnyModule;
 }
 try {
 mediabunnyModule = await import("mediabunny");
 mediabunnyAvailable = true;
 return mediabunnyModule;
 } catch (error) {
 try {
 mediabunnyModule = await import("https://esm.sh/mediabunny@1.25.3");
 mediabunnyAvailable = true;
 return mediabunnyModule;
 } catch (cdnError) {
 mediabunnyAvailable = false;
 return null;
 }
 }
}

async function getOrCreateResources(clipId, blob, width, height) {
 if (!mediabunnyAvailable || !mediabunnyModule) {
 return null;
 }

 // Key must include the requested size: a CanvasSink is fixed to the size it
 // was created with, so reusing one across different sizes would return
 // wrongly-sized frames.
 const cacheKey = clipId + ":" + width + "x" + height;
 const cached = resourceCache.get(cacheKey);
 if (cached) {
 return cached;
 }

 try {
 const { Input, ALL_FORMATS, BlobSource, CanvasSink } = mediabunnyModule;

 const input = new Input({
 source: new BlobSource(blob),
 formats: ALL_FORMATS,
 });

 const videoTrack = await input.getPrimaryVideoTrack();
 if (!videoTrack) {
 return null;
 }

 const sink = new CanvasSink(videoTrack, {
 width,
 height,
 fit: "contain",
 });

 const resource = {
 input,
 sink,
 videoTrack,
 blobUrl: URL.createObjectURL(blob),
 };

 resourceCache.set(cacheKey, resource);
 return resource;
 } catch (error) {
 return null;
 }
}

async function decodeFrame(request) {
 const { requestId, clipId, blob, time, width, height } = request;

 if (!mediabunnyAvailable) {
 return {
 type: "decoded",
 requestId,
 clipId,
 bitmap: null,
 time,
 error: "MediaBunny not available in worker",
 };
 }

 try {
 const resources = await getOrCreateResources(clipId, blob, width, height);
 if (!resources) {
 return {
 type: "decoded",
 requestId,
 clipId,
 bitmap: null,
 time,
 error: "Failed to create decode resources",
 };
 }

 const frameResult = await resources.sink.getCanvas(time);
 if (!frameResult?.canvas) {
 return {
 type: "decoded",
 requestId,
 clipId,
 bitmap: null,
 time,
 error: "No frame at requested time",
 };
 }

 const bitmap = await createImageBitmap(frameResult.canvas);

 return {
 type: "decoded",
 requestId,
 clipId,
 bitmap,
 time,
 };
 } catch (error) {
 return {
 type: "decoded",
 requestId,
 clipId,
 bitmap: null,
 time,
 error: error instanceof Error ? error.message : "Unknown decode error",
 };
 }
}

self.onmessage = async (event) => {
 const request = event.data;

 switch (request.type) {
 case "init":
 workerId = Math.floor(Math.random() * 10000);
 await loadMediaBunny();
 self.postMessage({ type: "ready", workerId, mediabunnyAvailable });
 break;

 case "decode":
 const response = await decodeFrame(request);
 if (response.bitmap) {
 self.postMessage(response, [response.bitmap]);
 } else {
 self.postMessage(response);
 }
 break;
 }
};
`;

export function createDecodeWorkerBlob(): Blob {
  return new Blob([decodeWorkerCode], { type: "application/javascript" });
}

export function createDecodeWorkerUrl(): string {
  const blob = createDecodeWorkerBlob();
  return URL.createObjectURL(blob);
}
