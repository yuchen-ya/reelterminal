import { expect, it } from "vitest";
import { EmbeddingCache } from "./embedding-cache";

it("bounds cache bytes and entry count, refreshes LRU reads and clears frame embeddings", () => {
  const cache = new EmbeddingCache<string>(2, 8);
  cache.set("a", "image-a", 4);
  cache.set("b", "image-b", 4);
  expect(cache.get("a")).toBe("image-a");
  cache.set("c", "image-c", 4);
  expect(cache.get("b")).toBeUndefined();
  cache.set("a", "new-a", 7);
  expect(cache.get("c")).toBeUndefined();
  expect(cache.get("a")).toBe("new-a");
  cache.set("oversized", "too-large", 9);
  expect(cache.get("oversized")).toBeUndefined();
  cache.clear();
  expect(cache.get("a")).toBeUndefined();
  const countBound = new EmbeddingCache<string>(1, 20);
  countBound.set("a", "a", 1);
  countBound.set("b", "b", 1);
  expect(countBound.get("a")).toBeUndefined();
});
