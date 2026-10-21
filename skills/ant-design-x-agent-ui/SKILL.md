---
name: ant-design-x-agent-ui
description: Build or review React agent chat surfaces using Ant Design and Ant Design X while keeping streaming state separate from business execution state.
---

# Ant Design X Agent UI

Use this Skill when building or revising a React-based AI chat / Agent interface in a repository that uses antd and/or @ant-design/x.

## Before editing

1. Read the project's package.json and lockfile. Follow its actual antd and @ant-design/x versions; do not assume an API from a different major version.
2. Find the existing app providers and chat components before adding new wrappers.
3. Keep the app-specific domain UI (diagram canvas, reader, editor, data table) in its own domain components. Ant Design X is the conversation surface, not a replacement for the product UI.

## Component boundaries

- Use antd for forms, layout, tables, modal/drawer flows, configuration, theme tokens, notifications and shared application context.
- Use @ant-design/x components such as Bubble, Sender, Prompts and conversation-related primitives for chat interaction.
- Keep ConfigProvider/locales, XProvider and antd App context wired consistently at the application boundary, rather than reinitializing them in every chat component.
- Reuse a single message renderer for ordinary chat, attachments, citations and supported rich content where practical. Keep file preview / source components separate from the message composer.
- When rendering Markdown or code, use the renderer and custom component mapping supported by the installed packages. Validate Mermaid or other executable-looking content before passing it to a renderer. Do not treat model-generated markup as trusted HTML.

## Streaming and status semantics

Keep these states separate:
- Message state: queued, streaming, final, failed, cancelled.
- Tool state: requested, running, completed, failed.
- Business execution state: accepted, running, waiting for input/approval, succeeded, failed, cancelled.
- Domain state: the validated authoritative object held by the application.

Streaming text is not proof of task completion. A UI spinner stopping is not proof that an external action succeeded. The server's durable execution/event state remains authoritative.

Keep message IDs stable while deltas arrive; append incremental text rather than repeatedly replacing prior chunks. On final events, reconcile with the authoritative response. Show partial output and failure state distinctly so a reconnect does not silently turn an incomplete answer into a completed one.

Do not fail a whole request solely because the model did not call a tool. A normal textual response, a tool-backed mutation and a no-op response are different outcomes and should be modeled explicitly.

## Structured tool actions

- The Agent should call a narrow domain operation, not mutate internal React state, DOM nodes or a canvas graph directly.
- Validate the tool input against a runtime schema on the server, check domain invariants, apply the change to the canonical model, then return the updated model or an explicit validation error.
- Treat the UI view as a projection of the canonical domain state.
- Make errors actionable without exposing credentials, full prompts or internal environment details.

## Regression cases

Cover at least:
- Initial assistant response with no tool call.
- Streaming deltas followed by a final message.
- Empty response and explicit provider error.
- Tool call success, validation failure and partial/no-op mutation.
- Disconnect or cancellation while streaming.
- Attachment or citation rendering and malformed rich content.
- Responsive layout for narrow screens if the interface supports mobile.

## Repository examples

- ai-interview-questions: CopilotSidebar combines Bubble, Sender, Prompts with antd controls.
- architecture-diagram-studio/v2: antd handles application controls while the diagram canvas stays domain-specific.

Do not create a shared npm UI package merely to wrap a handful of Ant Design X components unless multiple applications have the same stable behavior and data contract, not just similar JSX.
