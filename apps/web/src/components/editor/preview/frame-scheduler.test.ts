/**
 * Contract for FrameRenderScheduler: at most one render in flight, the
 * latest pending target always runs (no starvation under continuous input),
 * and stale results can never commit over a newer frame.
 */
import { describe, expect, it } from "vitest";
import {
  FrameRenderScheduler,
  type FrameRequestToken,
} from "./frame-scheduler";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("FrameRenderScheduler", () => {
  it("commits progress during continuous input and then lands on the latest pending target", async () => {
    const painted: number[] = [];
    const releases: Array<() => void> = [];
    const scheduler = new FrameRenderScheduler(async token => {
      await new Promise<void>(resolve => releases.push(resolve));
      if (scheduler.markCommitted(token)) painted.push(token.time);
    });
    const request = (time: number) => scheduler.request(time, 10, undefined, { continuous: true });
    request(1);
    request(2);
    request(3);
    releases.shift()!();
    await tick();
    expect(painted).toEqual([1]);
    request(4);
    releases.shift()!();
    await tick();
    expect(painted).toEqual([1, 3]);
    releases.shift()!();
    await tick();
    expect(painted).toEqual([1, 3, 4]);
  });

  it("deduplicates move/release at the same target while preserving explicit redraws", async () => {
    const started: number[] = [];
    let release!: () => void;
    const scheduler = new FrameRenderScheduler(async token => {
      started.push(token.time);
      await new Promise<void>(resolve => { release = resolve; });
      scheduler.markCommitted(token);
    });
    scheduler.request(1, 10);
    scheduler.request(1, 10);
    release();
    await tick();
    scheduler.request(1, 10);
    expect(started).toEqual([1]);
    scheduler.request(1, 10, undefined, { force: true });
    expect(started).toEqual([1, 1]);
    release();
    await tick();
  });

  it("hard-invalidates continuous progress on a jump, revision or workspace switch", async () => {
    const tokens: FrameRequestToken[] = [];
    let context = "workspace-a";
    const scheduler = new FrameRenderScheduler(async token => { tokens.push(token); }, undefined, () => context);
    scheduler.request(1, 10, undefined, { continuous: true });
    await tick();
    scheduler.request(2, 10);
    expect(scheduler.markCommitted(tokens[0])).toBe(false);
    await tick();
    scheduler.request(3, 10, undefined, { continuous: true });
    await tick();
    context = "workspace-b";
    expect(scheduler.markCommitted(tokens[2])).toBe(false);
    scheduler.request(4, 11, undefined, { continuous: true });
    await tick();
    expect(scheduler.markCommitted(tokens[2])).toBe(false);
    expect(scheduler.markCommitted(tokens[3])).toBe(true);
  });

  it("runs at most one render at a time and keeps only the latest pending target", async () => {
    const started: number[] = [];
    const gates: Array<() => void> = [];
    const scheduler = new FrameRenderScheduler(async (token) => {
      started.push(token.time);
      await new Promise<void>((resolve) => gates.push(resolve));
    });

    scheduler.request(1, 10);
    scheduler.request(2, 10);
    scheduler.request(3, 10);
    await tick();

    // Only the first request started; 2 was replaced by 3 as pending.
    expect(started).toEqual([1]);

    gates.shift()!();
    await tick();
    // The latest target runs next — the intermediate one was dropped.
    expect(started).toEqual([1, 3]);

    gates.shift()!();
    await tick();
    expect(started).toEqual([1, 3]);
  });

  it("keeps servicing later requests after a burst (no long-term starvation)", async () => {
    const started: number[] = [];
    const scheduler = new FrameRenderScheduler(async (token) => {
      started.push(token.time);
    });

    for (let i = 0; i < 50; i += 1) {
      scheduler.request(i, 10);
    }
    await tick();
    await tick();

    // Whatever survived coalescing, the newest target must have run.
    expect(started).toContain(49);
    expect(started.length).toBeLessThanOrEqual(2);
  });

  it("marks results stale once a newer frame commits", async () => {
    const tokens: FrameRequestToken[] = [];
    let releaseFirst: (() => void) | null = null;
    const scheduler = new FrameRenderScheduler(async (token) => {
      tokens.push(token);
      if (tokens.length === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
    });

    scheduler.request(1, 10);
    await tick();
    const first = tokens[0];
    expect(scheduler.isCurrent(first)).toBe(true);

    // A newer request superseded the first before it finished.
    scheduler.request(2, 10);
    releaseFirst!();
    await tick();
    await tick();

    const second = tokens[1];
    expect(scheduler.markCommitted(second)).toBe(true);
    // The old result must not paint over the newer committed frame.
    expect(scheduler.isCurrent(first)).toBe(false);
    expect(scheduler.markCommitted(first)).toBe(false);
  });

  it("expires an in-flight frame as soon as a newer request is queued", async () => {
    const tokens: FrameRequestToken[] = [];
    let releaseFirst: (() => void) | null = null;
    const scheduler = new FrameRenderScheduler(async (token) => {
      tokens.push(token);
      if (tokens.length === 1) {
        await new Promise<void>((resolve) => { releaseFirst = resolve; });
      }
    });

    scheduler.request(1, 10);
    await tick();
    const first = tokens[0]!;
    scheduler.request(2, 10);

    expect(scheduler.isCurrent(first)).toBe(false);
    expect(scheduler.markCommitted(first)).toBe(false);

    releaseFirst!();
    await tick();
    await tick();
    expect(scheduler.markCommitted(tokens[1]!)).toBe(true);
  });

  it("expires results when the world changes underneath them", async () => {
    const tokens: FrameRequestToken[] = [];
    const scheduler = new FrameRenderScheduler(async (token) => {
      tokens.push(token);
    });

    scheduler.request(1, 10);
    await tick();

    scheduler.invalidate();
    expect(scheduler.isCurrent(tokens[0])).toBe(false);
    expect(scheduler.markCommitted(tokens[0])).toBe(false);
  });

  it("expires frames immediately when the owning view generation changes", async () => {
    const tokens: FrameRequestToken[] = [];
    let viewGeneration = 1;
    const scheduler = new FrameRenderScheduler(async (token) => {
      tokens.push(token);
    }, () => viewGeneration);

    scheduler.request(1, 10);
    await tick();
    viewGeneration += 1;

    expect(scheduler.isCurrent(tokens[0]!)).toBe(false);
    expect(scheduler.markCommitted(tokens[0]!)).toBe(false);
  });

  it("expires results made against an older project revision", async () => {
    const tokens: FrameRequestToken[] = [];
    const scheduler = new FrameRenderScheduler(async (token) => {
      tokens.push(token);
    });

    scheduler.request(1, 10);
    await tick();

    scheduler.request(1, 11);
    await tick();

    // The frame rendered for revision 10 may not paint after revision 11.
    expect(scheduler.markCommitted(tokens[0])).toBe(false);
    expect(scheduler.markCommitted(tokens[1])).toBe(true);
  });

  it("does not start another render while one is in flight", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const scheduler = new FrameRenderScheduler(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight -= 1;
    });

    scheduler.request(1, 10);
    scheduler.request(2, 10);
    scheduler.request(3, 10);
    await tick();
    expect(maxInFlight).toBe(1);

    releases.shift()!();
    await tick();
    releases.shift()!();
    await tick();
    expect(maxInFlight).toBe(1);
    expect(scheduler.busy).toBe(false);
  });
});
