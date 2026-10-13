import {
  beginPerfOperation,
  endPerfOperation,
  failPerfOperation,
} from "@reelterminal/core";
import type { PerfOperation, Project, ProjectRenderFont } from "@reelterminal/core";
import { isBuiltinFontFamily, isRuntimeSystemFontFamily } from "./font-catalog";
import { getCustomFontBytes, listPersistedCustomFontFamilies } from "./custom-font-storage";

const SVG_IMAGE_TAG_RE = /<(?:[\w.-]+:)?(?:image|feImage|use)\b[^>]*>/gi;
const SVG_URL_ATTRIBUTE_RE = /\b(?:xlink:href|href|src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;
const FONT_FACE_RE = /@font-face\s*\{([^{}]*)\}/gi;
const loadedProjectFaces = new Map<string, {
  readonly face: FontFace;
  readonly owners: Set<string>;
}>();
const projectFontLeases = new Map<string, Set<string>>();

interface BundledFontFace {
  readonly family: string;
  readonly style: string;
  readonly weight: string;
  readonly unicodeRange?: string;
  readonly source: string;
}

/** Recursively collect every non-empty `fontFamily` string found in `value`. */
export function collectFontFamilies(value: unknown, families: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectFontFamilies(item, families));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (key === "fontFamily" && typeof child === "string" && child.trim()) {
      families.add(child.trim());
    } else {
      collectFontFamilies(child, families);
    }
  }
}

function addImageReference(value: string, missing: Set<string>): void {
  const url = value.trim();
  if (!url || url.startsWith("#") || /^data:image\//i.test(url)) return;
  missing.add(`image:${url}`);
}

function collectSvgImageReferences(svg: string, missing: Set<string>): void {
  for (const tag of svg.matchAll(SVG_IMAGE_TAG_RE)) {
    for (const match of tag[0].matchAll(SVG_URL_ATTRIBUTE_RE)) {
      addImageReference(match[1] ?? match[2] ?? "", missing);
    }
  }
  for (const match of svg.matchAll(CSS_URL_RE)) {
    addImageReference(match[1] ?? match[2] ?? match[3] ?? "", missing);
  }
}

function collectImageReferences(value: unknown, missing: Set<string>): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => collectImageReferences(item, missing));
    return;
  }
  const record = value as Record<string, unknown>;
  if (
    (record.type === "image" || record.type === "svg") &&
    typeof record.url === "string" &&
    typeof record.mediaId !== "string"
  ) {
    addImageReference(record.url, missing);
  }
  for (const [key, child] of Object.entries(record)) {
    if ((key === "imageUrl" || key === "environmentUrl") && typeof child === "string") {
      addImageReference(child, missing);
    } else if (key === "svgContent" && typeof child === "string") {
      collectSvgImageReferences(child, missing);
    } else {
      collectImageReferences(child, missing);
    }
  }
}

