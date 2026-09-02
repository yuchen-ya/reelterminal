#!/usr/bin/env node

/**
 * Offline shape/conformance check for the open conversation-adapter fixtures.
 *
 * This deliberately uses only Node built-ins. It never opens a socket, starts
 * an Agent, reads the real endpoint descriptor, or evaluates fixture content.
 */
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const defaultFixtures = [
  join(here, "fixtures", "basic.json"),
  join(here, "fixtures", "full.json"),
];

const CAPABILITY_LEVELS = new Set(["basic", "streaming", "observable"]);
const CONVERSATION_CAPABILITIES = [
  "formalReply",
  "streaming",
  "reasoningSummary",
  "toolEvents",
  "approval",
  "usage",
  "artifact",
  "subtask",
];
const SENSITIVE_KEYS = new Set([
  "token",
  "authorization",
  "apikey",
  "api_key",
  "secret",
  "password",
  "cookie",
  "privatekey",
  "accesskey",
  "refreshtoken",
  "bearer",
  "sessiontoken",
]);
const RAW_REASONING_KEYS = new Set([
  "reasoning",
  "chain_of_thought",
  "chainofthought",
  "cot",
  "thoughts",
]);
const OBSERVABLE_EVENT_TYPES = new Set([
  "reasoning_summary",
  "tool_call",
  "tool_call_update",
  "tool_result",
  "approval_request",
  "subtask",
  "artifact",
  "usage",
]);
const UPDATE_KEYS = {
  tool: new Set(["sessionUpdate", "toolCallId", "title", "status", "summary"]),
  reasoning: new Set(["sessionUpdate", "summary"]),
  approval: new Set(["sessionUpdate", "requestId", "title", "summary", "options"]),
  subtask: new Set(["sessionUpdate", "subtaskId", "title", "status", "summary"]),
  artifact: new Set([
    "sessionUpdate",
    "artifactId",
    "kind",
    "label",
    "mimeType",
    "sizeBytes",
    "status",
  ]),
};

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertJsonRpcRequest(value, path) {
  assert(isObject(value), `${path}: expected an object`);
  assert(value.jsonrpc === "2.0", `${path}: jsonrpc must be 2.0`);
  assert(
    typeof value.id === "string" || typeof value.id === "number",
    `${path}: request id must be a string or number`,
  );
  assert(typeof value.method === "string" && value.method.length > 0, `${path}: method is required`);
  assert(isObject(value.params), `${path}: params must be an object`);
  assert(value.method !== "session/new", `${path}: session/new is forbidden`);
}

function assertJsonRpcResponse(value, path, requestId) {
  assert(isObject(value), `${path}: expected an object`);
  assert(value.jsonrpc === "2.0", `${path}: jsonrpc must be 2.0`);
  assert(value.id === requestId, `${path}: response id does not match request`);
  assert(
    ("result" in value) !== ("error" in value),
    `${path}: response must have exactly one of result/error`,
  );
}

function isFixtureToken(value) {
  return typeof value === "string" && value.startsWith("fixture-") && value.length >= 16;
}

function walkForUnsafeFields(value, path, errors) {
  if (Array.isArray(value)) {
    value.forEach((item, index) => walkForUnsafeFields(item, `${path}[${index}]`, errors));
    return;
  }
  if (!isObject(value)) return;

  for (const [key, child] of Object.entries(value)) {
    const normalized = key.toLowerCase().replaceAll("-", "");
    if (SENSITIVE_KEYS.has(normalized)) {
      const fixtureToken = path === "$.descriptor" && key === "token" && isFixtureToken(child);
      if (!fixtureToken) {
        errors.push(`${path}.${key}: sensitive field must not appear in fixture payloads`);
      }
    }
    if (RAW_REASONING_KEYS.has(normalized)) {
      errors.push(`${path}.${key}: raw reasoning field is forbidden`);
    }
    walkForUnsafeFields(child, `${path}.${key}`, errors);
  }
}

