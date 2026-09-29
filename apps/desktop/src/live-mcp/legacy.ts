#!/usr/bin/env node
/** Compatibility executable: equivalent to `reelctl mcp serve --compat`. */
import { serveMcp } from "./adapter";

void serveMcp().catch((error: unknown) => {
  process.stderr.write(
    `reelterminal-live-mcp: ${error instanceof Error ? error.message : "startup failed"}\n` +
      "Enable Agent Access in ReelTerminal and try again.\n",
  );
  process.exit(4);
});
