import { afterAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import { ChromiumRuntime } from "./runtime";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();
const supportsPosixSignals = process.platform !== "win32";

if (!hasChromium) {
  console.warn(
    "[signal-ownership] SKIP: Playwright-managed Chromium not installed on this machine",
  );
}
if (!supportsPosixSignals) {
  console.warn("[signal-ownership] SKIP: process signal semantics differ on Windows");
}

describe.skipIf(!hasChromium || !supportsPosixSignals)(
  "signal ownership",
  () => {
    const runtime = new ChromiumRuntime();
    let sawSigterm = false;
    const onSigterm = (): void => {
      sawSigterm = true;
    };

    afterAll(async () => {
      process.removeListener("SIGTERM", onSigterm);
      await runtime.close();
    });

    it("does not kill the browser when SIGTERM is handled elsewhere", async () => {
      // Launch preflight — a failure here is a real regression (we did not
      // skip: the browser executable exists).
      const probe = await runtime.probeOnPage();
      expect(probe).toBeTruthy();
      expect(runtime.isBrowserConnected).toBe(true);

      // The embedder (transport) installs the only handler…
      process.on("SIGTERM", onSigterm);
      // …then the operator sends the signal. Without
      // `handleSIGTERM: false`, Playwright's own handler closes the browser
      // out from under us and `isBrowserConnected` flips to false.
      process.kill(process.pid, "SIGTERM");
      // The signal is delivered asynchronously; give the event loop a few
      // turns to run (foreign) handlers — and any Playwright handler that
      // would wrongly exist.
      for (let i = 0; i < 20 && !sawSigterm; i += 1) {
        await new Promise((resolveSleep) => setTimeout(resolveSleep, 25));
      }
      expect(sawSigterm).toBe(true);

      // The browser must have survived the signal: still connected, and a
      // fresh page op still works (the runtime is usable after the signal,
      // which is the whole point of the transport-owned disposal path).
      expect(runtime.isBrowserConnected).toBe(true);
      const after = await runtime.probeOnPage();
      expect(after).toBeTruthy();
    });
  },
);
