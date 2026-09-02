/**
 * Human-side UI drivers — REAL input only (Playwright mouse/keyboard on the
 * Electron window). Nothing here touches stores or window internals; the only
 * reads are DOM queries. Where a gesture needs aiming (ruler seek, canvas
 * point), the correction loop observes through the AGENT channel (facade
 * context reads) — observation, never impersonation.
 */
import type { Locator, Page } from "playwright-core";
import { existsSync } from "node:fs";

/** Polling stand-in for @playwright/test's expect (not a desktop dep). */
async function waitFor(
  probe: () => Promise<boolean>,
  timeoutMs: number,
  what: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    try {
      if (await probe()) return;
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error(
    `waitFor timed out (${timeoutMs}ms): ${what}${lastError ? ` — last error: ${lastError}` : ""}`,
  );
}

/* ------------------------------------------------------------------ */
/* boot / project lifecycle                                            */
/* ------------------------------------------------------------------ */

export async function createProjectViaUI(page: Page, formatLabel = "Horizontal"): Promise<void> {
  // Start screen: the format cards are labelled "<Format> <Mode>".
  await page.getByText("New Project", { exact: false }).first().waitFor({ timeout: 60_000 });
  await page.getByLabel(new RegExp(`^${formatLabel} `)).click();
  await waitForEditorReady(page);
}

export async function waitForEditorReady(page: Page): Promise<void> {
  // The collaboration status bar mounts with the editor workspace.
  await page.getByRole("switch", { name: "Agent Session" }).waitFor({ timeout: 120_000 });
}

export async function openRecentProjectViaUI(page: Page, projectName: string): Promise<void> {
  await page.getByText("Recent", { exact: true }).waitFor({ timeout: 60_000 });
  const card = page.getByLabel(`Open ${projectName}`);
  await card.waitFor({ timeout: 60_000 });
  await card.click();
  await waitForEditorReady(page);
}

/* ------------------------------------------------------------------ */
/* agent session toggle (real switch)                                  */
/* ------------------------------------------------------------------ */

function agentSessionSwitch(page: Page): Locator {
  return page.getByRole("switch", { name: "Agent Session" });
}

export async function enableAgentSessionViaUI(page: Page, endpointFile?: string): Promise<void> {
  const toggle = agentSessionSwitch(page);
  const isOn = async (): Promise<boolean> =>
    (await toggle.getAttribute("aria-checked")) === "true" &&
    (endpointFile === undefined || existsSync(endpointFile));
  // G-04: a stale status push can leave the store thinking the session is on
  // while main has it off — the first click then goes to the store's
  // disable() and a second click actually enables, exactly what a real user
  // would do. Ground truth = aria-checked AND the endpoint file present.
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (await isOn()) return;
    await toggle.click();
    try {
      await waitFor(isOn, 15_000, "Agent Session switch to turn on");
      return;
    } catch {
      /* store still disagreeing — click again */
    }
  }
  throw new Error("Agent Session switch could not be turned on after 4 clicks");
}

export async function disableAgentSessionViaUI(page: Page, endpointFile?: string): Promise<void> {
  const toggle = agentSessionSwitch(page);
  if ((await toggle.getAttribute("aria-checked")) !== "false") {
    await toggle.click();
  }
  if (endpointFile !== undefined) {
    // Ground truth, immune to the G-04 stale-status race: main deletes the
    // endpoint file on stop. (disable() also blocks for seconds in main:
    // the endpoint's server.close() drains the shim's HTTP keep-alive
    // socket first — G-03. 60 s is headroom, not a weakened assertion.)
    await waitFor(
      () => Promise.resolve(!existsSync(endpointFile)),
      60_000,
      "live endpoint file to be removed on disable",
    );
    return;
  }
  await waitFor(
    async () => (await toggle.getAttribute("aria-checked")) === "false",
    60_000,
    "Agent Session switch to turn off",
  );
}

/* ------------------------------------------------------------------ */
/* text clips via the real Assets panel + timeline                     */
/* ------------------------------------------------------------------ */

/** Assets → Text tab → Add Title: creates "New Title" at the playhead and selects it. */
export async function createTextClipViaUI(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Text", exact: true }).click();
  await page.getByRole("button", { name: "Add Title" }).click();
  await timelineTextClip(page, "New Title").waitFor({ timeout: 15_000 });
}

export function timelineTextClip(page: Page, text: string): Locator {
  return page.getByRole("button", { name: `Select text clip ${text}`, exact: true });
}

export async function selectTextClipViaUI(page: Page, text: string): Promise<void> {
  const clip = timelineTextClip(page, text);
  await clip.waitFor({ timeout: 15_000 });
  await clip.click();
  await waitFor(
    async () => (await clip.getAttribute("aria-pressed")) === "true",
    10_000,
    `text clip "${text}" to become selected`,
  );
}

/* ------------------------------------------------------------------ */
/* playhead via the real time ruler (aim observed via the agent read)  */
/* ------------------------------------------------------------------ */

export type ReadPlayhead = () => Promise<number | null>;

/**
 * Click the ruler so the playhead lands at `seconds`. Aims by linear
 * calibration: two probe clicks → slope/offset from the OBSERVED playhead
 * (agent-channel read), then the final click plus one closed-loop correction.
 * All clicks are real; observation only steers the aim.
 */
