# Patchwork + Hardcopy + Apprentice Architecture Overview

## Architecture Overview

| Repo           | Responsibility                                                     |
| -------------- | ------------------------------------------------------------------ |
| **Apprentice** | Graph, events, orchestrator, search, indexing                      |
| **Patchwork**  | Service registry, skills, chat UI, integration proof-of-concept    |
| **Hardcopy**   | Sync engine: diff/push/pull between remote APIs and local variants |

### Design Principles

- **Single DB**: All modules share one SQLite database
- **Skills-first**: No built-in 3rd party integrations—skills are the primary extension point
- **No `utcp`**: Remove abstraction layer; services expose MCP or HTTP directly
- **No `@core`**: Use Patchwork's existing package structure
- **Strong isolation**: Each module exposes clean interfaces with minimal coupling

---

## Current State Summary

### Apprentice (Knowledge Base)

- Events: flat records with metadata, relations to assets
- Assets: indexed files with content dedup, versioning (e.g. Git)
- Search: FTS + vector (hybrid), temporal/grouped related context
- MCP tools: `search`, `get_asset`, `run_asset`, `context_list`, `log_event`
- **Missing**: Entity graph, orchestrator, skill execution

### Patchwork (Service Platform)

- Events: `@patchwork/events` with pub/sub, filters, dead-letter
- Graph: `@patchwork/graph` with entities, links, views
- Skills: `@patchwork/skills` with SKILL.md, triggers, registry
- Services: `@patchwork/services` with MCP/HTTP/gRPC backends
- Orchestrator: `@patchwork/orchestrator` with session management
- **Missing**: Proper wiring, notifiers, concurrency

### Hardcopy (Sync Engine)

- Provider interface: `fetch`/`push` with Node/Change abstractions
- Graph: entity graph with URI, links, views
- Events: pub/sub with webhook inferrers
- Contrib: `ProviderContrib` pattern (GitHub, Jira, Stripe)
- **Strength**: Diff/merge logic, format handlers, sync primitives

---

## Target Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                           PATCHWORK (apps/chat)                              │
│  Chat UI → Stitchery → Services → Skills → Orchestrator                     │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
         ┌──────────────────────────┼──────────────────────────┐
         │                          │                          │
         ▼                          ▼                          ▼
┌─────────────────┐      ┌─────────────────┐      ┌─────────────────┐
│   APPRENTICE    │      │   PATCHWORK     │      │    HARDCOPY     │
│                 │      │                 │      │                 │
│ - EntityGraph   │      │ - ServiceReg    │      │ - SyncEngine    │
│ - EventBus      │      │ - SkillRegistry │      │ - DiffMerge     │
│ - Orchestrator  │      │ - Stitchery     │      │ - FormatHandler │
│ - Search        │      │ - Chat UI       │      │ - ProviderAdapt │
│ - Indexer       │      │                 │      │                 │
└─────────────────┘      └─────────────────┘      └─────────────────┘
```

---

## Integration Test: apps/chat Flow

### Test Scenario

User mentions a GitHub issue in chat. System fetches issue, responds with context, and can push changes back.

### Flow

```
1. User sends message: "What's the status of github:owner/repo#42?"
   │
   ▼
2. Chat publishes event
   eventBus.publish({
     type: 'chat.message.sent',
     source: 'chat:user',
     subject: 'github:owner/repo#42',
     data: { content: "What's the status..." }
   })
   │
   ▼
3. Orchestrator receives event, finds matching skill
   skillRegistry.findByTrigger(envelope) → [github-assistant skill]
   │
   ▼
4. Skill executes with context
   - entityGraph.get('github:owner/repo#42') → null (not cached)
   - serviceRegistry.call('hardcopy', 'fetch', { uri: 'github:owner/repo#42' })
   │
   ▼
5. Hardcopy fetch delegates to GitHub skill
   - GitHub skill makes API call
   - Returns Entity with issue data
   │
   ▼
6. Entity stored in graph
   entityGraph.upsert({
     uri: 'github:owner/repo#42',
     type: 'github.Issue',
     attrs: { title: '...', body: '...', state: 'open' }
   })
   │
   ▼
7. Skill generates response
   LLM receives: entity context + user message
   LLM responds: "Issue #42 is open. Title: ..."
   │
   ▼
8. Response published
   eventBus.publish({
     type: 'llm.{sessionId}.complete',
     source: 'chat:assistant',
     data: { content: "Issue #42 is open..." }
   })
   │
   ▼
9. Chat UI displays response
```

---

## Related Specs

- [Apprentice Refactor](./apprentice-refactor.md) - Plan A: Graph, events, orchestrator
- [Patchwork Refactor](./patchwork-refactor.md) - Plan B: Services, skills, chat UI
- [Hardcopy Refactor](./hardcopy-refactor.md) - Plan C: Sync engine
