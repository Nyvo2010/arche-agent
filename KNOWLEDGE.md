# Arche Agent — Project Knowledge

> **Single source of truth.** This doc must stay up to date and contain all knowledge
> and decisions related to the project. Update it on every significant decision,
> architecture change, or scope change. See `AGENTS.md` (which points here).

## 1. What Arche Is

Server-owned coding agent backend built **on top of Pi** (`https://github.com/earendil-works/pi`).

- Backend owns: agent loop, session state, routing, tools, permissions, streaming.
- Clients are thin: HTTP/SSE or ACP.
- Differentiators vs plain Pi:
  1. Smart Context Engine (SCE)
  2. Context Optimization Engine (COE)
  3. Model Router (tiered + escalation)
  4. Tool Registry + MCP / LSP
  5. Permission / HITL gates
  6. Session Layer + Event Bus

Data flow:
`Prompt → Session → Agent Loop builds prompt with SCE context + COE budget → Model Router picks model → LLM streams → Tools execute with permission gates → Events streamed → State persisted.`

## 2. Pi Base — What We Reuse

Pi is TypeScript monorepo (npm workspaces, `npm install --ignore-scripts`, `npm run build`, `npm run check`, `./test.sh`).

Packages:
- `@earendil-works/pi-ai` (`packages/ai`): unified multi-provider LLM API (Anthropic, OpenAI, Gemini, etc.). Model catalog refresh, `createModels()`, `streamSimple`.
- `@earendil-works/pi-agent-core` (`packages/agent`): `Agent` class + `agentLoop` / `agentLoopContinue`. Key hooks we will use:
  - `transformContext(messages, signal)` — pruning / compaction / SCE+COE injection point.
  - `convertToLlm(messages)` — filter custom message types.
  - `beforeToolCall` (block + `terminate:true` supported), `afterToolCall` (override + `terminate:true`).
  - `shouldStopAfterTurn` — graceful stop / compaction hook.
  - `steeringMode` / `followUpMode` (`one-at-a-time` | `all`), steer/followUp queues.
  - `toolExecution`: `parallel` (default) vs `sequential`; per-tool `executionMode` override.
  - Events: `agent_start/end`, `turn_start/end`, `message_start/update/end`, `tool_execution_start/update/end`. `Agent.subscribe()` listeners awaited in order.
  - Session backends: SQLite backend lives in separate package `@earendil-works/pi-session-backend-sqlite-node`.
- `@earendil-works/pi-coding-agent` (`packages/coding-agent`): CLI (interactive, `-p` print, `--mode json`, `--mode rpc` JSONL over stdin/stdout), SDK (`createAgentSession`), sessions as JSONL tree (`id` + `parentId`, branching via `/tree`, `/fork`, `/clone`), extensions / skills / prompts / themes / pi-packages.
- `@earendil-works/pi-tui`, `@earendil-works/chord` (facet services, transport-neutral), `@earendil-works/pi-telemetry`.
- Built-in tools: `read`, `bash`, `powershell` (Windows), `edit`, `write`, `grep`, `find`, `ls`.

Pi philosophy (important tension):
- Core stays minimal. No MCP, no sub-agents, no permission popups, no plan mode, no built-in todos — all via extensions.
- No built-in permission system; runs with user permissions. Sandboxing via Gondolin / Docker / OpenShell.
- Arche explicitly **adds back**: MCP/LSP, Permission/HITL, SCE/COE, Model Router, server-owned sessions. So Arche is a server wrapper + engines around `pi-agent-core` + `pi-ai`, not a Pi extension alone.

## 3. Arche Engines

### 3.1 SCE — Smart Context Engine
- Query = user request + last assistant reply, camelCase/snake_case split.
- Case-insensitive grep across workspace, excludes `node_modules/.git`.
- Light BM25 ranking of matches/files.
- Token-budgeted snippets, limited file count, top files expanded.
- Fallback to entry files + user `importantFiles` when grep empty.
- 30s cache, bypass on mutation. Slice injected into system prompt.

