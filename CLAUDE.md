# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What is Hardcopy?

Hardcopy is a local-remote sync system that synchronizes remote resources (GitHub, Jira, Linear, Google Docs, A2A agents, Git) to a local file tree. It uses a graph database (SQLite + optional GraphQLite extension) for relationships and Loro CRDTs for conflict-free merges. Nodes are rendered as files with YAML frontmatter via configurable views.

## Commands

```bash
pnpm build            # Build with tsup (outputs to dist/)
pnpm dev              # Watch mode build
pnpm typecheck        # TypeScript type checking (tsc --noEmit)
pnpm lint             # ESLint
pnpm lint:fix         # ESLint with auto-fix
pnpm format           # Prettier format
```

Testing uses vitest but no test files exist yet.

## Architecture

**Entry points** (all in `src/`, built by tsup):
- `cli.ts` — Commander.js CLI (`hardcopy` binary)
- `index.ts` — Library export
- `mcp-server.ts` — MCP server exposing hardcopy operations as LLM tools

**Core class**: `Hardcopy` in `src/hardcopy/core.ts` is the orchestrator. Operations (sync, push, diff, views) are added via **prototype augmentation** in `src/hardcopy/index.ts`, keeping the core class minimal.

**Provider system** (`src/provider.ts`, `src/providers/`): Plugin architecture with `registerProvider()`/`getProvider()`. Each provider (github, git, a2a) implements `fetch()`, `push()`, `fetchNode()`, and `getTools()`. Providers define their own node and edge types.

**Format handlers** (`src/format.ts`, `src/formats/`): Pluggable renderers that convert nodes to/from files with YAML frontmatter. Registered via `registerFormat()`. Templates use `{{attrs.field}}` substitution in render paths.

**Conflict resolution pipeline** (`src/conflict.ts`, `src/merge.ts`, `src/llm-merge.ts`):
1. Three-way detection (base from DB cache / local from filesystem / remote from provider)
2. Try diff3 auto-merge
3. Fall back to LLM merge (OpenAI-compatible endpoint)
4. Write conflict markers if both fail; block push until resolved

**CRDT store** (`src/crdt.ts`): Per-node Loro CRDT documents stored as `.loro` binary snapshots in `.hardcopy/crdt/`. Each node has independent conflict resolution.

**Database** (`src/db.ts`): better-sqlite3 with LibSQL wrapper. Schema has `hc_nodes` (id, type, attrs JSON, synced_at, version_token, cursor) and `hc_edges` (type, from_id, to_id, attrs JSON). Optional GraphQLite extension for graph queries in views.

**Configuration** (`src/config.ts`): Loaded from `hardcopy.yaml`. Defines sources (provider configs), views (graph queries + render templates), and cross-provider links.

## Data storage

All local state lives in `.hardcopy/` (db.sqlite, crdt/ snapshots, conflicts/, .env overrides).

## Environment variables

- `GITHUB_TOKEN` — Required for GitHub provider
- `OPENAI_BASE_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL` — For LLM merge fallback
- `HARDCOPY_ME` / `GITHUB_USER` — User identity for view queries

## Tech stack

TypeScript 5.7 (strict, ES2022, ESM-only), Node.js 20+, pnpm, tsup, vitest, Commander.js, better-sqlite3, Loro CRDT, gray-matter.
