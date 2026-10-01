# @saga/agent-contracts

Provider-neutral contracts for server-side AI agent applications.

## Purpose

This package defines stable boundaries that recur across Copilot, LangChain, OpenAI Agents, Anthropic-style agents, and application-specific runtimes.

It intentionally does **not** provide an agent runtime, policy engine, approval service, tool registry, command executor, persistence layer, or business audit system.

## Contracts

- Agent definition and session reference
- Tool definition and tool provider
- Knowledge retrieval request/result and knowledge provider
- Just-in-time context references
- Interrupt and interrupt result
- Approval request/decision
- Policy request/decision
- Business command/result
- Evidence/provenance
- Agent event

Schemas are Zod-based so applications can validate data at runtime while TypeScript types provide compile-time contracts.

## Boundary rule

```text
Common contracts
       |
       +---- Copilot runtime
       +---- LangChain runtime
       +---- OpenAI Agents runtime
       +---- Anthropic-style runtime
       +---- Application services
```

The contract describes **what crosses a boundary**, not **how the runtime implements it**.

In particular:

- `PolicyDecision` is a contract; policy evaluation is application-owned.
- `ApprovalDecision` is a contract; authorization is application-owned.
- `AgentCommand` is a contract; execution is application-owned.
- `AgentEvent` is an interoperability event; regulatory/business audit remains application-owned.
- `ToolProvider` is a provider interface; there is no common tool registry.
- `KnowledgeProvider` is a retrieval interface; storage and ranking remain provider-specific.