function assertDescriptor(fixture) {
  const descriptor = fixture.descriptor;
  assert(isObject(descriptor), `${fixture.name}: descriptor is required`);
  assert(descriptor.version === 1, `${fixture.name}: descriptor.version must be 1`);
  assert(
    descriptor.transport === "http-jsonrpc-long-poll",
    `${fixture.name}: descriptor.transport must be http-jsonrpc-long-poll`,
  );
  assert(typeof descriptor.endpoint === "string", `${fixture.name}: descriptor.endpoint is required`);
  let endpoint;
  try {
    endpoint = new URL(descriptor.endpoint);
  } catch {
    fail(`${fixture.name}: descriptor.endpoint must be a valid URL`);
  }
  assert(endpoint.protocol === "http:", `${fixture.name}: descriptor.endpoint must use http`);
  assert(endpoint.hostname === "127.0.0.1", `${fixture.name}: descriptor.endpoint must be loopback`);
  assert(endpoint.pathname === "/conversation", `${fixture.name}: descriptor.endpoint must end in /conversation`);
  assert(Number.isInteger(Number(endpoint.port)) && Number(endpoint.port) > 0 && Number(endpoint.port) < 65536,
    `${fixture.name}: descriptor.endpoint must include a valid port`);
  assert(isFixtureToken(descriptor.token), `${fixture.name}: fixture token must be at least 16 characters`);
  assert(typeof descriptor.sessionId === "string" && descriptor.sessionId.length > 0,
    `${fixture.name}: descriptor.sessionId is required`);
  assert(isObject(descriptor.agent), `${fixture.name}: descriptor.agent is required`);
  assert(typeof descriptor.agent.name === "string" && descriptor.agent.name.length > 0,
    `${fixture.name}: descriptor.agent.name is required`);
  if (descriptor.agent.version !== undefined) {
    assert(typeof descriptor.agent.version === "string", `${fixture.name}: agent.version must be a string`);
  }
  assert(isObject(descriptor.adapter), `${fixture.name}: descriptor.adapter is required`);
  assert(typeof descriptor.adapter.name === "string" && descriptor.adapter.name.length > 0,
    `${fixture.name}: descriptor.adapter.name is required`);
  assert(CAPABILITY_LEVELS.has(descriptor.adapter.capabilityLevel),
    `${fixture.name}: adapter.capabilityLevel must be basic, streaming, or observable`);
  const expectedLevel = fixture.fixtureLevel === "basic" ? "basic" : "observable";
  assert(descriptor.adapter.capabilityLevel === expectedLevel,
    `${fixture.name}: fixture level and adapter capabilityLevel mismatch`);
}

function assertConversationCapabilities(value, path, expected, requireAll = false) {
  assert(isObject(value), `${path}: conversation capabilities are required`);
  if (requireAll) {
    for (const name of CONVERSATION_CAPABILITIES) {
      assert(typeof value[name] === "boolean", `${path}.${name}: capability must be boolean`);
    }
  }
  for (const [name, valueForName] of Object.entries(value)) {
    assert(CONVERSATION_CAPABILITIES.includes(name), `${path}.${name}: unknown capability field`);
    assert(typeof valueForName === "boolean", `${path}.${name}: capability must be boolean`);
  }
  if (expected) {
    assert(value.formalReply === expected.formalReply,
      `${path}.formalReply: fixture capability mismatch`);
    assert(value.streaming === expected.streaming,
      `${path}.streaming: fixture capability mismatch`);
  }
}

