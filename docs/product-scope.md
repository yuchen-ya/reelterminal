# Product scope

ReelTerminal is a video finishing editor for material created by people,
Agents, skills, and other tools. It provides one project for arranging,
reviewing, editing, and exporting that material.

## Product boundary

ReelTerminal owns the project, timeline, media inventory, editor context,
revision checks, undo and redo, preview, verification, and export. People use
the GUI; external Agents use the Command API, CLI, or explicit MCP adapter.
Both operate on the same project and actions.

Agents own their installation, authentication, model providers, credentials,
conversations, and context. ReelTerminal does not provide a conversational
Agent or generate media on the Agent's behalf. Generated media can be imported
and finished in the editor.

## Feature scope

Keep a native feature when it helps import, assemble, inspect, edit, review,
verify, or deliver supplied media, or when it makes those operations safe and
observable. Generation and unrelated creation workflows belong in external
tools unless they directly support finishing.

## Shared authority

GUI and Agent actions use the canonical project and revision checks. Write
access is explicit, conflicts are reported, and Agent batches use the shared
undo history. Editor references are temporary context that point to real
project entities; they are not project content.
