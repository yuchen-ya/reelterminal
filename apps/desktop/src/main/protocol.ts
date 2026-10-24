import { protocol, net } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { reviewFileResponse } from "./review-file-response";

const SCHEME = "app";

export function registerAppSchemePrivileges(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

export function handleAppScheme(rendererRoot: string, resolveReviewResource?: (id: string) => Promise<{ path: string; mime: string }>): void {
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.startsWith("/review-media/")) {
      const id = pathname.slice("/review-media/".length);
      if (url.host !== "reelterminal" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) || !resolveReviewResource) return new Response("Not found", { status: 404 });
      try {
        const resource = await resolveReviewResource(id);
        return await reviewFileResponse(request, resource);
      } catch (error) {
        const problem = error as { code?: string; reason?: string };
        if (problem.code === "ENOENT" || problem.reason === "MISSING_FILE") return new Response("Review original is missing", { status: 404 });
        if (problem.reason === "SOURCE_CHANGED") return new Response("Review original changed", { status: 409 });
        throw error;
      }
    }
    if (pathname === "/" || pathname === "") pathname = "/index.html";
    if (pathname === "/motion") pathname = "/index.html";

    const root = path.normalize(rendererRoot);
    const resolved = path.normalize(path.join(root, pathname));
    const rel = path.relative(root, resolved);
    if (rel !== "" && (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel))) {
      return new Response("Forbidden", { status: 403 });
    }

    let response: Response;
    try {
      response = await net.fetch(pathToFileURL(resolved).toString());
    } catch {
      response = await net.fetch(pathToFileURL(path.join(rendererRoot, "index.html")).toString());
    }

    const headers = new Headers(response.headers);
    headers.set("Content-Security-Policy", "default-src 'self' blob: data: https: http:; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; frame-src 'none'");
    headers.set("Cross-Origin-Opener-Policy", "same-origin");
    headers.set("Cross-Origin-Embedder-Policy", "require-corp");
    headers.set("Cross-Origin-Resource-Policy", "same-origin");
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  });
}

// Module-local: APP_INDEX is the only published derived value.
const APP_ORIGIN = `${SCHEME}://reelterminal`;
export const APP_INDEX = `${APP_ORIGIN}/index.html`;