function assertInitialize(fixture) {
  const request = fixture.initialize;
  assertJsonRpcRequest(request, `${fixture.name}.initialize`);
  assert(request.method === "initialize", `${fixture.name}: initialize method mismatch`);
  assert(request.params.protocolVersion === "openreel-conversation/1",
    `${fixture.name}: unsupported protocol version`);
  if (request.params.protocolVersion !== undefined) {
    assert(
      typeof request.params.protocolVersion === "string" || typeof request.params.protocolVersion === "number",
      `${fixture.name}: protocolVersion must be a string or number when supplied`,
    );
  }
  assert(isObject(request.params.clientInfo), `${fixture.name}: clientInfo is required`);
  const clientCapabilities = request.params.clientCapabilities;
  assert(isObject(clientCapabilities), `${fixture.name}: clientCapabilities are required`);
  assertOnlyKeys(clientCapabilities, new Set(["sessionUpdate", "conversation"]),
    `${fixture.name}.initialize.params.clientCapabilities`);
  assert(clientCapabilities.sessionUpdate === true,
    `${fixture.name}: client sessionUpdate capability is required`);
  assertConversationCapabilities(clientCapabilities.conversation,
    `${fixture.name}.initialize.params.clientCapabilities.conversation`,
    undefined,
    true);

  const response = fixture.initializeResult;
  assertJsonRpcResponse(response, `${fixture.name}.initializeResult`, request.id);
  assert(isObject(response.result), `${fixture.name}: initialize result must be successful`);
  assert(
    typeof response.result.protocolVersion === "string" || typeof response.result.protocolVersion === "number",
    `${fixture.name}: initialize result protocolVersion is required`,
  );
  assert(!("capabilityLevel" in response.result), `${fixture.name}: capabilityLevel is not an initialize field`);
  assert(!("longPoll" in response.result), `${fixture.name}: longPoll is not an initialize field`);
  const sessionCapabilities = response.result.sessionCapabilities;
  assert(isObject(sessionCapabilities),
    `${fixture.name}: session capabilities are required`);
  assertOnlyKeys(sessionCapabilities, new Set(["resume", "prompt", "cancel", "close", "conversation"]),
    `${fixture.name}.initializeResult.result.sessionCapabilities`);
  const expected = fixture.fixtureLevel === "basic"
    ? { formalReply: true, streaming: false }
    : { formalReply: true, streaming: true };
  assertConversationCapabilities(sessionCapabilities.conversation,
    `${fixture.name}.initializeResult.result.sessionCapabilities.conversation`, expected);
}

function assertResume(fixture) {
  const request = fixture.resume;
  assertJsonRpcRequest(request, `${fixture.name}.resume`);
  assert(request.method === "session/resume", `${fixture.name}: resume method mismatch`);
  assert(request.params.sessionId === fixture.descriptor.sessionId,
    `${fixture.name}: resume must use descriptor sessionId`);
  assert(Object.keys(request.params).length === 1,
    `${fixture.name}: session/resume accepts only sessionId`);

  const response = fixture.resumeResult;
  assertJsonRpcResponse(response, `${fixture.name}.resumeResult`, request.id);
  assert(response.result?.sessionId === request.params.sessionId,
    `${fixture.name}: resume response session mismatch`);
}

function assertUnknownExtension(fixture) {
  const extension = fixture.unknownExtension;
  assert(isObject(extension), `${fixture.name}: unknownExtension probe is required`);
  assert(
    typeof extension.sessionUpdate === "string" && extension.sessionUpdate.startsWith("_"),
    `${fixture.name}: vendor extensions must use a _-prefixed discriminator`,
  );
}

function assertOnlyKeys(value, allowed, path) {
  for (const key of Object.keys(value)) {
    assert(allowed.has(key), `${path}.${key}: field is not part of the event schema`);
  }
}

function assertTextContent(value, path) {
  assert(isObject(value) && value.type === "text" && typeof value.text === "string",
    `${path}: text content is required`);
}

function assertTextContentList(value, path) {
  assert(Array.isArray(value), `${path}: formal content is required`);
  value.forEach((item, index) => assertTextContent(item, `${path}[${index}]`));
}

