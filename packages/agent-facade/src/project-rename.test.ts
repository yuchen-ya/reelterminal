import { describe, expect, it } from "vitest";
import { createAgentFacade } from "./index";

describe("project.rename", () => {
  it("renames atomically, trims the name, and supports idempotent replay", async () => {
    const facade = createAgentFacade();
    const created = await facade["project.create"]({ name: "Untitled" });
    expect(created.ok).toBe(true);

    const first = await facade["project.rename"]({
      name: "  Dam Letter  ",
      expectedRevision: 0,
      idempotencyKey: "rename-1",
    });
    expect(first).toEqual({
      ok: true,
      value: {
        revision: 1,
        projectId: expect.any(String),
        previousName: "Untitled",
        name: "Dam Letter",
        replayed: false,
      },
    });

    const replay = await facade["project.rename"]({
      name: "Dam Letter",
      expectedRevision: 0,
      idempotencyKey: "rename-1",
    });
    expect(replay.ok && replay.value.replayed).toBe(true);
    expect(replay.ok && replay.value.revision).toBe(1);

    const state = await facade["project.get_state"]();
    expect(state.ok && state.value.project.name).toBe("Dam Letter");
    expect(state.ok && state.value.revision).toBe(1);
  });

  it("rejects stale revisions and invalid names without changing the project", async () => {
    const facade = createAgentFacade();
    await facade["project.create"]({ name: "Original" });

    const stale = await facade["project.rename"]({
      name: "Stale",
      expectedRevision: 9,
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.error.code).toBe("CONFLICT");

    const invalid = await facade["project.rename"]({ name: "bad\nname" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) expect(invalid.error.code).toBe("INVALID_PARAMS");

    const state = await facade["project.get_state"]();
    expect(state.ok && state.value.project.name).toBe("Original");
    expect(state.ok && state.value.revision).toBe(0);
  });
});
