import { describe, expect, it } from "vitest";
import { evidenceJsonReplacer } from "./evidence";

describe("evidence path redaction", () => {
  it("removes machine-specific roots from nested values without changing useful evidence", () => {
    const source = { roots: ["C:\\Users\\PrivatePerson\\Temp\\sample.mp4", "/home/private-person/work/sample.png", "E:\\1my_projects\\reelterminal\\sample"], count: 3 };
    const result = JSON.parse(JSON.stringify(source, evidenceJsonReplacer));
    expect(result).toEqual({ roots: ["<home>\\Temp\\sample.mp4", "<home>/work/sample.png", "<local-root>\\reelterminal\\sample"], count: 3 });
  });

  it("leaves credential fields and credential-shaped text for the privacy gate to reject", () => {
    const token = `ghp_${"a".repeat(36)}`;
    const source = { token: `C:\\Users\\${token}`, message: `/home/${token}/file` };
    expect(JSON.parse(JSON.stringify(source, evidenceJsonReplacer))).toEqual(source);
  });
});
