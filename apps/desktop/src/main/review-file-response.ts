import { open } from "node:fs/promises";
import { Readable } from "node:stream";

/** Serve a registered original with bounded memory and standard single-byte ranges. */
export async function reviewFileResponse(request: Request, resource: { path: string; mime: string }): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const file = await open(resource.path, "r");
  let streaming = false;
  try {
    const { size } = await file.stat();
    const headers = new Headers({ "Content-Type": resource.mime, "Accept-Ranges": "bytes",
      "Cache-Control": "no-store", "Cross-Origin-Resource-Policy": "same-origin" });
    let start = 0;
    let end = size - 1;
    let status = 200;
    // Multiple or malformed ranges are ignored, as permitted by RFC 9110 §14.2.
    const range = request.method === "GET" ? /^bytes=(\d*)-(\d*)$/.exec(request.headers.get("range") ?? "") : null;
    if (range && (range[1] || range[2])) {
      if (range[1]) {
        start = Number(range[1]);
        if (range[2]) end = Math.min(Number(range[2]), size - 1);
      } else start = Math.max(0, size - Number(range[2]));
      if (!Number.isSafeInteger(start) || start >= size || start > end || !size) {
        headers.set("Content-Range", `bytes */${size}`);
        return new Response(null, { status: 416, headers });
      }
      status = 206;
      headers.set("Content-Range", `bytes ${start}-${end}/${size}`);
    }
    headers.set("Content-Length", String(Math.max(0, end - start + 1)));
    if (request.method === "HEAD" || !size) return new Response(null, { status, headers });
    const body = Readable.toWeb(file.createReadStream({ start, end, highWaterMark: 1024 * 1024, signal: request.signal })) as ReadableStream<Uint8Array>;
    const response = new Response(body, { status, headers });
    streaming = true; // The stream owns this handle, including cancellation and errors.
    return response;
  } finally {
    if (!streaming) await file.close();
  }
}
