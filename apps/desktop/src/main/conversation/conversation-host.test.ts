import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canonicalEndpointPath,
  legacyEndpointPath,
} from "../../shared/endpoint-paths";
import {
  createConversationHost,
  type ConversationHostDeps,
} from "./conversation-host";
import {
  ConversationDescriptorError,
  type ConversationEndpointDescriptor,
} from "./loopback-connector";

/**
 * N03: the conversation panel's read side resolves override → canonical →
 * owned-legacy discovery; a foreign product at the legacy path fails the
 * inspection instead of silently picking a side.
 */

let tempDir = "";

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = "";
});

function fixtureDescriptor(overrides: Partial<ConversationEndpointDescriptor> = {}) {
  return {
    version: 1 as const,
    transport: "http-jsonrpc-long-poll" as const,
    endpoint: "http://127.0.0.1:4545/conversation",
    token: "f".repeat(32),
    sessionId: "session-legacy",
    agent: { name: "Codex" },
    adapter: { name: "kit", capabilityLevel: "basic" as const },
    ...overrides,
  };
}

function makeHost(
  deps: Pick<ConversationHostDeps, "resolveReadDescriptorPath"> &
    Partial<ConversationHostDeps>,
) {
  return createConversationHost({
    descriptorFilePath: path.join(tempDir, "unused-primary-descriptor.json"),
    emitEvent: () => undefined,
    getWorkMode: () => ({ mode: "collaborative" }) as never,
    ...deps,
  });
}

describe("conversation host descriptor discovery (N03)", () => {
  it("inspects through the resolved path (legacy discovery)", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "reelterminal-conv-host-"));
    const legacy = legacyEndpointPath(tempDir, "conversation-endpoint");
    mkdirSync(path.dirname(legacy), { recursive: true });
    writeFileSync(legacy, JSON.stringify(fixtureDescriptor()));
    if (process.platform !== "win32") chmodSync(legacy, 0o600);
    const host = makeHost({
      resolveReadDescriptorPath: () => ({
        path: legacy,
        legacyDiscovery: true,
      }),
    });
    const state = await host.getState();
    expect(state.adapter.availability).toBe("available");
    expect(state.adapter.sessionId).toBe("session-legacy");
    expect(state.adapter.message).toBeNull();
  });

  it("fails with the conflict message instead of guessing a side", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "reelterminal-conv-host-"));
    const canonical = canonicalEndpointPath(tempDir, "conversation-endpoint");
    const host = makeHost({
      resolveReadDescriptorPath: () => ({
        path: canonical,
        conflict:
          "Both paths exist and the legacy descriptor belongs to another product",
      }),
    });
    await expect(host.attach()).rejects.toBeInstanceOf(ConversationDescriptorError);
    await expect(host.attach()).rejects.toThrow(/another product/);
    const state = await host.getState();
    expect(state.adapter.availability).toBe("invalid");
    expect(state.adapter.message).toContain("another product");
  });

  it("falls back to the primary descriptor path without a resolver", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "reelterminal-conv-host-"));
    const primary = path.join(tempDir, "descriptor.json");
    writeFileSync(primary, JSON.stringify(fixtureDescriptor({ sessionId: "primary-session" })));
    if (process.platform !== "win32") chmodSync(primary, 0o600);
    const host = makeHost({ descriptorFilePath: primary });
    const state = await host.getState();
    expect(state.adapter.availability).toBe("available");
    expect(state.adapter.sessionId).toBe("primary-session");
  });
});
