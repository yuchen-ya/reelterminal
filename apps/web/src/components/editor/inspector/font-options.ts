import { useEffect, useState } from "react";

const CUSTOM_FONT_EVENT = "openreel:custom-fonts-updated";

const DB_NAME = "openreel-custom-fonts";
const DB_VERSION = 1;
const STORE_FONTS = "fonts";

interface StoredFontRecord {
  family: string;
  data: ArrayBuffer;
  uploadedAt: number;
}

const customFonts: string[] = [];
/** Detected at registration; keeps listing honest when persistence failed. */
const customFontFormats = new Map<string, FontFormat>();

export const FONT_CATEGORIES = {
  Popular: [
    "Inter",
    "Poppins",
    "Montserrat",
    "Roboto",
    "Open Sans",
    "Lato",
    "Outfit",
    "DM Sans",
  ],
  "Display & Headlines": [
    "Bebas Neue",
    "Anton",
    "Oswald",
    "Teko",
    "Staatliches",
    "Alfa Slab One",
    "Archivo Black",
    "Black Ops One",
    "Titan One",
    "Righteous",
    "Concert One",
    "Fredoka One",
    "Bungee",
  ],
  "Elegant & Serif": [
    "Playfair Display",
    "Cinzel",
    "Lora",
    "Merriweather",
    "DM Serif Display",
    "Abril Fatface",
    "Roboto Slab",
    "Zilla Slab",
  ],
  "Modern & Clean": [
    "Lexend",
    "Quicksand",
    "Nunito",
    "Rubik",
    "Work Sans",
    "Raleway",
    "Ubuntu",
    "Space Grotesk",
    "Comfortaa",
  ],
  "Handwritten & Script": [
    "Pacifico",
    "Lobster",
    "Dancing Script",
    "Great Vibes",
    "Caveat",
    "Sacramento",
    "Satisfy",
    "Yellowtail",
    "Rock Salt",
    "Permanent Marker",
  ],
  "Fun & Creative": ["Bangers", "Creepster", "Press Start 2P"],
  Monospace: ["Roboto Mono", "Space Mono"],
  System: ["Arial", "Helvetica", "Times New Roman", "Georgia", "Verdana"],
} as const;

const FONT_EXTENSIONS = /\.(ttf|otf|woff2?)$/i;
export const FONT_FILE_ACCEPT = ".ttf,.otf,.woff,.woff2";

export type FontFormat = "ttf" | "otf" | "woff" | "woff2";

/**
 * Detects the container format from the byte signature: ttf `00 01 00 00`,
 * otf `OTTO`, woff `wOFF`, woff2 `wOF2`. Returns null for anything else so
 * callers can reject look-alike files before FontFace gives a generic error.
 */
export function detectFontFormat(data: ArrayBuffer): FontFormat | null {
  if (data.byteLength < 4) return null;
  const view = new DataView(data);
  const b0 = view.getUint8(0);
  const b1 = view.getUint8(1);
  const b2 = view.getUint8(2);
  const b3 = view.getUint8(3);
  if (b0 === 0x00 && b1 === 0x01 && b2 === 0x00 && b3 === 0x00) return "ttf";
  if (b0 === 0x4f && b1 === 0x54 && b2 === 0x54 && b3 === 0x4f) return "otf";
  if (b0 === 0x77 && b1 === 0x4f && b2 === 0x46 && b3 === 0x46) return "woff";
  if (b0 === 0x77 && b1 === 0x4f && b2 === 0x46 && b3 === 0x32) return "woff2";
  return null;
}

/** Stable codes so the agent bridge can map failures without parsing text. */
export type RegisterFontErrorCode =
  | "UNSUPPORTED_ENVIRONMENT"
  | "EMPTY_FONT_DATA"
  | "INVALID_FONT_DATA"
  | "FONT_LOAD_FAILED";

export type RegisterFontBytesResult =
  | { success: true; fontFamily: string; format: FontFormat }
  | { success: false; error: string; code: RegisterFontErrorCode };

function stripFontExtension(name: string): string {
  return name.replace(/\.(ttf|otf|woff2?)$/i, "");
}

function notifyCustomFontChange() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(CUSTOM_FONT_EVENT));
  }
}

function toUniqueFontFamily(baseFamily: string) {
  const family = baseFamily.trim() || "Custom Font";
  let candidate = family;
  let suffix = 2;

  while (customFonts.includes(candidate)) {
    candidate = `${family} ${suffix}`;
    suffix += 1;
  }

  return candidate;
}

function openFontsDB(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => resolve(null);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_FONTS)) {
        db.createObjectStore(STORE_FONTS, { keyPath: "family" });
      }
    };
  });
}

