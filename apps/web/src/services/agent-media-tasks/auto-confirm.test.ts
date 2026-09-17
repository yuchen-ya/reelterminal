import { describe, expect, it } from "vitest";
import {
  decideTaskAutoConfirmation,
  isManualConfirmOnly,
  MANUAL_CONFIRM_NOTICE,
} from "./auto-confirm";

describe("decideTaskAutoConfirmation", () => {
  it("degrades to manual-only when formal_reply is explicitly unsupported", () => {
    // The conversation bridge drops the whole agent_message class for this
    // bit, so a RESULT receipt line can never arrive.
    const decision = decideTaskAutoConfirmation({ formalReply: "unsupported" });
    expect(decision.mode).toBe("manual-only");
    expect(isManualConfirmOnly(decision)).toBe(true);
    if (decision.mode === "manual-only") {
      expect(decision.reason).toBe(MANUAL_CONFIRM_NOTICE);
      expect(decision.reason.length).toBeGreaterThan(0);
    }
  });

  it("keeps receipt-based confirmation when formal_reply is supported", () => {
    expect(decideTaskAutoConfirmation({ formalReply: "supported" })).toEqual({
      mode: "receipt",
    });
  });

  it("does not degrade on unknown/omitted bits (bridge keeps them display-compatible)", () => {
    expect(decideTaskAutoConfirmation({ formalReply: "unknown" })).toEqual({
      mode: "receipt",
    });
    expect(decideTaskAutoConfirmation({})).toEqual({ mode: "receipt" });
    expect(decideTaskAutoConfirmation(null)).toEqual({ mode: "receipt" });
    expect(decideTaskAutoConfirmation(undefined)).toEqual({ mode: "receipt" });
  });
});
