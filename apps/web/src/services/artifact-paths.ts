/** Canonical comparison keys only; deletion always uses the producer's native path. */
export function artifactPathKey(value: string): string | undefined {
  let path = value;
  if (path.startsWith("file://")) {
    let url: URL;
    try { url = new URL(path); } catch { return undefined; }
    try { path = decodeURIComponent(url.pathname); } catch { return undefined; }
    if (url.hostname) path = `//${url.hostname}${path}`;
    else if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1);
  }
  const windows = /^[A-Za-z]:[\\/]/.test(path) || /^\\\\[^\\]/.test(path) || path.startsWith("//");
  if (!windows && !path.startsWith("/")) return undefined;
  const parts: string[] = [];
  const rootParts = windows ? /^[A-Za-z]:/.test(path) ? 1 : 2 : 0;
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") { if (parts.length > rootParts) parts.pop(); }
    else parts.push(part);
  }
  const normalized = `${windows && /^[A-Za-z]:/.test(path) ? "" : path.startsWith("//") || path.startsWith("\\\\") ? "//" : "/"}${parts.join("/")}`;
  // Retention uses a conservative key: case/Unicode aliases may refer to the
  // same file on Windows or macOS. A collision retains bytes, never deletes them.
  return normalized.normalize("NFC").toLowerCase();
}

/** Projects and journals contain plain records, blobs and embedded font bytes. */
export function collectArtifactPaths(value: unknown, paths = new Set<string>()): Set<string> {
  const seen = new WeakSet<object>();
  const visit = (entry: unknown): void => {
    if (typeof entry === "string") {
      const key = artifactPathKey(entry);
      if (key) paths.add(key);
      return;
    }
    if (!entry || typeof entry !== "object" || seen.has(entry)) return;
    seen.add(entry);
    if (ArrayBuffer.isView(entry) || entry instanceof ArrayBuffer || entry instanceof Blob) return;
    for (const child of Object.values(entry)) visit(child);
  };
  visit(value);
  return paths;
}
