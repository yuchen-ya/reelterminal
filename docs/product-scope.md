# Product scope — the last stop for AI video

> **ReelTerminal, where AI video becomes a finished film.**

ReelTerminal is an agent-native video finishing editor. Code-generation skills,
ComfyUI, model APIs, and other creation systems can produce animation, video,
images, audio, and text. ReelTerminal owns the missing last mile: assembling those
inputs into one reviewable timeline and exporting a finished film.

## Product boundary

ReelTerminal owns:

- the canonical project, timeline, media inventory, editor context, revisions,
  undo/redo history, preview, verification, and export;
- direct human editing through the GUI;
- a protocol-neutral Command API and CLI through which an external agent can inspect and
  edit the same project;
- stable human-readable Agent references such as `@A1`, `@A2`, and `@A3` that map
  to real editor entities;
- first-class English and Simplified Chinese product UI.

ReelTerminal does **not** own:

- an embedded LLM or embedded agent;
- model/provider selection, provider API keys, or a tool-use inference loop;
- Agent installation/login, conversation creation/listing/resumption, prompt
  forwarding, history, summarization, context compression, or identity;
- generation features that are better supplied by the user's agent, a skill,
  ComfyUI, or another dedicated creation service.

Specialized finishing algorithms—such as transcription, subject masking, or
beat analysis—may remain editor tools when they directly help finish supplied
material. They do not create a ReelTerminal-owned Agent, conversation, provider
picker, or competing authority.

## Equal authority, different paths

The human and the agent use different interfaces but land on the same project
actions:

```text
human GUI ──────────────┐
                       ├─ canonical project/actions ─ preview/export
Agent via reelctl / MCP adapter ─┘
```

Both paths share revision checks, conflict behavior, one undo history, and one
artifact world. The application must never maintain an agent-only shadow
project. The human never loses the ability to edit.

## Conversation ownership

Agents use their native conversation interface. ReelTerminal neither renders
that conversation nor starts/configures the Agent. The default entry point is
`reelctl`; MCP clients explicitly start `reelctl mcp serve`. The desktop Command
API is independent of both transports. Editor context is data the Agent reads
on demand and is unrelated to LLM context management.

## Agent references

Users may mark selected media or timeline entities for the agent. Marks receive
monotonic session-local numbers (`@A1`, `@A2`, ...), are visibly badged in the
editor, and are exposed by `editor.get_context`. Numbers are never rebound or
renumbered: a deleted entity leaves a stale reference so an earlier message can
never resolve to a different object.

References are ephemeral collaboration context. They are not project content,
conversation history, or undoable edits.

## Retention rule

Keep a feature in the native product only when it directly helps turn existing
inputs into a finished film, or is required to make that finishing workflow
safe and observable. Otherwise remove the complete vertical slice (UI, state,
runtime, dependencies, tests, settings, and documentation) or move it behind an
external skill/plugin boundary. Hiding an unused path is not sufficient.

### Current cleanup boundary

The first cleanup pass is intentionally vertical rather than cosmetic:

| Keep | Remove |
|---|---|
| Live facade and generated command catalog | Legacy desktop MCP registry and its 304-tool endpoint |
| Agent Access, authorization, task cancellation, and editor activity | Embedded OpenAI/Anthropic clients, inference loop, system prompt, token accounting, and local chat history |
| Timeline, media import, effects, transitions, titles, audio alignment, preview, verification, and export | Provider/model pickers, LLM API-key settings, auto-confirm/dry-run settings that apply only to the embedded agent |
| Agent-owned native conversations | In-app chat, onboarding, conversation adapters, prompt forwarding and collaboration modes |

This table is an architectural gate: a future change that reintroduces a
removed responsibility needs an explicit product-scope decision, not merely a
new UI control.
