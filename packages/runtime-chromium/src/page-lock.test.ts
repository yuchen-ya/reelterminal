/**
 * Preview-shaped page operations must fail FAST while another operation
 * (typically an export) holds the single page lock — a clear busy error
 * beats hanging until some outer timeout — and the lock must still serve
 * the next operation once the holder finishes.
 */
import { describe, it, expect, afterAll } from "vitest";
import { existsSync } from "node:fs";
import { chromium } from "playwright-core";
import type { Project, TextClip } from "@reelterminal/core";
import { DEFAULT_TEXT_STYLE, DEFAULT_TEXT_TRANSFORM } from "@reelterminal/core";
import { ChromiumRuntime, PageLockBusyError } from "./node/runtime";

const hasChromium = (() => {
  try {
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
})();

if (!hasChromium) {
  console.warn("[page-lock] SKIP: Playwright-managed Chromium not installed on this machine");
}

function fixtureProject(): Project {
  const clip: TextClip = {
    id: "page-lock-text",
    trackId: "page-lock-track",
    startTime: 0,
    duration: 1,
    text: "x",
    style: { ...DEFAULT_TEXT_STYLE, fontFamily: "serif", fontSize: 24, strokeWidth: 0 },
    transform: DEFAULT_TEXT_TRANSFORM,
    keyframes: [],
  };
  return {
    id: "page-lock-project",
    name: "Page lock fixture",
    createdAt: 1,
    modifiedAt: 1,
    settings: { width: 160, height: 90, frameRate: 30, sampleRate: 48000, channels: 2 },
    mediaLibrary: { items: [] },
    timeline: {
      tracks: [{
        id: "page-lock-track", type: "text", name: "Text", clips: [], transitions: [],
        locked: false, hidden: false, muted: false, solo: false,
      }],
      subtitles: [], duration: 1, markers: [],
    },
    textClips: [clip],
  };
}

describe.skipIf(!hasChromium)("page lock busy fast-fail", () => {
  const runtime = new ChromiumRuntime({ renderPageWaitTimeoutMs: 250 });
  const project = fixtureProject();

  afterAll(async () => {
    await runtime.close().catch(() => undefined);
  });

  it("rejects a queued preview with PageLockBusyError and recovers after the holder finishes", async () => {
    // Hold the page lock well past the preview wait bound.
    const holder = runtime.withHydratedSession(project, {}, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return "held";
    });
    // Let the holder acquire the lock first.
    await new Promise((resolve) => setTimeout(resolve, 300));
    await expect(runtime.renderPng(project, {}, 0.1, 64, 36)).rejects.toBeInstanceOf(PageLockBusyError);
    await expect(holder).resolves.toBe("held");
    // The abandoned preview must not wedge the queue: the next render works.
    const recovered = await runtime.renderPng(project, {}, 0.1, 64, 36);
    expect(recovered.length).toBeGreaterThan(0);
  }, 30_000);
});
