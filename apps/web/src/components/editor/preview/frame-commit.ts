/**
 * Commit policy for preview frames.
 *
 * A rendered frame may reach the visible canvas and replace the remembered
 * "last good" picture only when it is a complete, valid bitmap AND its render
 * request is still the newest one. Everything else — a failed decode, a
 * zero-size bitmap, a superseded request, a throw — must leave both the
 * canvas and the remembered frame exactly as they were.
 *
 * The bitmap swap is create-then-swap: the replacement is produced and
 * validated first, and only then does the old bitmap get closed. A failed
 * encode therefore can never lose the previously confirmed picture.
 */

export type FrameCommitResult = "committed" | "stale" | "invalid";

export interface FrameCommitGate {
  /** False once the request was invalidated (media switch, unmount, ...). */
  isCurrent(): boolean;
  /** Claims the canvas for this request; false when a newer frame already committed. */
  claimCommit(): boolean;
  /** The remembered frame slot — updated only on a successful commit. */
  lastGood: { current: ImageBitmap | null };
}

export interface FrameCommitSource {
  /** Produces the full-frame bitmap to remember. */
  produce: () => Promise<ImageBitmap | null>;
  /** Paints the frame to the visible canvas. Runs only for a winning frame. */
  paint: (frame: ImageBitmap) => void;
}

export async function commitRenderedFrame(
  gate: FrameCommitGate,
  source: FrameCommitSource,
): Promise<FrameCommitResult> {
  let frame: ImageBitmap | null = null;
  try {
    frame = await source.produce();
  } catch {
    frame = null;
  }

  if (!frame || frame.width === 0 || frame.height === 0) {
    // Failed or empty result: never replaces the last good frame.
    frame?.close();
    return "invalid";
  }

  if (!gate.isCurrent() || !gate.claimCommit()) {
    frame.close();
    return "stale";
  }

  // Claim + paint + swap stay in one synchronous block so no other task can
  // slip a paint in between and end up overwritten by this one.
  source.paint(frame);

  const previous = gate.lastGood.current;
  gate.lastGood.current = frame;
  previous?.close();
  return "committed";
}
