import { importPreflightPlugin } from "./import-preflight";
import { collectPluginTools } from "../plugin-api";
import { frameToolsPlugin } from "./frame-tools";
import { motionToolsPlugin } from "./motion-tools";
import { maskToolsPlugin } from "./mask-tools";
import { patchPropagationPlugin } from "./patch-propagation";
import { sourceInspectionPlugin } from "./source-inspection";

/** Startup composition. Add an import and a plugin here; no transport edits. */
export const BUNDLED_PLUGINS = [sourceInspectionPlugin, importPreflightPlugin, frameToolsPlugin, motionToolsPlugin, maskToolsPlugin, patchPropagationPlugin] as const;
export const PLUGIN_TOOLS = collectPluginTools(BUNDLED_PLUGINS);