### 3.2 COE — Context Optimization Engine
- Keeps total request within `maxContextTokens` for small/cheap models.
- Budget: 70% of model context window by default.
- Order when over budget: dedupe tool calls → truncate messages → optional semantic compression → drop oldest message groups.
- Preserves system message + last 2 messages. Drops assistant+tool groups together.
- Budget accounts for SCE slice + system + tool schemas before optimizing history.

### 3.3 Model Router
- Tiers: `trivial → standard → complex → escalate`. Escalates on tool failures.
- Per-session fixed model or `auto`.
- Per-session cost/token tracking.

### 3.4 Tool Registry + MCP / LSP
- File tools, bash with workspace confinement, `web_fetch` with SSRF protection.
- Parallel-safe: reads parallel, writes/bash serial.
- MCP: connect/disconnect servers, tools first-class.
- LSP for symbol search, usages, type info without loading whole repo.

## 4. Target Architecture (confirmed direction 2026-09-15)

- Stack: TypeScript/Node (match Pi). Edit Pi fork directly; build around `packages/agent` loop.
- Pi already has: `packages/server` (Server + SessionRouter, chord-based), `packages/protocol`, `packages/client`, `packages/coding-agent/src/core/event-bus.ts`, `packages/session-backends/sqlite-node`, compaction, JSONL sessions. Reuse all; do not greenfield a server.
- Arche = Pi fork + edits: SCE, COE, Router, Permission/HITL, MCP, LSP, task lists, subagents, new interface. Pi code now lives at repo root (merged). Changes are made directly in Pi packages; product feels cohesive.
- Transports: keep Pi's existing modes (interactive, `-p`, `--mode json`, `--mode rpc`, SDK) working first; server-owned HTTP/SSE + ACP on top of `packages/server` next.
- Sessions: same as Pi (JSONL tree + SQLite backend). No Postgres for now.

## 5. Repo / Fork Strategy

Fork done 2026-09-15:
- Upstream: `https://github.com/earendil-works/pi`
- Fork: `https://github.com/Nyvo2010/pi`
- Pi code is now at repo root (2026-09-15 merge). No submodule.
- This repo (`arche-agent`) is the Pi fork with Arche additions. We keep Pi base intact and add engines minimally.

Current state: `git init` done in `/arche-agent` (branch `main`, no commits yet). Pi code now at root. Pending publish to GitHub.

## 6. Open Questions (resolved 2026-09-15)

- Router tiers user-configurable (no hardcoded providers).
- Permission/HITL: approval gates (prompt before writes/bash).
- MCP/LSP: minimal — generic MCP client + TS language server first.
- New interface: TUI first (restyle/extend Pi TUI).
- Task lists + subagents: built-in to agent-core loop (diverges from Pi philosophy — intentional).

## 7. Decisions Log

- 2026-09-15: Repo initialized (`git init`, `main`). Pi researched (packages, Agent hooks, philosophy tension). This doc created as SSOT. `AGENTS.md` updated to point here.
- 2026-09-15 (D1 user answers round 1): TS/Node, edit Pi fork directly around agent loop + new interface; keep `./pi` submodule; keep existing Pi transports working first; sessions same as Pi (JSONL + SQLite); plan first, then add SCE/COE/router/LSP/task-lists/subagents/MCP.
- 2026-09-15: Discovered Pi already ships `packages/server`, `packages/protocol`, `packages/client`, `event-bus.ts`, `session-backends/sqlite-node`. Plan builds on those (see §4).
- 2026-09-15 (D2 user answers round 2): Router tiers user-configurable via config; approval-gate permissions; minimal MCP (generic client) + TS LSP first; TUI-first new interface; task lists + subagents built-in.
- 2026-09-15: Pi code moved to repo root (merged from `Nyvo2010/pi`). Submodule removed. `QUICK-SPECS.md` removed; all knowledge consolidated in this doc.
- 2026-09-15: Note — repo root now contains Pi AGENTS.md dev rules. Arche edits must follow them (no `any`, erasable TS, `npm run check`, etc.).

## 8. Glossary / Files

- `AGENTS.md` — Pi development rules + pointer to this doc.
- This file (`KNOWLEDGE.md`) — SSOT, keep current.
