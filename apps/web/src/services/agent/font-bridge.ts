/**
 * Renderer side of the custom-font live bridge: the desktop main process
 * facade forwards font.* verbs here, and this module executes them against
 * the canonical font service (font-options.ts: IndexedDB `openreel-custom-fonts`
 * + FontFace activation) — the exact registration path the GUI upload
 * button uses, so agent-installed fonts are immediately visible in every
 * GUI font picker (same update event) and persist across restarts.
 *
 * Error codes are mapped to the facade's public taxonomy (INVALID_PARAMS /
 * UNSUPPORTED); the human-readable reason from the font service is always
 * preserved as the message.
 */
import {
  getCustomFonts,
  listCustomFontRecords,
  registerFontBytes,
} from "../../components/editor/inspector/font-options";

/**
 * Mirrors FONT_LIBRARY_LIMITS.maxFontBytes in @reelterminal/agent-facade — the
 * facade enforces the same decoded-size budget before forwarding.
 */
const MAX_FONT_UPLOAD_BYTES = 10 * 1024 * 1024;

export type FontBridgeError = {
  readonly code: string;
  readonly message: string;
};

export type FontBridgeReply =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: FontBridgeError };

function bridgeError(code: string, message: string): FontBridgeReply {
  return { ok: false, error: { code, message } };
}

/** Handles one main→renderer custom-font request (exported for tests). */
export async function handleFontLibraryRequest(req: {
  readonly verb?: unknown;
  readonly params?: unknown;
}): Promise<FontBridgeReply> {
  const verb = typeof req.verb === "string" ? req.verb : "";
  const rawParams =
    typeof req.params === "object" && req.params !== null
      ? (req.params as Record<string, unknown>)
      : {};
  try {
    switch (verb) {
      case "upload": {
        const data = rawParams.data;
        if (!(data instanceof ArrayBuffer)) {
          return bridgeError(
            "INVALID_PARAMS",
            "font.upload requires font bytes as an ArrayBuffer",
          );
        }
        if (data.byteLength > MAX_FONT_UPLOAD_BYTES) {
          return bridgeError(
            "INVALID_PARAMS",
            `font.upload: decoded font is ${data.byteLength} bytes; the limit is ${MAX_FONT_UPLOAD_BYTES} bytes`,
          );
        }
        const name = typeof rawParams.name === "string" ? rawParams.name : "";
        const result = await registerFontBytes(name, data);
        if (!result.success) {
          const code =
            result.code === "UNSUPPORTED_ENVIRONMENT"
              ? "UNSUPPORTED"
              : "INVALID_PARAMS";
          return bridgeError(code, result.error);
        }
        return {
          ok: true,
          result: {
            fontFamily: result.fontFamily,
            format: result.format,
            sizeBytes: data.byteLength,
          },
        };
      }
      case "list": {
        const records = await listCustomFontRecords();
        const loaded = new Set(getCustomFonts());
        return {
          ok: true,
          result: {
            fonts: records.map((record) => ({
              ...record,
              loadedInSession: loaded.has(record.family),
            })),
          },
        };
      }
      default:
        return bridgeError(
          "INVALID_PARAMS",
          `Unknown font bridge verb: ${verb || "(none)"}`,
        );
    }
  } catch (error) {
    return bridgeError(
      "INTERNAL",
      error instanceof Error ? error.message : String(error),
    );
  }
}
