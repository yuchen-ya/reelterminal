/**
 * Vitest config for the Electron live-collaboration E2E (ADR 0004).
 *
 * Deliberately SEPARATE from the package's default `vitest run` (test:run):
 * the default unit-test config never sees `*.e2e.ts` files, so `test:run`
 * stays fast. Run with:
 *
 *   pnpm --filter @openreel/desktop build
 *   pnpm --filter @openreel/desktop test:e2e
 *
 * Serial execution, long timeouts: every spec file boots the real built
 * Electron app and drives a real MCP stdio client against it.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "desktop-e2e",
    include: ["e2e/**/*.e2e.ts"],
    exclude: ["e2e/scratch/**"],
    // One spec file at a time, sequential tests inside a file: each file owns
    // one Electron app instance and they must never share the single-writer
    // live stack or a port.
    fileParallelism: false,
    pool: "forks",
    poolOptions: { forks: { singleFork: true } },
    testTimeout: 600_000,
    hookTimeout: 420_000,
    retry: 0,
    reporters: ["default"],
  },
});