function assertUpdateShape(update, path, fixtureLevel) {
  assert(isObject(update) && typeof update.sessionUpdate === "string",
    `${path}: update discriminator is required`);
  const kind = update.sessionUpdate;
  if (kind.startsWith("_")) {
    assert(kind.length > 1, `${path}: extension name cannot be empty`);
    return;
  }
  switch (kind) {
    case "user_message":
    case "agent_message":
      assertTextContentList(update.content, `${path}.content`);
      break;
    case "agent_message_chunk":
      assert(fixtureLevel !== "basic", `${path}: message chunks require streaming capability`);
      assertTextContent(update.content, `${path}.content`);
      break;
    case "state_update":
      assert(["idle", "working", "cancelled", "failed"].includes(update.state),
        `${path}.state: invalid state`);
      break;
    case "tool_call":
    case "tool_call_update":
    case "tool_result":
      assertOnlyKeys(update, UPDATE_KEYS.tool, path);
      assert(typeof update.toolCallId === "string" && update.toolCallId.length > 0,
        `${path}.toolCallId: required`);
      if (update.title !== undefined) {
        assert(typeof update.title === "string", `${path}.title: must be a string`);
      }
      if (update.summary !== undefined) {
        assert(typeof update.summary === "string", `${path}.summary: must be a string`);
      }
      if (update.status !== undefined) {
        assert(["pending", "running", "completed", "failed", "cancelled"].includes(update.status),
          `${path}.status: invalid tool status`);
      }
      if (kind === "tool_result") {
        assert(typeof update.status === "string", `${path}.status: required for tool_result`);
        assert(["completed", "failed", "cancelled"].includes(update.status),
          `${path}.status: invalid tool result status`);
      }
      break;
    case "reasoning_summary":
      assertOnlyKeys(update, UPDATE_KEYS.reasoning, path);
      assert(typeof update.summary === "string" && update.summary.length > 0,
        `${path}.summary: required`);
      break;
    case "approval_request":
      assertOnlyKeys(update, UPDATE_KEYS.approval, path);
      assert(typeof update.requestId === "string" && update.requestId.length > 0,
        `${path}.requestId: required`);
      if (update.title !== undefined) {
        assert(typeof update.title === "string", `${path}.title: must be a string`);
      }
      if (update.summary !== undefined) {
        assert(typeof update.summary === "string", `${path}.summary: must be a string`);
      }
      if (update.options !== undefined) {
        assert(Array.isArray(update.options), `${path}.options: must be an array`);
        update.options.forEach((option, index) => {
          assert(isObject(option), `${path}.options[${index}]: option must be an object`);
          assert(Object.keys(option).every((key) => ["id", "label"].includes(key)),
            `${path}.options[${index}]: unsupported option field`);
          assert(typeof option.id === "string" && typeof option.label === "string",
            `${path}.options[${index}]: id and label are required`);
        });
      }
      break;
    case "usage":
      for (const key of ["inputTokens", "outputTokens", "totalTokens"]) {
        if (update[key] !== undefined) {
          assert(Number.isInteger(update[key]) && update[key] >= 0,
            `${path}.${key}: must be a non-negative integer`);
        }
      }
      break;
    case "subtask":
      assertOnlyKeys(update, UPDATE_KEYS.subtask, path);
      assert(typeof update.subtaskId === "string" && update.subtaskId.length > 0,
        `${path}.subtaskId: required`);
      if (update.title !== undefined) {
        assert(typeof update.title === "string", `${path}.title: must be a string`);
      }
      if (update.summary !== undefined) {
        assert(typeof update.summary === "string", `${path}.summary: must be a string`);
      }
      assert(["pending", "running", "completed", "failed", "cancelled"].includes(update.status),
        `${path}.status: invalid subtask status`);
      break;
    case "artifact":
      assertOnlyKeys(update, UPDATE_KEYS.artifact, path);
      assert(typeof update.artifactId === "string" && update.artifactId.length > 0,
        `${path}.artifactId: required`);
      if (update.sizeBytes !== undefined) {
        assert(Number.isInteger(update.sizeBytes) && update.sizeBytes >= 0,
          `${path}.sizeBytes: must be a non-negative integer`);
      }
      if (update.status !== undefined) {
        assert(["available", "pending", "failed"].includes(update.status),
          `${path}.status: invalid artifact status`);
      }
      break;
    default:
      fail(`${path}: unknown standard update ${kind}`);
  }
}

