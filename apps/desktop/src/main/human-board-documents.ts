import { randomUUID } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { FileResource } from "@reelterminal/core/review/types";
import { getReviewFileStore } from "./ipc/review-files";

export interface DocumentAsset { path: string; resourceId?: string; mime?: string; missing?: string }
const mimeTypes: Record<string, string> = { ".md": "text/markdown", ".html": "text/html", ".htm": "text/html", ".css": "text/css", ".js": "text/javascript", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".gif": "image/gif", ".webp": "image/webp", ".woff": "font/woff", ".woff2": "font/woff2", ".mp4": "video/mp4" };

export function documentReferences(source: string): string[] {
  const references = new Set<string>();
  for (const pattern of [/!?\[[^\]]*\]\(\s*<?([^\s)>]+)>?(?:\s+[^)]*)?\)/g, /^\s*\[[^\]]+\]:\s*<?([^\s>]+)/gm, /\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/gi, /url\(\s*["']?([^\s)'";]+)["']?\s*\)/gi, /@import\s+["']([^"']+)["']/gi]) {
    for (const match of source.matchAll(pattern)) references.add(match[1]);
  }
  return [...references].filter(value => value && !/^(?:[a-z][a-z\d+.-]*:|\/|#|\\)/i.test(value));
}

export function isDocumentPathWithin(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return !!relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export function decodeDocument(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
  try { return new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch (error) { if (!(error instanceof TypeError)) throw error; throw new Error("文档需要使用 UTF-8，或带 BOM 的 UTF-16 编码"); }
}

/** Copy only referenced files under this document's directory, including linked documents. */
export async function importBoardDocument(sourcePath: string) {
  const original = await realpath(sourcePath);
  const root = path.dirname(original);
  if ((await stat(original)).size > 2 * 1024 * 1024) throw new Error("文档超过 2 MiB");
  const source = decodeDocument(await readFile(original));
  if (source.length > 200000) throw new Error("单条文档最多 200000 字符");
  const assets: DocumentAsset[] = [];
  const resources: FileResource[] = [];
  const visited = new Set<string>([original]);
  const queue = [{ file: original, source }];
  let totalBytes = 0;
  while (queue.length) {
    const document = queue.shift()!;
    for (const reference of documentReferences(document.source)) {
      let decoded: string;
      try { decoded = decodeURIComponent(reference.split(/[?#]/)[0]); }
      catch (error) { if (!(error instanceof URIError)) throw error; assets.push({ path: reference, missing: "无效路径编码" }); continue; }
      const candidate = path.resolve(path.dirname(document.file), decoded);
      const relative = path.relative(root, candidate).split(path.sep).join("/");
      if (visited.has(candidate)) {
        // Linked Markdown documents can point back to the imported root after
        // the source directory is gone, too.
        if (candidate === original && !assets.some(asset => asset.path === relative)) {
          const resource = await getReviewFileStore().prepare({ sourcePath: original, operationId: randomUUID(), resourceId: randomUUID(), mime: mimeTypes[path.extname(original).toLowerCase()] ?? "text/plain", source: "user" });
          resources.push(resource); assets.push({ path: relative, resourceId: resource.id, mime: resource.mime });
        }
        continue;
      }
      visited.add(candidate);
      if (visited.size > 256) throw new Error("文档引用超过 256 个文件，请减少引用");
      if (!isDocumentPathWithin(root, candidate)) { assets.push({ path: relative, missing: "引用超出导入文档目录" }); continue; }
      let file: string;
      try { file = await realpath(candidate); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; assets.push({ path: relative, missing: "引用文件缺失" }); continue; }
      if (!isDocumentPathWithin(root, file)) { assets.push({ path: relative, missing: "引用链接超出导入文档目录" }); continue; }
      const facts = await stat(file);
      if (!facts.isFile()) { assets.push({ path: relative, missing: "引用不是文件" }); continue; }
      totalBytes += facts.size;
      if (totalBytes > 32 * 1024 * 1024) throw new Error("文档引用资产合计超过 32 MiB");
      const extension = path.extname(file).toLowerCase();
      const mime = mimeTypes[extension] ?? "application/octet-stream";
      const resource = await getReviewFileStore().prepare({ sourcePath: file, operationId: randomUUID(), resourceId: randomUUID(), mime, source: "user" });
      resources.push(resource);
      assets.push({ path: relative, resourceId: resource.id, mime });
      if ([".md", ".html", ".htm", ".css"].includes(extension)) {
        if (facts.size > 2 * 1024 * 1024) throw new Error(`引用文档超过 2 MiB：${relative}`);
        queue.push({ file, source: decodeDocument(await readFile(file)) });
      }
    }
  }
  return { source, assets, resources };
}
