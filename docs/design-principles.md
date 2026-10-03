# Design principles

ReelTerminal turns generated media into a reviewed, editable, and exportable
project.

## One project, two interfaces

People edit in the GUI. External Agents use the Command API and CLI. Both act on
the same project, revision boundary, undo history, preview, and export pipeline.

## Keep Agent ownership external

Agents manage their own installation, identity, provider credentials,
conversations, and context. ReelTerminal provides project state, editor tools,
and guarded commands.

## Keep references ephemeral

Editor references such as `@A1` point to current entities for collaboration.
They are session-local context, not saved project content or undoable edits.

## Report real capabilities

Capabilities reflect the active session and available providers. Operations
that cannot run must return a clear unavailable result. Revision conflicts and
access limits remain visible to the caller.

## Finish the supplied material

Native features should help import, assemble, inspect, edit, or deliver user
media. Generation remains the responsibility of external tools and Agents.
