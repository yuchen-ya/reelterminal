/**
 * The font.* verb contract (user-level custom fonts).
 *
 * Custom fonts are USER-level state: they live in the desktop GUI renderer's
 * IndexedDB (the legacy custom-fonts store name, registered in
 * packages/core/src/legacy/physical-identifiers.ts) and are activated there
 * through the FontFace API — the exact same registration path the GUI upload
 * button uses. In live sessions the facade stays stateless: font.upload validates
 * params here and forwards the bytes through the narrow `FontLibraryBridge`
 * to the renderer, which owns registration, dedup, persistence and listing.
 * Headless sessions honestly report the verbs UNSUPPORTED (there is no GUI
 * renderer and therefore no font store).
 *
 * Duplicate policy mirrors the GUI: uploading a font whose base name already
 * exists never overwrites and never fails — the family is deduped with a
 * numeric suffix ("Bar" -> "Bar 2") and the response returns the ACTUAL
 * fontFamily, which callers must use verbatim in text styling.
 */
export const FONT_VERBS = ["font.upload", "font.list"] as const;

export type FontVerb = (typeof FONT_VERBS)[number];

/**
 * The GUI sets no size limit on manual uploads; for agent input a
 * conservative 10 MiB cap guards the bridge (fonts above it are rare and
 * huge CJK families belong to the human's own uploads).
 */
export const FONT_LIBRARY_LIMITS = {
  maxFontBytes: 10 * 1024 * 1024,
  maxNameLength: 120,
  formats: ["ttf", "otf", "woff", "woff2"] as const,
} as const;

export type FontFormat = (typeof FONT_LIBRARY_LIMITS.formats)[number];

/* ------------------------------ params ------------------------------ */

export interface FontUploadParams {
  /**
   * Desired font family. Optional: defaults to the file name (extension
   * stripped) for filePath input. The response reports the ACTUAL family —
   * a duplicate base name comes back suffixed, never overwritten.
   */
  readonly name?: string;
  /** Absolute local path inside a configured media root. */
  readonly filePath?: string;
  /** Raw font bytes, base64-encoded (exactly one of filePath/dataBase64). */
  readonly dataBase64?: string;
}

export interface FontListParams {
  /** font.list takes no parameters; declared for contract symmetry. */
  readonly placeholder?: never;
}

/* ------------------------------ results ----------------------------- */

export interface FontUploadResult {
  readonly fontFamily: string;
  readonly format: FontFormat;
  readonly sizeBytes: number;
  /** True when the assigned family differs from the requested base name. */
  readonly deduped: boolean;
}

export interface CustomFontListItem {
  readonly family: string;
  readonly format: FontFormat | null;
  readonly sizeBytes: number | null;
  readonly uploadedAt: number | null;
  /** False for persisted fonts that this renderer session has not loaded. */
  readonly loadedInSession: boolean;
}

export interface FontListResult {
  readonly fonts: readonly CustomFontListItem[];
}

/* --------------------------- the bridge seam ------------------------- */

/** JSON-safe forward request the facade sends to the renderer. */
export type FontLibraryBridgeVerb = "upload" | "list";

export interface FontLibraryBridgeRequest {
  readonly verb: FontLibraryBridgeVerb;
  readonly params: Record<string, unknown>;
}

export interface FontLibraryBridgeError {
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
}

export type FontLibraryBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: FontLibraryBridgeError };

/**
 * The renderer seam: implementations (desktop main → IPC → web renderer)
 * execute against the canonical custom-font store and return detached
 * JSON-safe values. Errors carry stable codes; the byte-level format
 * validation happens renderer-side where FontFace runs.
 */
export type FontLibraryBridge = (
  request: FontLibraryBridgeRequest,
) => Promise<FontLibraryBridgeReply>;

/** Capability block reported by capabilities.get. */
export interface FontLibraryCapability {
  readonly available: boolean;
  readonly reason?: string;
  readonly formats: readonly FontFormat[];
  readonly maxFontBytes: number;
  readonly inputs: readonly ["filePath", "dataBase64"];
  /** Same-name uploads are suffixed ("Bar" -> "Bar 2"), never overwritten. */
  readonly duplicatePolicy: "suffix";
  /** The canonical renderer store (GUI and agent share it). */
  readonly persistence: "renderer-indexeddb";
}
