# Conversation adapter fixtures

These fixtures are minimal, offline examples for the open protocol in
[`docs/external-agent-conversation-adapter.md`](../../docs/external-agent-conversation-adapter.md):

- `fixtures/basic.json` — an external adapter's `conversation-endpoint.json`
  descriptor, existing-session attach, prompt/cancel, and text/state
  notifications through `openreel/session/updates`;
- `fixtures/full.json` — an observable-level descriptor, `after` replay,
  bounded long
  polling, monotonic event sequences, reasoning summary, tool, approval,
  subtask, and artifact events;
- `adapter-kit.mjs` — dependency-free loopback server and private descriptor
  lifecycle; an external Agent host supplies only session hooks;
- `adapter-kit.test.mjs` — routing, redaction, and safe-cleanup coverage for
  the reference kit;
- `validate.mjs` — dependency-free shape and safety conformance check.

Run the default check from the repository root:

```sh
node scripts/conversation-adapter/validate.mjs
node --test scripts/conversation-adapter/adapter-kit.test.mjs
```

Pass custom fixture paths to validate other examples; a conformance run must
include at least one `basic` fixture and one `full` fixture. The validator is
deliberately network-free: it never reads the real endpoint descriptor, opens
a socket, starts an Agent, or exposes a bearer token. The fixture descriptor
is written by the external adapter and intentionally separate from the MCP
`live-endpoint.json` descriptor; it uses the loopback `/conversation` endpoint.

Minimal host integration:

```js
import { startConversationAdapter } from "./adapter-kit.mjs";

const adapter = await startConversationAdapter({
  sessionId: existingAgentSession.id,
  agent: { name: "My Agent" },
  adapter: { name: "my-openreel-adapter", capabilityLevel: "observable" },
  descriptorPath: "/absolute/path/to/.openreel/conversation-endpoint.json",
  onPrompt: ({ prompt }) => existingAgentSession.prompt(prompt),
  onCancel: () => existingAgentSession.cancel(),
  onApproval: ({ requestId, decision }) =>
    existingAgentSession.resolveApproval(requestId, decision),
  onUpdates: ({ after, waitMs }) =>
    existingAgentSession.pollDisplayUpdates({ after, waitMs }),
});

process.once("SIGTERM", () => void adapter.close());
```

The host owns `existingAgentSession` and its history. The update hook returns
only the safe event vocabulary documented above, never raw reasoning, tool
arguments/results, paths, URLs, provider metadata, or credentials.
