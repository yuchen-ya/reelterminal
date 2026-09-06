import { importPreflightPlugin } from "./import-preflight";
import { collectPluginTools } from "../plugin-api";
import { sourceInspectionPlugin } from "./source-inspection";

/** Startup composition. Add an import and a plugin here; no transport edits. */
export const BUNDLED_PLUGINS = [sourceInspectionPlugin, importPreflightPlugin] as const;
export const PLUGIN_TOOLS = collectPluginTools(BUNDLED_PLUGINS);