function assertNotification(notification, path, sessionId, expectedSequence, fixtureLevel) {
  assert(isObject(notification), `${path}: notification must be an object`);
  if (notification.jsonrpc !== undefined) {
    assert(notification.jsonrpc === "2.0", `${path}: jsonrpc must be 2.0 when supplied`);
  }
  assert(notification.id === undefined, `${path}: session updates are notifications, not requests`);
  assert(notification.method === "session/update", `${path}: method must be session/update`);
  const params = notification.params;
  assert(isObject(params), `${path}: params are required`);
  assert(params.sessionId === sessionId, `${path}: cross-session update must be rejected`);
  if (params.sequence !== undefined) {
    assert(Number.isInteger(params.sequence), `${path}: sequence must be an integer`);
    assert(expectedSequence !== undefined, `${path}: sequence cannot follow an unsequenced notification`);
    assert(params.sequence === expectedSequence, `${path}: event sequence must be monotonic`);
  } else {
    assert(expectedSequence === undefined, `${path}: sequence is missing after sequenced notification`);
  }
  assertUpdateShape(params.update, `${path}.params.update`, fixtureLevel);
}

function assertBasicRequests(fixture) {
  assert(Array.isArray(fixture.requests) && fixture.requests.length >= 2,
    `${fixture.name}: fixture needs prompt and cancel requests`);
  const methods = fixture.requests.map((request, index) => {
    assertJsonRpcRequest(request, `${fixture.name}.requests[${index}]`);
    assert(request.params.sessionId === fixture.descriptor.sessionId,
      `${fixture.name}.requests[${index}]: session mismatch`);
    return request.method;
  });
  assert(methods.includes("session/prompt"), `${fixture.name}: prompt request is required`);
  assert(methods.includes("session/cancel"), `${fixture.name}: cancel request is required`);
}

function pollRequestFor(fixture) {
  const poll = fixture.poll ?? fixture.requests.find((request) => request.method === "openreel/session/updates");
  assert(poll, `${fixture.name}: openreel/session/updates request is required`);
  return poll;
}

function assertLongPoll(fixture) {
  const poll = pollRequestFor(fixture);
  assertJsonRpcRequest(poll, `${fixture.name}.poll`);
  assert(poll.method === "openreel/session/updates", `${fixture.name}: poll method mismatch`);
  assert(poll.params.sessionId === fixture.descriptor.sessionId,
    `${fixture.name}: poll session mismatch`);
  if (poll.params.after !== undefined) {
    assert(typeof poll.params.after === "string" || typeof poll.params.after === "number",
      `${fixture.name}: poll after must be an opaque string or number`);
  }
  assert(!("cursor" in poll.params), `${fixture.name}: cursor is returned by the poll, not sent`);
  assert(!("afterSequence" in poll.params), `${fixture.name}: afterSequence is not part of long polling`);
  assert(Number.isInteger(poll.params.waitMs) && poll.params.waitMs >= 0 && poll.params.waitMs <= 120000,
    `${fixture.name}: waitMs must be bounded to 120 seconds`);

  const pollResult = fixture.pollResult;
  assertJsonRpcResponse(pollResult, `${fixture.name}.pollResult`, poll.id);
  const notifications = pollResult.result?.notifications;
  assert(Array.isArray(notifications), `${fixture.name}: poll notifications must be an array`);
  assert(
    (typeof pollResult.result.cursor === "string" && pollResult.result.cursor.length > 0) ||
      (typeof pollResult.result.cursor === "number" && Number.isFinite(pollResult.result.cursor)),
    `${fixture.name}: poll result cursor is required`,
  );
  let expected = notifications[0]?.params?.sequence;
  if (expected !== undefined) {
    assert(Number.isInteger(expected) && expected > 0, `${fixture.name}: poll sequence must start at a positive integer`);
  }
  const types = [];
  for (const [index, notification] of notifications.entries()) {
    assertNotification(
      notification,
      `${fixture.name}.pollResult.notifications[${index}]`,
      fixture.descriptor.sessionId,
      expected,
      fixture.fixtureLevel,
    );
    types.push(notification.params.update.sessionUpdate);
    if (expected !== undefined) expected += 1;
  }
  return { poll, pollResult, notifications, lastSequence: expected === undefined ? 0 : expected - 1, types };
}

