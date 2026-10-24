export const SCRUB_VIDEO_IDLE_MS = 3_000;
export const PAUSED_VIDEO_FRAME_TIMEOUT_MS = 500;

export type VideoFrameReadResult = "ready" | "cached" | "timeout" | "error" | "cancelled";

/** Owns readiness waits for one paused decoder. Media events never request a
 * second render while the current render is waiting for that same decoder. */
export class PausedVideoFrameReader {
  private pending: { check(): void; finish(result: VideoFrameReadResult): void } | undefined;
  private recovery: { time: number; ready(): void } | undefined;
  private disposed = false;
  private readonly events = ["loadedmetadata", "loadeddata", "canplay", "seeked", "error"];

  constructor(private readonly video: HTMLVideoElement) {
    for (const event of this.events) video.addEventListener(event, this.onReady);
  }

  private drawableAt(time: number): boolean {
    return !this.video.seeking && this.video.readyState >= 2 &&
      this.video.videoWidth > 0 && this.video.videoHeight > 0 &&
      Math.abs(this.video.currentTime - time) < 0.000001;
  }

  private onReady = (event: Event): void => {
    if (event.type === "error") {
      this.recovery = undefined;
      this.pending?.finish("error");
      return;
    }
    this.pending?.check();
    const recovery = this.recovery;
    if (recovery && this.drawableAt(recovery.time)) {
      this.recovery = undefined;
      recovery.ready();
    }
  };

  waitForMetadata(): Promise<VideoFrameReadResult> {
    return this.wait(() => this.video.readyState >= 1, 10_000);
  }

  seek(time: number, onLateReady: () => void): Promise<VideoFrameReadResult> {
    this.recovery = undefined;
    if (this.disposed) return Promise.resolve("cancelled");
    if (this.drawableAt(time)) return Promise.resolve("cached");
    // Register the wait before assigning currentTime. seeked + HAVE_CURRENT_DATA
    // confirm a drawable paused frame; rVFC is not required to fire again.
    return this.wait(
      () => this.drawableAt(time),
      PAUSED_VIDEO_FRAME_TIMEOUT_MS,
      () => { this.video.currentTime = time; },
      () => { this.recovery = { time, ready: onLateReady }; },
    );
  }

  private wait(
    ready: () => boolean,
    timeoutMs: number,
    start?: () => void,
    onTimeout?: () => void,
  ): Promise<VideoFrameReadResult> {
    if (this.disposed) return Promise.resolve("cancelled");
    this.pending?.finish("cancelled");
    return new Promise((resolve, reject) => {
      const finish = (result: VideoFrameReadResult) => {
        if (this.pending !== pending) return;
        clearTimeout(timer);
        this.pending = undefined;
        if (result === "timeout") onTimeout?.();
        resolve(result);
      };
      const pending = { check: () => { if (ready()) finish("ready"); }, finish };
      const timer = setTimeout(() => finish("timeout"), timeoutMs);
      this.pending = pending;
      try {
        start?.();
        pending.check();
      } catch (error) {
        clearTimeout(timer);
        this.pending = undefined;
        reject(error);
      }
    });
  }

  dispose(): void {
    this.disposed = true;
    this.recovery = undefined;
    this.pending?.finish("cancelled");
    for (const event of this.events) this.video.removeEventListener(event, this.onReady);
  }
}
