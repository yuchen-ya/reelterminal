#!/usr/bin/env node
/** Executable compatibility entry retained for old `.../live-mcp/index.js` configs. */
export * from "./adapter";
import { serveMcp } from "./adapter";

if (require.main === module) {
  void serveMcp().catch((error: unknown) => {
    process.stderr.write(
      `reelterminal-live-mcp: ${error instanceof Error ? error.message : "startup failed"}\n` +
        "Enable Agent Access in ReelTerminal and try again.\n",
    );
    process.exitCode = 4;
  });
}
