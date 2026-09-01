/**
 * Shared paths for the Electron live-collaboration E2E harness.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** apps/desktop/e2e */
export const E2E_DIR = path.resolve(here, "..");
/** apps/desktop */
export const DESKTOP_DIR = path.resolve(E2E_DIR, "..");
/** Machine-readable evidence root (uploaded in CI, gitignored). */
export const ARTIFACTS_DIR = path.join(E2E_DIR, ".artifacts");
/** The stdio MCP shim the external agent channel spawns. */
export const MCP_SHIM_PATH = path.join(DESKTOP_DIR, "dist", "mcp-shim", "index.js");
/** The built main-process bundle — must exist before the suite runs. */
export const MAIN_BUNDLE_PATH = path.join(DESKTOP_DIR, "dist", "main", "index.js");
