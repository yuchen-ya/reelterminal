import { describe, expect, it } from "vitest";
import { FacadeError } from "./errors";
import { matchesSchema } from "./validate";

describe("matchesSchema", () => {
  it("rejects invalid nested input but preserves internal validator failures", () => {
    const schema = { name: { required: true, check: (value: unknown) => typeof value === "string", describe: "a string" } };
    expect(matchesSchema({ name: "valid" }, schema)).toBe(true);
    expect(matchesSchema({ name: 1 }, schema)).toBe(false);
    expect(matchesSchema({ name: "valid", extra: true }, schema)).toBe(false);
    expect(matchesSchema(null, schema)).toBe(false);
    const failure = new Error("validator bug");
    expect(() => matchesSchema({ name: "valid" }, { name: { ...schema.name, check: () => { throw failure; } } })).toThrow(failure);
    const internal = new FacadeError("INTERNAL", "unexpected validator failure");
    expect(() => matchesSchema({ name: "valid" }, { name: { ...schema.name, check: () => { throw internal; } } })).toThrow(internal);
  });
});
