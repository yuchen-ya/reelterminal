import { describe, expect, it } from "vitest";
import { alignedWordsToCaptions } from "./media/qwen-captions";

const word = (
  text: string,
  startSec: number,
  endSec: number,
  language = "English",
) => ({ text, startSec, endSec, language });
describe("word-aligned captions", () => {
  it("keeps punctuation and decimal points and groups zero-duration function words", () => {
    const cues = alignedWordsToCaptions(
      [
        word("A", 1, 1),
        word("circle", 1, 1.4),
        word("is", 1.4, 1.5),
        word("6.28.", 1.5, 2),
        word("Next.", 3, 4),
      ],
      5,
    );
    expect(
      cues.map(({ text, startSec, endSec }) => ({ text, startSec, endSec })),
    ).toEqual([
      { text: "A circle is 6.28.", startSec: 1, endSec: 2 },
      { text: "Next.", startSec: 3, endSec: 4 },
    ]);
    expect(cues[0]!.words).toHaveLength(4);
  });
  it("joins Chinese without introducing spaces and uses measured word endpoints", () => {
    expect(
      alignedWordsToCaptions(
        [
          word("圆", 0.5, 0.7, "Chinese"),
          word("周", 0.7, 0.9, "Chinese"),
          word("率。", 0.9, 1.1, "Chinese"),
        ],
        2,
      )[0],
    ).toMatchObject({ text: "圆周率。", startSec: 0.5, endSec: 1.1 });
  });
  it.each([
    [word("outside", 1, 9)],
    [word("backwards", 2, 1)],
    [word("NaN", NaN, 2)],
    [word("one", 0, 2), word("overlap", 1, 3)],
    [word("negative", -1, 1)],
  ])("rejects invalid worker timing before publishing", (...words) => {
    expect(() => alignedWordsToCaptions(words, 5)).toThrow("timestamps");
  });
  it("refuses an entirely zero-duration transcript rather than inventing durations", () => {
    expect(() => alignedWordsToCaptions([word("hello", 1, 1)], 5)).toThrow(
      "positive-duration",
    );
  });
});
