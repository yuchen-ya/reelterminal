import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { preprocessFrame } from "./preprocess";

const fixtureDirectory = resolve(process.env.REEL_SEGMENTATION_FIXTURE_DIR ?? ".cache/mobilesam-validation-2026-11-07/native-fixtures");

it.skipIf(!existsSync(join(fixtureDirectory, "manifest.json")))(
  "matches official offline tensors for both public photos and rotated RGB upsampling", async () => {
    const fixtures: { id: string; width: number; height: number; rotation: 0 | 90 }[] = JSON.parse(
      await readFile(join(fixtureDirectory, "manifest.json"), "utf8"));
    for (const fixture of fixtures) {
      const rgba = await readFile(join(fixtureDirectory, `${fixture.id}.rgba`));
      const reference = await readFile(join(fixtureDirectory, `${fixture.id}.f32`));
      const expected = new Float32Array(reference.buffer.slice(reference.byteOffset, reference.byteOffset + reference.byteLength));
      const actual = preprocessFrame({ ...fixture, revision: "public-reference", rgba });
      expect(actual.length).toBe(expected.length);
      let maximumError = 0;
      for (let index = 0; index < actual.length; index++) maximumError = Math.max(maximumError, Math.abs(actual[index] - expected[index]));
      expect(maximumError, fixture.id).toBeLessThanOrEqual(1e-6);
    }
  });
