/** Pure lexical gate: run before filesystem resolution on every platform. */
export function isForbiddenLocalPath(value: string): boolean {
  const normalized = value.trim().replace(/\\/g, "/");
  // UNC, Win32 extended/device paths, and NT object-manager namespaces.
  return normalized.includes("\0") || normalized.startsWith("//") ||
    /^\/(?:\?\?\/|Device\/|GLOBALROOT\/)/i.test(normalized);
}

/** Remote file authorities can cause Windows network resolution. */
export function hasRemoteFileAuthority(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "file:" && url.hostname !== "" &&
      url.hostname.toLowerCase() !== "localhost";
  } catch {
    return true;
  }
}
