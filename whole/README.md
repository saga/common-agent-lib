# Whole: standalone functional modules

`whole/` contains complete, independently buildable features. These modules are deliberately outside the root `packages/*` npm workspace. Their core functionality does not import, link to, or require any other package in this repository.

| Directory | Product | Native build boundary |
|---|---|---|
| [agent-dreaming](./agent-dreaming/README.md) | Full Agent Memory / Dreaming package | npm package; Node.js 24.15+; built-in SQLite |
| [rust-agent](./rust-agent/README.md) | Native Rust Agent Runtime, CLI and MCP server | Cargo crate; pinned Rust toolchain |

## Agent Dreaming

The entire Memory lifecycle is implemented inside `whole/agent-dreaming`: Experience, Evidence, Memory, Knowledge, FTS5/CJK retrieval, task-aware Context, feedback, persistent Memory Manifest, SQLite schema/migrations, scheduling, worker leases and run recovery. No internal `@saga/*` dependency is required. The Copilot SDK is an optional peer adapter; a custom `DreamingRuntime` can be supplied instead.

Run it independently:

```bash
cd whole/agent-dreaming
npm install --workspaces=false
npm run typecheck
npm test
npm run benchmark
npm run build
npm pack --dry-run
```

The published package name remains `@saga/agent-dreaming`; source location in this repository is `whole/agent-dreaming`. Its installation and runtime do not require the root npm workspace.

## Rust Agent

The complete Rust implementation lives in `whole/rust-agent`. It owns the Agent loop, provider integration, session lifecycle, context window, workspace tools, deterministic policy, approval boundary, background tasks, SQLite memory and Dreaming, trace/audit records, CLI and stdio MCP server. It uses external Rust crates declared in its own `Cargo.toml`, but no crate or package from this repository.

Run it independently:

```bash
cd whole/rust-agent
cargo fmt --all
cargo test --all-targets
cargo clippy --all-targets
cargo build --release --bins
```

The `codebuddy-host/` subdirectory is an optional Node.js interoperability example. It is not a dependency of the native Rust runtime, CLI, or MCP server. The default Rust build does not require Node.js, npm, CodeBuddy CLI, or a CodeBuddy login.

## Independence rules

- Do not add either directory to root npm workspaces or make either depend on a sibling `packages/*` entry.
- Keep dependencies, build commands, tests and user-facing usage inside each product directory.
- Optional provider / host adapters may depend on external SDKs, but core functionality must remain usable without them.
- CI validates Agent Dreaming from its own package directory and tests Rust Agent from its Cargo root; it does not rely on the root workspace to build either one.