export async function setPlayheadViaUI(
  page: Page,
  seconds: number,
  readPlayhead: ReadPlayhead,
  toleranceSec = 0.25,
): Promise<number> {
  const ruler = page.getByTestId("timeline-time-ruler");
  await ruler.waitFor({ timeout: 30_000 });
  const box = await ruler.boundingBox();
  if (!box) throw new Error("time ruler has no box");
  // The ruler strip is content-wide (duration × pps) and slides inside an
  // overflow-hidden viewport — clicks must land in the VISIBLE intersection,
  // not at raw fractions of the full strip width.
  const viewportBox = await ruler.locator("xpath=../..").boundingBox();
  if (!viewportBox) throw new Error("time ruler viewport has no box");
  const visibleLeft = Math.max(box.x, viewportBox.x);
  const visibleRight = Math.min(box.x + box.width, viewportBox.x + viewportBox.width);
  const visibleWidth = visibleRight - visibleLeft;
  if (visibleWidth < 100) throw new Error("time ruler visible region too narrow");

  const clickAt = async (x: number): Promise<number | null> => {
    await page.mouse.click(visibleLeft + x, box.y + box.height / 2);
    await page.waitForTimeout(250);
    return readPlayhead();
  };

  // Two probe clicks for the linear fit (x px → t s), inside the visible span.
  const x1 = Math.max(40, visibleWidth * 0.25);
  const t1 = await clickAt(x1);
  const x2 = Math.max(80, visibleWidth * 0.55);
  const t2 = await clickAt(x2);
  if (t1 === null || t2 === null || Math.abs(t2 - t1) < 0.01) {
    throw new Error(`ruler calibration failed: t1=${t1} t2=${t2}`);
  }
  const pps = (x2 - x1) / (t2 - t1);
  const offset = t1 - x1 / pps;

  let x = (seconds - offset) * pps;
  let actual = await clickAt(Math.max(0, x));
  if (actual !== null && Math.abs(actual - seconds) > toleranceSec) {
    x += (seconds - actual) * pps;
    actual = await clickAt(Math.max(0, x));
  }
  if (actual === null || Math.abs(actual - seconds) > toleranceSec) {
    throw new Error(`ruler seek missed: wanted ${seconds}s, got ${actual}`);
  }
  return actual;
}

/* ------------------------------------------------------------------ */
/* canvas target point (real crosshair gesture)                        */
/* ------------------------------------------------------------------ */

export type ReadCanvasPoint = () => Promise<{ x: number; y: number } | null>;

/**
 * Arm "Set agent target point" and click the preview canvas so the stored
 * normalized point lands at (fx, fy). Closed-loop: aim → observe via the
 * agent channel → one correction click (re-arming each time, since a
 * successful click disarms).
 */
export async function setCanvasPointViaUI(
  page: Page,
  fx: number,
  fy: number,
  readCanvasPoint: ReadCanvasPoint,
  tolerance = 0.03,
): Promise<{ x: number; y: number }> {
  const armButton = page.getByRole("button", { name: "Set agent target point" });
  await armButton.waitFor({ timeout: 30_000 });
  const canvas = page.getByTestId("preview-canvas");
  await canvas.waitFor({ timeout: 30_000 });
  const box = await canvas.boundingBox();
  if (!box) throw new Error("preview canvas has no box");

  const attempt = async (ax: number, ay: number): Promise<{ x: number; y: number } | null> => {
    // (Re-)arm unless already armed. When a point already exists, the first
    // click CLEARS it (Preview's toggle semantics) and a second click arms —
    // exactly the user's gesture sequence.
    for (let i = 0; i < 2; i += 1) {
      if ((await armButton.getAttribute("aria-pressed")) === "true") break;
      await armButton.click();
      try {
        await waitFor(
          async () => (await armButton.getAttribute("aria-pressed")) === "true",
          5_000,
          "target-point crosshair to arm",
        );
      } catch {
        if (i === 1) throw new Error("target-point crosshair failed to arm after clear+rearm");
      }
    }
    await page.mouse.click(box.x + box.width * ax, box.y + box.height * ay);
    await page.waitForTimeout(250);
    return readCanvasPoint();
  };

  let point = await attempt(fx, fy);
  if (
    point !== null &&
    (Math.abs(point.x - fx) > tolerance || Math.abs(point.y - fy) > tolerance)
  ) {
    // Correct by the observed delta (letterbox/offset compensation).
    point = await attempt(fx + (fx - point.x), fy + (fy - point.y));
  }
  if (
    point === null ||
    Math.abs(point.x - fx) > tolerance ||
    Math.abs(point.y - fy) > tolerance
  ) {
    throw new Error(`canvas point missed: wanted (${fx}, ${fy}), got ${JSON.stringify(point)}`);
  }
  return point;
}

/** Real drag of a timeline text clip by deltaX pixels (a genuine user edit). */
export async function dragTextClipViaUI(page: Page, text: string, deltaXPx: number): Promise<void> {
  const clip = timelineTextClip(page, text);
  await clip.waitFor({ timeout: 15_000 });
  const box = await clip.boundingBox();
  if (!box) throw new Error(`text clip "${text}" has no box`);
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  // Intermediate moves so the gesture registers as a drag, not a click.
  await page.mouse.move(startX + deltaXPx / 2, startY, { steps: 5 });
  await page.mouse.move(startX + deltaXPx, startY, { steps: 5 });
  await page.mouse.up();
  await page.waitForTimeout(400);
}

/* ------------------------------------------------------------------ */
/* undo / redo — blocked by gap G-01 (see flow-a spec)                 */
/* ------------------------------------------------------------------ */

export async function pressUndo(page: Page): Promise<void> {
  await page.keyboard.press("Meta+z");
  await page.waitForTimeout(400);
}

export async function pressRedo(page: Page): Promise<void> {
  await page.keyboard.press("Meta+Shift+z");
  await page.waitForTimeout(400);
}
