import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  canonicalEndpointPath,
  classifyDescriptorOwnership,
  endpointOverridePath,
  foreignDescriptorRefusal,
  legacyEndpointPath,
  planLegacyCompatWriteback,
  resolveEndpointReadPath,
} from "./endpoint-paths.mjs";

/**
 * N03: unit matrix for the standalone endpoint-path resolver (the adapter's
 * twin of apps/desktop/src/shared/endpoint-paths.ts). A separate desktop
 * consistency test pins BOTH implementations to identical outputs.
 */

function freshHome() {
  return mkdtempSync(path.join(tmpdir(), "reelterminal-adapter-paths-"));
}

function writeDescriptor(file, content) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(
    file,
    typeof content === "string" ? content : `${JSON.stringify(content)}\n`,
  );
}

const LEGACY_CONVERSATION_DESCRIPTOR = {
  version: 1,
  transport: "http-jsonrpc-long-poll",
  endpoint: "http://127.0.0.1:4545/conversation",
  token: "t".repeat(16),
  sessionId: "s",
  agent: { name: "Codex" },
  adapter: { name: "kit", capabilityLevel: "basic" },
};

test("canonical and legacy paths live under ~/.reelterminal and ~/.openreel", () => {
  assert.equal(
    canonicalEndpointPath("/home/u", "conversation-endpoint"),
    path.join("/home/u", ".reelterminal", "conversation-endpoint.json"),
  );
  assert.equal(
    legacyEndpointPath("/home/u", "conversation-visual-state"),
    path.join("/home/u", ".openreel", "conversation-visual-state"),
  );
});

test("override precedence: new name wins, empty new name never consults the old name", () => {
  assert.equal(
    endpointOverridePath(
      { REELTERMINAL_CONVERSATION_ENDPOINT_FILE: "/n", OPENREEL_CONVERSATION_ENDPOINT_FILE: "/o" },
      "conversation-endpoint",
    ),
    "/n",
  );
  assert.equal(
    endpointOverridePath({ OPENREEL_CONVERSATION_ENDPOINT_FILE: "/o" }, "conversation-endpoint"),
    "/o",
  );
  assert.equal(
    endpointOverridePath(
      { REELTERMINAL_CONVERSATION_ENDPOINT_FILE: "", OPENREEL_CONVERSATION_ENDPOINT_FILE: "/o" },
      "conversation-endpoint",
    ),
    "",
  );
});

test("resolution prefers canonical, discovers owned legacy, refuses foreign", () => {
  let home = freshHome();
  const canonical = canonicalEndpointPath(home, "conversation-endpoint");
  const legacy = legacyEndpointPath(home, "conversation-endpoint");
  try {
    writeDescriptor(canonical, LEGACY_CONVERSATION_DESCRIPTOR);
    writeDescriptor(legacy, LEGACY_CONVERSATION_DESCRIPTOR);
    assert.deepEqual(resolveEndpointReadPath("conversation-endpoint", { env: {}, home }), {
      path: canonical,
    });

    home = freshHome();
    writeDescriptor(legacyEndpointPath(home, "conversation-endpoint"), LEGACY_CONVERSATION_DESCRIPTOR);
    assert.deepEqual(resolveEndpointReadPath("conversation-endpoint", { env: {}, home }), {
      path: legacyEndpointPath(home, "conversation-endpoint"),
      legacyDiscovery: true,
    });

    home = freshHome();
    writeDescriptor(legacyEndpointPath(home, "conversation-endpoint"), {
      product: "another-product",
    });
    const refused = resolveEndpointReadPath("conversation-endpoint", { env: {}, home });
    assert.match(refused.conflict, /another product/);
    assert.match(refused.conflict, /another-product/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("ownership classification mirrors the desktop module", () => {
  assert.equal(
    classifyDescriptorOwnership("conversation-endpoint", { product: "reelterminal" }),
    "product",
  );
  assert.equal(
    classifyDescriptorOwnership("conversation-endpoint", LEGACY_CONVERSATION_DESCRIPTOR),
    "legacy-shape",
  );
  assert.equal(
    classifyDescriptorOwnership("conversation-endpoint", { product: "other" }),
    "foreign",
  );
  assert.equal(classifyDescriptorOwnership("live-endpoint", { url: "x", token: "y" }), "invalid");
});

test("explicit foreign targets are refused with the override name", () => {
  const home = freshHome();
  const file = legacyEndpointPath(home, "conversation-endpoint");
  try {
    writeDescriptor(file, { product: "rival", junk: true });
    const message = foreignDescriptorRefusal("conversation-endpoint", file);
    assert.match(message, /rival/);
    assert.match(message, /REELTERMINAL_CONVERSATION_ENDPOINT_FILE/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("write-back plan mirrors only owned, dead legacy descriptors", async () => {
  const home = freshHome();
  const canonical = canonicalEndpointPath(home, "conversation-endpoint");
  const legacy = legacyEndpointPath(home, "conversation-endpoint");
  try {
    writeDescriptor(legacy, LEGACY_CONVERSATION_DESCRIPTOR);
    const stale = await planLegacyCompatWriteback({
      resource: "conversation-endpoint",
      targetPath: canonical,
      explicitTarget: false,
      home,
      probeAlive: async () => false,
    });
    assert.deepEqual(stale, { writeback: true, reason: "owned-stale", legacyPath: legacy });

    const alive = await planLegacyCompatWriteback({
      resource: "conversation-endpoint",
      targetPath: canonical,
      explicitTarget: false,
      home,
      probeAlive: async () => true,
    });
    assert.equal(alive.writeback, false);
    assert.equal(alive.reason, "alive");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }

  const home2 = freshHome();
  try {
    writeDescriptor(legacyEndpointPath(home2, "conversation-endpoint"), {
      product: "someone-else",
    });
    const foreign = await planLegacyCompatWriteback({
      resource: "conversation-endpoint",
      targetPath: canonicalEndpointPath(home2, "conversation-endpoint"),
      explicitTarget: false,
      home: home2,
      probeAlive: async () => false,
    });
    assert.equal(foreign.writeback, false);
    assert.equal(foreign.reason, "foreign");
  } finally {
    rmSync(home2, { recursive: true, force: true });
  }
});
