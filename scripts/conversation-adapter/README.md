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
- `codex-app-server-client.mjs` — bounded JSONL client for Codex App Server;
- `codex-adapter.mjs` — production Codex provider adapter and CLI;
- `codex-adapter.test.mjs` — safe projection, cancellation, and approval tests;
- `validate.mjs` — dependency-free shape and safety conformance check.

Run the default check from the repository root:

```sh
node scripts/conversation-adapter/validate.mjs
pnpm test:adapters
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
  onWorkMode: ({ clientContext }) =>
    existingAgentSession.updateWorkMode(clientContext),
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

## Codex

The Codex reference adapter uses the local signed-in Codex CLI and its official
[App Server](https://developers.openai.com/codex/app-server/) protocol. It
creates or resumes a Codex-owned thread, injects the built ReelTerminal live
MCP connector using Codex's documented
[MCP configuration](https://developers.openai.com/codex/mcp/), and serves the
provider-neutral ReelTerminal conversation protocol.

First build the connector, open a desktop project, and enable **Agent Session**:

```sh
pnpm --filter @openreel/desktop build:main
node scripts/conversation-adapter/codex-adapter.mjs \
  --new-thread \
  --cwd /absolute/path/to/agent-video-engine-lab
```

Use `--thread-id <id>` instead to resume an existing Codex thread. The adapter
prints only safe readiness metadata. It atomically publishes the private
conversation descriptor, removes it on exit, and never prints either endpoint
token. ReelTerminal attaches through **Connect external Agent**.

Agent Session enablement is the coarse-grained authorization for the dedicated
`openreel_live` MCP server, which the adapter marks approved using Codex's
[configuration policy](https://developers.openai.com/codex/config-reference/).
The ReelTerminal facade still enforces its access level, work-mode context,
single-writer lease, revision checks, and shared undo. Codex command and file
changes remain explicit approval events.

Each GUI prompt also supplies a visual-state packet. Codex receives a full
960×540 keyframe on the first turn, a compact atlas of aligned changed regions for later visual
changes, or only revision/selection/playhead metadata when pixels are unchanged.
The adapter accepts image paths only under the desktop's private visual-state
root, verifies their digest, and never exposes those paths in display events.
Set `OPENREEL_CONVERSATION_VISUAL_STATE_ROOT` (or `--visual-state-root`) only
when the desktop and adapter intentionally share a non-default runtime
directory, such as an isolated E2E run.

The real acceptance spec is opt-in because it launches Electron and consumes a
live model turn from the signed-in Codex account:

```sh
pnpm --filter @openreel/desktop build
OPENREEL_REAL_CODEX_E2E=1 \
  pnpm --filter @openreel/desktop exec vitest run \
  --config e2e/vitest.config.ts e2e/codex-conversation.e2e.ts
```