async function persistFont(family: string, data: ArrayBuffer): Promise<void> {
  const db = await openFontsDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_FONTS, "readwrite");
    const store = tx.objectStore(STORE_FONTS);
    const record: StoredFontRecord = { family, data, uploadedAt: Date.now() };
    store.put(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

async function loadStoredFonts(): Promise<StoredFontRecord[]> {
  const db = await openFontsDB();
  if (!db) return [];
  const records = await new Promise<StoredFontRecord[]>((resolve) => {
    const tx = db.transaction(STORE_FONTS, "readonly");
    const store = tx.objectStore(STORE_FONTS);
    const request = store.getAll();
    request.onsuccess = () => resolve((request.result as StoredFontRecord[]) ?? []);
    request.onerror = () => resolve([]);
  });
  db.close();
  return records;
}

export async function removeCustomFont(family: string): Promise<void> {
  const idx = customFonts.indexOf(family);
  if (idx >= 0) {
    customFonts.splice(idx, 1);
    customFontFormats.delete(family);
    notifyCustomFontChange();
  }
  const db = await openFontsDB();
  if (!db) return;
  await new Promise<void>((resolve) => {
    const tx = db.transaction(STORE_FONTS, "readwrite");
    tx.objectStore(STORE_FONTS).delete(family);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
    tx.onabort = () => resolve();
  });
  db.close();
}

let initPromise: Promise<void> | null = null;

export function initCustomFonts(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    if (typeof FontFace === "undefined" || typeof document === "undefined") return;
    const stored = await loadStoredFonts();
    let changed = false;
    for (const { family, data } of stored) {
      if (customFonts.includes(family)) continue;
      try {
        const face = new FontFace(family, data);
        await face.load();
        document.fonts.add(face);
        customFonts.push(family);
        changed = true;
      } catch {
        // skip corrupt entries
      }
    }
    if (changed) notifyCustomFontChange();
  })();
  return initPromise;
}

export function getCustomFonts() {
  return [...customFonts];
}

export function useCustomFonts() {
  const [fonts, setFonts] = useState<string[]>(() => getCustomFonts());

  useEffect(() => {
    const sync = () => setFonts(getCustomFonts());
    window.addEventListener(CUSTOM_FONT_EVENT, sync);
    void initCustomFonts().then(sync);
    return () => window.removeEventListener(CUSTOM_FONT_EVENT, sync);
  }, []);

  return fonts;
}

/**
 * Shared registration path for every custom font (GUI file upload and the
 * agent live bridge): validates the byte signature, derives a unique
 * family, activates the FontFace immediately and persists best-effort.
 * On success the caller must use the returned fontFamily — a duplicate
 * base name comes back suffixed ("Foo" -> "Foo 2"), never renamed silently.
 */
export async function registerFontBytes(
  name: string,
  data: ArrayBuffer,
): Promise<RegisterFontBytesResult> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    return {
      success: false,
      error: "Custom font upload is not supported in this environment.",
      code: "UNSUPPORTED_ENVIRONMENT",
    };
  }

  if (data.byteLength === 0) {
    return {
      success: false,
      error: "Could not load this font file.",
      code: "EMPTY_FONT_DATA",
    };
  }

  const format = detectFontFormat(data);
  if (!format) {
    return {
      success: false,
      error: "This file is not a valid .ttf, .otf, .woff, or .woff2 font.",
      code: "INVALID_FONT_DATA",
    };
  }

  try {
    const baseName = stripFontExtension(name).trim();
    const fontFamily = toUniqueFontFamily(baseName);
    const fontFace = new FontFace(fontFamily, data);
    await fontFace.load();
    document.fonts.add(fontFace);

    if (!customFonts.includes(fontFamily)) {
      customFonts.push(fontFamily);
      customFontFormats.set(fontFamily, format);
      notifyCustomFontChange();
    }

    await persistFont(fontFamily, data).catch(() => {
      // best-effort persistence; font is still usable this session
    });

    return { success: true, fontFamily, format };
  } catch {
    return { success: false, error: "Could not load this font file.", code: "FONT_LOAD_FAILED" };
  }
}

export async function registerCustomFont(
  file: File,
): Promise<{ success: true; fontFamily: string } | { success: false; error: string }> {
  if (!FONT_EXTENSIONS.test(file.name)) {
    return { success: false, error: "Please upload a .ttf, .otf, .woff, or .woff2 font file." };
  }

  const result = await registerFontBytes(file.name, await file.arrayBuffer());
  if (result.success) {
    return { success: true, fontFamily: result.fontFamily };
  }
  return { success: false, error: result.error };
}

/** Listing entry for the agent bridge: installed fonts without the bytes. */
export interface CustomFontRecord {
  family: string;
  format: FontFormat | null;
  sizeBytes: number | null;
  uploadedAt: number | null;
}

/**
 * One record per installed font (this session's in-memory list first, then
 * persisted fonts that are not loaded in this session). Metadata comes from
 * the persisted record; null fields mean the bytes were never persisted
 * (best-effort persistence failed) so the truth is reported, not guessed.
 */
export async function listCustomFontRecords(): Promise<CustomFontRecord[]> {
  const stored = await loadStoredFonts();
  const byFamily = new Map(stored.map((record) => [record.family, record]));
  const families = [...customFonts];
  for (const { family } of stored) {
    if (!families.includes(family)) families.push(family);
  }
  return families.map((family) => {
    const record = byFamily.get(family);
    return {
      family,
      format: record
        ? detectFontFormat(record.data)
        : (customFontFormats.get(family) ?? null),
      sizeBytes: record ? record.data.byteLength : null,
      uploadedAt: record ? record.uploadedAt : null,
    };
  });
}
