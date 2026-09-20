import { chmod, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { launchApp, type LaunchedApp } from "./harness/launch";
import { createProjectViaUI, waitForEditorReady } from "./harness/ui";
import { createEvidence, type EvidenceRecord } from "./harness/evidence";

const FAKE_CODEX_APP_SERVER = `#!/usr/bin/env node
const readline = require("node:readline");
const input = readline.createInterface({ input: process.stdin });
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { userAgent: "codex-cli/e2e-fixture" } });
  } else if (message.method === "account/read") {
    send({ id: message.id, result: { account: { type: "chatgpt", planType: "fixture" }, requiresOpenaiAuth: true } });
  } else if (message.method === "thread/list") {
    send({ id: message.id, result: { data: [{ id: "thr_fixture", name: "Fixture edit session", preview: "A stored Codex conversation", updatedAt: 1725000000, status: { type: "idle" } }], nextCursor: null } });
  } else if (message.method === "thread/resume") {
    send({ id: message.id, result: { thread: { id: message.params.threadId, name: "Fixture edit session" } } });
  } else if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thr_created_fixture" } } });
  } else if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn_fixture", status: "inProgress" } } });
    setImmediate(() => {
      send({ method: "item/completed", params: { threadId: message.params.threadId, turnId: "turn_fixture", item: { id: "message_fixture", type: "agentMessage", text: "Fixture session is connected." } } });
      send({ method: "turn/completed", params: { threadId: message.params.threadId, turn: { id: "turn_fixture", status: "completed" } } });
    });
  } else if (message.method === "turn/interrupt" || message.method === "thread/compact/start") {
    send({ id: message.id, result: {} });
  }
});
`;

describe("Agent connection guide", () => {
  let launched: LaunchedApp;
  let evidence: EvidenceRecord;

  beforeAll(async () => {
    const runDir = await mkdtemp(path.join(tmpdir(), "reelterminal-agent-guide-e2e-"));
    const fakeCodex = path.join(runDir, "fake-codex.cjs");
    await writeFile(fakeCodex, FAKE_CODEX_APP_SERVER, { mode: 0o700 });
    await chmod(fakeCodex, 0o700);
    launched = await launchApp({
      runDir,
      env: { REELTERMINAL_CODEX_COMMAND: fakeCodex },
    });
    evidence = createEvidence("agent-connection-guide", launched.page);
    await createProjectViaUI(launched.page);
    await waitForEditorReady(launched.page);
  }, 240_000);

  afterAll(async () => {
    evidence?.flush();
    await launched?.close();
  });

  test("checks prerequisites, resumes the chosen session, and verifies the live conversation", async () => {
    const page = launched.page;
    const dismissIntro = page.getByRole("button", { name: "Got it", exact: true });
    if (await dismissIntro.isVisible().catch(() => false)) await dismissIntro.click();
    await page.getByRole("button", { name: "Open external agent panel" }).click();

    const guide = page.getByRole("region", { name: "Connect an Agent" });
    await guide.getByText("Codex is installed and its App Server is responding.").waitFor();
    await guide.getByText("A usable Codex account is signed in.").waitFor();
    await guide.getByText("The packaged ReelTerminal connector is ready.").waitFor();
    const thread = guide.getByRole("radio", { name: /Fixture edit session/ });
    await thread.waitFor();
    expect(await thread.getAttribute("aria-checked")).toBe("true");

    await evidence.screenshot("ready-to-connect");
    await guide.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByText("External Agent connected", { exact: true }).waitFor({ timeout: 30_000 });

    const composer = page.getByRole("textbox", { name: "Message the external Agent" });
    await composer.fill("Verify this connection");
    await composer.press("Enter");
    await page.getByText("Fixture session is connected.", { exact: true }).waitFor({ timeout: 30_000 });
    expect(await page.getByRole("switch", { name: "Agent Session" }).getAttribute("aria-checked")).toBe("true");

    await page.getByRole("button", { name: "Disconnect view" }).click();
    await page.getByRole("region", { name: "Connect an Agent" }).waitFor();
    await page
      .getByRole("region", { name: "Connect an Agent" })
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await page.getByText("External Agent connected", { exact: true }).waitFor({ timeout: 30_000 });
    await evidence.screenshot("reconnected");
  }, 120_000);
});
