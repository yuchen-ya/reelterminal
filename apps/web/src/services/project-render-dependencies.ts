import type { Project, ProjectRenderFont } from "@reelterminal/core";
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

function collectFontFamilies(value: unknown, families: Set<string>): void {
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
export async function prepareProjectRenderFonts(project: Project): Promise<Project> {
  const families = new Set<string>();
  collectFontFamilies(project, families);
  const needed = new Map([...families].map((family) => [family.toLowerCase(), family]));
  const existing = (Array.isArray(project.renderFonts) ? project.renderFonts : [])
    .filter(validRenderFont)
    .filter((font) => needed.has(font.family.toLowerCase()));
  const capturedFamilies = new Set(existing.map((font) => font.family.toLowerCase()));
  const renderFonts = [...existing];

  for (const [normalizedFamily, family] of needed) {
    if (capturedFamilies.has(normalizedFamily) || isRuntimeSystemFontFamily(family)) continue;
    const data = await getCustomFontBytes(family);
    if (!data) continue;
    renderFonts.push({ family, style: "normal", weight: "400", dataUrl: fontDataUrl(data) });
    capturedFamilies.add(normalizedFamily);
  }

  const bundled = [...needed].filter(([normalizedFamily, family]) =>
    !capturedFamilies.has(normalizedFamily) && !isRuntimeSystemFontFamily(family));
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
        } catch {
          // Keep unresolved faces visible as missing render dependencies.
        }
      }
    }
  }

  return { ...project, renderFonts };
}

/** Install snapshot faces in the GUI renderer before restoring that snapshot. */
export async function installProjectRenderFonts(
  project: Project,
  ownerId = project.id,
): Promise<void> {
  if (typeof FontFace === "undefined" || typeof document === "undefined") return;
  releaseProjectRenderFonts(ownerId);
  const lease = new Set<string>();
  projectFontLeases.set(ownerId, lease);
  for (const rawFont of project.renderFonts ?? []) {
    if (!validRenderFont(rawFont)) continue;
    const key = renderFontInstanceKey(rawFont);
    let entry = loadedProjectFaces.get(key);
    if (!entry) {
      const face = new FontFace(rawFont.family, `url(${JSON.stringify(rawFont.dataUrl)})`, {
        style: rawFont.style,
        weight: rawFont.weight,
        ...(rawFont.unicodeRange ? { unicodeRange: rawFont.unicodeRange } : {}),
      });
      await face.load();
      if (projectFontLeases.get(ownerId) !== lease) return;
      document.fonts.add(face);
      entry = { face, owners: new Set() };
      loadedProjectFaces.set(key, entry);
    }
    entry.owners.add(ownerId);
    lease.add(key);
  }
}

/** Release only faces this module installed for the given workspace/runtime. */
export function releaseProjectRenderFonts(ownerId: string): void {
  const keys = projectFontLeases.get(ownerId);
  if (!keys) return;
  projectFontLeases.delete(ownerId);
  if (typeof document === "undefined") return;
  for (const key of keys) {
    const entry = loadedProjectFaces.get(key);
    if (!entry) continue;
    entry.owners.delete(ownerId);
    if (entry.owners.size === 0) {
      document.fonts.delete(entry.face);
      loadedProjectFaces.delete(key);
    }
  }
}

/** Return project dependencies that cannot be rendered from this snapshot. */
export async function getMissingProjectRenderDependencyIds(project: Project): Promise<string[]> {
  const prepared = await prepareProjectRenderFonts(project);
  const persistedFonts = new Set(
    [...await listPersistedCustomFontFamilies()].map((family) => family.toLowerCase()),
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

  return [...missing].sort();
}
