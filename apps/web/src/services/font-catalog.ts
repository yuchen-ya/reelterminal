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

/** CSS generic family keywords, the only faces the standalone render harness guarantees. */
const GENERIC_FONT_FAMILIES = [
  "serif",
  "sans-serif",
  "monospace",
  "cursive",
  "fantasy",
  "system-ui",
  "ui-serif",
  "ui-sans-serif",
  "ui-monospace",
  "emoji",
  "math",
  "fangsong",
] as const;

const BUILTIN_FONTS = new Set([
  ...Object.values(FONT_CATEGORIES).flat(),
  ...GENERIC_FONT_FAMILIES,
].map((font) => font.toLowerCase()));

const RUNTIME_SYSTEM_FONTS = new Set(
  GENERIC_FONT_FAMILIES.map((font) => font.toLowerCase()),
);

export function isBuiltinFontFamily(family: string): boolean {
  return BUILTIN_FONTS.has(family.trim().toLowerCase());
}

/** The standalone Chromium render harness only guarantees CSS generic families. */
export function isRuntimeSystemFontFamily(family: string): boolean {
  return RUNTIME_SYSTEM_FONTS.has(family.trim().toLowerCase());
}
