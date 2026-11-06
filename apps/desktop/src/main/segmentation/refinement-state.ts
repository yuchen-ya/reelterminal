import type { SegmentationPrompts } from "./types";

function extendsPrompts(previous: SegmentationPrompts, next: SegmentationPrompts): boolean {
  if (previous.points.length > next.points.length) return false;
  if (previous.points.some((point, index) => {
    const other = next.points[index];
    return point.x !== other.x || point.y !== other.y || point.foreground !== other.foreground;
  })) return false;
  if (previous.box && (!next.box || previous.box.left !== next.box.left || previous.box.top !== next.box.top ||
      previous.box.right !== next.box.right || previous.box.bottom !== next.box.bottom)) return false;
  return next.points.length > previous.points.length || (!previous.box && !!next.box);
}

/** One active refinement session. Staged logits are published only after main-process acceptance. */
export class RefinementState<T> {
  private owner: string | undefined;
  private accepted: { prompts: SegmentationPrompts; value: T } | undefined;
  private staged: { sequence: number; prompts: SegmentationPrompts; value: T } | undefined;
  private version = 0;

  begin(frameKey: string, refinementId: string): number {
    const owner = JSON.stringify([frameKey, refinementId]);
    if (owner !== this.owner) {
      this.reset();
      this.owner = owner;
    }
    // A new request cannot adopt a previous result that main has not accepted.
    this.staged = undefined;
    return this.version;
  }

  prior(prompts: SegmentationPrompts): T | undefined {
    if (this.accepted && extendsPrompts(this.accepted.prompts, prompts)) return this.accepted.value;
    this.accepted = undefined;
    return undefined;
  }

  stage(sequence: number, prompts: SegmentationPrompts, value: T, version: number): void {
    if (version === this.version) this.staged = { sequence, prompts: structuredClone(prompts), value };
  }

  accept(sequence: number): void {
    if (this.staged?.sequence !== sequence) return;
    this.accepted = this.staged;
    this.staged = undefined;
  }

  cancel(sequence: number): void {
    if (this.staged?.sequence === sequence) this.staged = undefined;
  }

  reset(): void {
    this.version++;
    this.owner = undefined;
    this.accepted = undefined;
    this.staged = undefined;
  }
}