function parseFontFace(block: string): BundledFontFace | null {
  const familyValue = /(?:^|;)\s*font-family\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
  const sourceValue = /(?:^|;)\s*src\s*:\s*([^;]+)/i.exec(block)?.[1];
  if (!familyValue || !sourceValue) return null;
  const family = familyValue.replace(/^(['"])(.*)\1$/, "$2").trim();
  const source = /url\(\s*(['"]?)(.*?)\1\s*\)/i.exec(sourceValue)?.[2]?.trim();
  if (!family || !source || /^(?:https?:|data:|blob:)/i.test(source)) return null;
  const style = /(?:^|;)\s*font-style\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() || "normal";
  const weight = /(?:^|;)\s*font-weight\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim() || "400";
  const unicodeRange = /(?:^|;)\s*unicode-range\s*:\s*([^;]+)/i.exec(block)?.[1]?.trim();
  return { family, style, weight, ...(unicodeRange ? { unicodeRange } : {}), source };
}

async function readBundledFontFaces(): Promise<{ cssUrl: string; faces: BundledFontFace[] } | null> {
  if (typeof document === "undefined" || typeof fetch !== "function") return null;
  const link = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
    .find((candidate) => candidate.href.toLowerCase().includes("google-fonts.css"));
  const cssUrl = link?.href ?? new URL("./fonts/google-fonts.css", document.baseURI).href;
  try {
    const response = await fetch(cssUrl);
    if (!response.ok) return null;
    const css = await response.text();
    const faces = [...css.matchAll(FONT_FACE_RE)]
      .map((match) => parseFontFace(match[1]))
      .filter((face): face is BundledFontFace => face !== null);
    return { cssUrl, faces };
  } catch {
    // Rendering can continue with the browser's fallback font; completeness
    // diagnostics below will retain the missing-family marker.
    return null;
  }
}

function bufferToDataUrl(data: ArrayBuffer, mimeType: string): string {
  const bytes = new Uint8Array(data);
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
}

function fontDataUrl(data: ArrayBuffer): string {
  const signature = new Uint8Array(data, 0, Math.min(data.byteLength, 4));
  const text = String.fromCharCode(...signature);
  const mime = text === "wOF2" ? "font/woff2"
    : text === "wOFF" ? "font/woff"
    : text === "OTTO" ? "font/otf"
    : "font/ttf";
  return bufferToDataUrl(data, mime);
}

function validRenderFont(value: unknown): value is ProjectRenderFont {
  if (!value || typeof value !== "object") return false;
  const font = value as Partial<ProjectRenderFont>;
  return typeof font.family === "string" && font.family.trim().length > 0 &&
    typeof font.style === "string" && typeof font.weight === "string" &&
    typeof font.dataUrl === "string" && /^data:font\/(?:woff2?|ttf|otf);base64,[A-Za-z0-9+/]+=*$/i.test(font.dataUrl) &&
    (font.unicodeRange === undefined || typeof font.unicodeRange === "string");
}

function renderFontKey(font: ProjectRenderFont): string {
  return `${font.family.toLowerCase()}\u0000${font.style}\u0000${font.weight}\u0000${font.unicodeRange ?? ""}`;
}

function renderFontInstanceKey(font: ProjectRenderFont): string {
  return `${renderFontKey(font)}\u0000${font.dataUrl}`;
}

function renderFontMime(source: string): string {
  if (/\.woff2?(?:[?#]|$)/i.test(source)) return "font/woff2";
  if (/\.otf(?:[?#]|$)/i.test(source)) return "font/otf";
  if (/\.ttf(?:[?#]|$)/i.test(source)) return "font/ttf";
  return "font/woff2";
}

/** Capture immutable bytes for every font family referenced by this snapshot. */
export async function prepareProjectRenderFonts(
  project: Project,
  parent?: PerfOperation,
): Promise<Project> {
  const operation = parent
    ? beginPerfOperation("font.prepare", parent)
    : undefined;
  try {
    const families = new Set<string>();
    collectFontFamilies(project, families);
    const needed = new Map([...families].map((family) => [family.toLowerCase(), family]));
    const rawFonts = Array.isArray(project.renderFonts) ? project.renderFonts : [];
    const validation = operation
      ? beginPerfOperation("font.validate", operation)
      : undefined;
    const validFonts = rawFonts.filter(validRenderFont);
    endPerfOperation(validation, "ok", validation ? {
      candidates: rawFonts.length,
      valid: validFonts.length,
      invalid: rawFonts.length - validFonts.length,
    } : undefined);
    const existing = validFonts.filter((font) => needed.has(font.family.toLowerCase()));
    const capturedFamilies = new Set(existing.map((font) => font.family.toLowerCase()));
    const renderFonts = [...existing];

    const customLoad = operation
      ? beginPerfOperation("font.load-custom", operation)
      : undefined;
    let customLoaded = 0;
    try {
      for (const [normalizedFamily, family] of needed) {
        if (capturedFamilies.has(normalizedFamily) || isRuntimeSystemFontFamily(family)) continue;
        const data = await getCustomFontBytes(family);
        if (!data) continue;
        renderFonts.push({ family, style: "normal", weight: "400", dataUrl: fontDataUrl(data) });
        capturedFamilies.add(normalizedFamily);
        if (operation) customLoaded += 1;
      }
      endPerfOperation(customLoad, "ok", customLoad ? {
        candidates: needed.size,
        loaded: customLoaded,
      } : undefined);
    } catch (error) {
      failPerfOperation(customLoad, error);
      throw error;
    }

    const bundled = [...needed].filter(([normalizedFamily, family]) =>
      !capturedFamilies.has(normalizedFamily) && !isRuntimeSystemFontFamily(family));
    const bundledLoad = operation
      ? beginPerfOperation("font.load-bundled", operation)
      : undefined;
    let bundledLoaded = 0;
    try {
      if (bundled.length > 0) {
        const stylesheet = await readBundledFontFaces();
        if (stylesheet) {
          for (const face of stylesheet.faces) {
            const normalizedFamily = face.family.toLowerCase();
            if (!bundled.some(([candidate]) => candidate === normalizedFamily)) continue;
            try {
              const response = await fetch(new URL(face.source, stylesheet.cssUrl));
              if (!response.ok) continue;
              const data = await response.arrayBuffer();
              const descriptor: ProjectRenderFont = {
                family: face.family,
                style: face.style,
                weight: face.weight,
                ...(face.unicodeRange ? { unicodeRange: face.unicodeRange } : {}),
                dataUrl: bufferToDataUrl(data, renderFontMime(face.source)),
              };
              renderFonts.push(descriptor);
              capturedFamilies.add(normalizedFamily);
              if (operation) bundledLoaded += 1;
            } catch {
              // Keep unresolved faces visible as missing render dependencies.
            }
          }
        }
      }
      endPerfOperation(bundledLoad, "ok", bundledLoad ? {
        candidates: bundled.length,
        loaded: bundledLoaded,
      } : undefined);
    } catch (error) {
      failPerfOperation(bundledLoad, error);
      throw error;
    }

    // Desktop Chromium exposes installed SFNT bytes. Capture the actual family
    // and all faces so isolated review does not depend on that machine's fonts.
    const unresolved = new Set([...needed].filter(([family, displayFamily]) =>
      !capturedFamilies.has(family) && !isRuntimeSystemFontFamily(displayFamily)).map(([family]) => family));
    const desktopWindow = typeof window === "undefined" ? undefined : window as Window & {
      queryLocalFonts?: () => Promise<Array<{ family: string; style: string; blob(): Promise<Blob> }>>;
    };
    const localLoad = operation
      ? beginPerfOperation("font.load-local", operation)
      : undefined;
    let localLoaded = 0;
    try {
      if (unresolved.size > 0 && desktopWindow?.reelterminal && desktopWindow.queryLocalFonts) {
        const localFonts = await desktopWindow.queryLocalFonts();
        for (const font of localFonts) {
          const family = font.family.toLowerCase();
          if (!unresolved.has(family) || isRuntimeSystemFontFamily(font.family)) continue;
          const data = await (await font.blob()).arrayBuffer();
          const style = /italic|oblique/i.test(font.style) ? "italic" : "normal";
          const weight = /bold/i.test(font.style) ? "700" : /light/i.test(font.style) ? "300" : "400";
          renderFonts.push({ family: needed.get(family)!, style, weight, dataUrl: fontDataUrl(data) });
          if (operation) localLoaded += 1;
        }
      }
      endPerfOperation(localLoad, "ok", localLoad ? {
        unresolvedFamilies: unresolved.size,
        loaded: localLoaded,
      } : undefined);
    } catch (error) {
      failPerfOperation(localLoad, error);
      throw error;
    }

    const result = { ...project, renderFonts };
    endPerfOperation(operation, "ok", operation ? {
      families: needed.size,
      capturedFonts: renderFonts.length,
      newlyCapturedFonts: customLoaded + bundledLoaded + localLoaded,
    } : undefined);
    return result;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}

/** Install snapshot faces in the GUI renderer before restoring that snapshot. */
export async function installProjectRenderFonts(
  project: Project,
  ownerId = project.id,
  parent?: PerfOperation,
): Promise<void> {
  const operation = beginPerfOperation("font.install", parent);
  if (typeof FontFace === "undefined" || typeof document === "undefined") {
    const rawFonts = project.renderFonts ?? [];
    const validFonts = operation ? rawFonts.filter(validRenderFont) : [];
    const validation = operation
      ? beginPerfOperation("font.validate", operation)
      : undefined;
    endPerfOperation(validation, "ok", validation ? {
      candidates: rawFonts.length,
      valid: validFonts.length,
      invalid: rawFonts.length - validFonts.length,
    } : undefined);
    endPerfOperation(operation, "ok", operation ? {
      supported: false,
      candidates: rawFonts.length,
    } : undefined);
    return;
  }
  const validation = operation
    ? beginPerfOperation("font.validate", operation)
    : undefined;
  const rawFonts = project.renderFonts ?? [];
  const validFonts = rawFonts.filter(validRenderFont);
  endPerfOperation(validation, "ok", validation ? {
    candidates: rawFonts.length,
    valid: validFonts.length,
    invalid: rawFonts.length - validFonts.length,
  } : undefined);

  releaseProjectRenderFonts(ownerId, operation);
  const lease = new Set<string>();
  projectFontLeases.set(ownerId, lease);
  try {
    let loaded = 0;
    let reused = 0;
    for (const rawFont of validFonts) {
      const key = renderFontInstanceKey(rawFont);
      let entry = loadedProjectFaces.get(key);
      if (!entry) {
        const loadOperation = operation
          ? beginPerfOperation("font.load", operation)
          : undefined;
        const face = new FontFace(rawFont.family, `url(${JSON.stringify(rawFont.dataUrl)})`, {
          style: rawFont.style,
          weight: rawFont.weight,
          ...(rawFont.unicodeRange ? { unicodeRange: rawFont.unicodeRange } : {}),
        });
        try {
          await face.load();
          endPerfOperation(loadOperation, "ok");
        } catch (error) {
          failPerfOperation(loadOperation, error);
          throw error;
        }
        if (projectFontLeases.get(ownerId) !== lease) {
          endPerfOperation(operation, "superseded", operation ? { loaded, reused } : undefined);
          return;
        }
        document.fonts.add(face);
        entry = { face, owners: new Set() };
        loadedProjectFaces.set(key, entry);
        if (operation) loaded += 1;
      } else {
        if (operation) reused += 1;
      }
      const leaseOperation = operation
        ? beginPerfOperation("font.lease-acquire", operation)
        : undefined;
      entry.owners.add(ownerId);
      lease.add(key);
      endPerfOperation(leaseOperation, "ok", leaseOperation ? { leased: 1 } : undefined);
    }
    endPerfOperation(operation, "ok", operation ? {
      candidates: validFonts.length,
      loaded,
      reused,
      leased: lease.size,
    } : undefined);
  } catch (error) {
    // A broken font face must not strand this owner's partial lease and the
    // faces already installed under it; roll the install back before the
    // error propagates (unless a concurrent install already took the lease).
    if (projectFontLeases.get(ownerId) === lease) releaseProjectRenderFonts(ownerId, operation);
    failPerfOperation(operation, error);
    throw error;
  }
}

/** Release only faces this module installed for the given workspace/runtime. */
export function releaseProjectRenderFonts(ownerId: string, parent?: PerfOperation): void {
  const operation = beginPerfOperation("font.lease-release", parent);
  const keys = projectFontLeases.get(ownerId);
  if (!keys) {
    endPerfOperation(operation, "ok", operation ? { released: 0 } : undefined);
    return;
  }
  projectFontLeases.delete(ownerId);
  if (typeof document === "undefined") {
    endPerfOperation(operation, "ok", operation ? { released: 0 } : undefined);
    return;
  }
  let released = 0;
  for (const key of keys) {
    const entry = loadedProjectFaces.get(key);
    if (!entry) continue;
    entry.owners.delete(ownerId);
    if (entry.owners.size === 0) {
      document.fonts.delete(entry.face);
      loadedProjectFaces.delete(key);
      if (operation) released += 1;
    }
  }
  endPerfOperation(operation, "ok", operation ? {
    leased: keys.size,
    released,
  } : undefined);
}

/** Return project dependencies that cannot be rendered from this snapshot. */
export function getMissingProjectImageDependencyIds(project: Project): string[] {
  const missing = new Set<string>();
  collectImageReferences(project, missing);
  return [...missing].sort();
}

export async function getMissingProjectRenderDependencyIds(
  project: Project,
  parent?: PerfOperation,
): Promise<string[]> {
  const operation = beginPerfOperation("font.dependency-check", parent);
  try {
    const prepared = await prepareProjectRenderFonts(project, operation);
    const persistedFontsOperation = operation
      ? beginPerfOperation("font.persisted-family-query", operation)
      : undefined;
    let persistedFamilyList: Set<string>;
    try {
      persistedFamilyList = await listPersistedCustomFontFamilies();
      endPerfOperation(persistedFontsOperation, "ok", persistedFontsOperation ? {
        familyCount: persistedFamilyList.size,
      } : undefined);
    } catch (error) {
      failPerfOperation(persistedFontsOperation, error);
      throw error;
    }
    const persistedFonts = new Set(
      [...persistedFamilyList].map((family) => family.toLowerCase()),
    );
    const fontFamilies = new Set<string>();
    collectFontFamilies(project, fontFamilies);
    const availableFaces = new Set(
      (prepared.renderFonts ?? []).map((font) => font.family.toLowerCase()),
    );

    const missing = new Set<string>();
    for (const family of fontFamilies) {
      if (isRuntimeSystemFontFamily(family) || availableFaces.has(family.toLowerCase())) continue;
      if (!isBuiltinFontFamily(family) && !persistedFonts.has(family.toLowerCase())) {
        missing.add(`font:${family}`);
      }
      missing.add(`font-render:${family}`);
    }

    const missingImages = new Set<string>();
    collectImageReferences(project, missingImages);
    for (const dependency of missingImages) missing.add(dependency);

    const result = [...missing].sort();
    endPerfOperation(operation, "ok", operation ? {
      fontFamilies: fontFamilies.size,
      availableFaces: availableFaces.size,
      missingDependencies: result.length,
    } : undefined);
    return result;
  } catch (error) {
    failPerfOperation(operation, error);
    throw error;
  }
}