function assertObservableEvents(fixture, poll) {
  for (const required of OBSERVABLE_EVENT_TYPES) {
    assert(poll.types.includes(required), `${fixture.name}: missing observable event ${required}`);
  }
  const approval = fixture.approvalResponse;
  assertJsonRpcRequest(approval, `${fixture.name}.approvalResponse`);
  assert(approval.method === "session/approval", `${fixture.name}: approval method mismatch`);
  assert(approval.params.sessionId === fixture.descriptor.sessionId,
    `${fixture.name}: approval session mismatch`);
  assert(typeof approval.params.requestId === "string" && approval.params.requestId.length > 0,
    `${fixture.name}: approval requestId is required`);
  assert(["approved", "denied"].includes(approval.params.decision),
    `${fixture.name}: invalid approval decision`);
  assert(Object.keys(approval.params).every((key) => ["sessionId", "requestId", "decision"].includes(key)),
    `${fixture.name}: approval contains unsupported fields`);
}

async function validateFixture(file) {
  let fixture;
  try {
    fixture = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    fail(`${file}: cannot read valid JSON (${error.message})`);
  }
  assert(isObject(fixture), `${file}: fixture root must be an object`);
  assert(fixture.fixtureVersion === 1, `${file}: fixtureVersion must be 1`);
  assert(["basic", "full"].includes(fixture.fixtureLevel), `${file}: fixtureLevel must be basic or full`);
  assert(typeof fixture.name === "string" && fixture.name.length > 0, `${file}: name is required`);

  const unsafe = [];
  walkForUnsafeFields(fixture, "$", unsafe);
  assert(unsafe.length === 0, unsafe.join("\n"));
  assertDescriptor(fixture);
  assertInitialize(fixture);
  assertResume(fixture);
  assertUnknownExtension(fixture);
  assertBasicRequests(fixture);
  const poll = assertLongPoll(fixture);

  let eventCount = poll.notifications.length;
  if (fixture.fixtureLevel === "full") {
    assertObservableEvents(fixture, poll);
  } else {
    assert(!fixture.approvalResponse, `${fixture.name}: basic fixture must not require approval`);
    assert(poll.types.includes("user_message"), `${fixture.name}: basic fixture needs user_message`);
    assert(poll.types.includes("agent_message"), `${fixture.name}: basic fixture needs formal agent_message`);
    assert(poll.types.includes("state_update"), `${fixture.name}: basic fixture needs state_update`);
    assert(!poll.types.includes("agent_message_chunk"), `${fixture.name}: basic fixture must not stream chunks`);
    assert(poll.types.every((type) => ["user_message", "agent_message", "state_update"].includes(type)),
      `${fixture.name}: basic fixture contains an observable-only event`);
  }

  if (fixture.notifications !== undefined) {
    assert(Array.isArray(fixture.notifications) && fixture.notifications.length > 0,
      `${fixture.name}: notifications must be a non-empty array`);
    let expectedSequence = poll.lastSequence + 1;
    for (const [index, notification] of fixture.notifications.entries()) {
      assertNotification(notification, `${fixture.name}.notifications[${index}]`, fixture.descriptor.sessionId, expectedSequence, fixture.fixtureLevel);
      expectedSequence += 1;
    }
    eventCount += fixture.notifications.length;
  }

  return {
    file,
    level: fixture.fixtureLevel,
    events: eventCount,
  };
}

const files = process.argv.slice(2).map((file) => resolve(process.cwd(), file));
const targets = files.length > 0 ? files : defaultFixtures;
try {
  const results = [];
  for (const file of targets) results.push(await validateFixture(file));
  assert(results.some((result) => result.level === "basic"), "no basic fixture validated");
  assert(results.some((result) => result.level === "full"), "no full fixture validated");
  for (const result of results) {
    console.log(`ok ${result.level}: ${result.file} (${result.events} events checked)`);
  }
} catch (error) {
  console.error(`conversation-adapter conformance failed: ${error.message}`);
  process.exitCode = 1;
}
