# Patchwork + Hardcopy + Apprentice Consolidation Plan

## Architecture Overview

| Repo | Responsibility |
|------|----------------|
| **Apprentice** | Graph, events, orchestrator, search, indexing |
| **Patchwork** | Service registry, skills, chat UI, integration proof-of-concept |
| **Hardcopy** | Sync engine: diff/push/pull between remote APIs and local variants |

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

# Plan A: Apprentice Refactor

## Goal

Become the core runtime for graph, events, and orchestration. Other packages depend on Apprentice for these primitives.

## Phase A1: Add EntityGraph

Port graph abstraction from Patchwork, integrate with existing asset/event tables.

```typescript
interface Entity {
  uri: string;
  type: string;
  attrs: Record<string, unknown>;
  version?: string;
  syncedAt?: string;
}

interface EntityLink {
  type: string;
  targetUri: string;
  attrs?: Record<string, unknown>;
}

interface EntityGraph {
  upsert(entity: Entity): Promise<void>;
  get(uri: string, version?: string): Promise<Entity | null>;
  delete(uri: string): Promise<void>;
  link(from: string, to: string, type: string, attrs?: Record<string, unknown>): Promise<void>;
  unlink(from: string, to: string, type: string): Promise<void>;
  traverse(uri: string, depth?: number): Promise<Entity[]>;
  query(filter: EntityFilter): Promise<Entity[]>;
}
```

**Changes:**
- Add `entities` and `entity_links` tables to existing DB schema
- Merge `assets` as entities with `file:` URI scheme
- Merge `events` as entities with `event:` URI scheme
- URI utilities: `parseUri`, `formatUri`, `normalizeUri`

## Phase A2: Upgrade EventBus

Upgrade from flat event insertion to full pub/sub with filters.

```typescript
interface EventBus {
  publish(envelope: Envelope): Promise<void>;
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
  stream(filter: EventFilter): AsyncIterable<Envelope>;
  query(filter: EventFilter, options?: QueryOptions): Promise<Envelope[]>;
}

interface Envelope {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  subject?: string;
  data: unknown;
  metadata: Record<string, unknown>;
}
```

**Changes:**
- Refactor `events` table to match `Envelope` schema
- Add in-memory subscription registry
- Add filter matching (types, sources, subjects with wildcards)
- Integrate with EntityGraph (events create/update entities)

## Phase A3: Add Orchestrator

Port orchestrator from Patchwork with Hardcopy's concurrency and notifier patterns.

```typescript
interface Orchestrator {
  start(): void;
  stop(): void;
  onEvent(envelope: Envelope): Promise<void>;
}

interface Session {
  id: string;
  skillId: string;
  status: 'pending' | 'running' | 'complete' | 'failed' | 'cancelled';
  startedAt: string;
  completedAt?: string;
  events: Envelope[];
  result?: unknown;
  error?: string;
}

interface SessionManager {
  create(config: SessionConfig): Promise<Session>;
  get(sessionId: string): Promise<Session | null>;
  cancel(sessionId: string): Promise<void>;
  list(filter?: SessionFilter): Promise<Session[]>;
}
```

**Changes:**
- Add `sessions` table
- Implement event routing: subscribe `{ types: ["*"] }`, filter internal events
- Add concurrency control (`maxConcurrent` with queue)
- Add pluggable `ExternalNotifier` interface (no built-in implementations)

## Phase A4: Export Package

Export clean interfaces for Patchwork/Hardcopy to consume.

```typescript
// @aprovan/apprentice
export { EntityGraph, Entity, EntityLink, EntityFilter } from './graph';
export { EventBus, Envelope, EventFilter, Subscription } from './events';
export { Orchestrator, Session, SessionManager } from './orchestrator';
export { SearchEngine, SearchResult } from './search';
export { createApprentice, ApprenticeConfig } from './index';
```

---

# Plan B: Patchwork Refactor

## Goal

Manage service registry, skills, and provide the chat UI for integration testing. Depend on Apprentice for graph/events/orchestrator.

## Phase B1: Remove Duplicated Modules

Delete packages that move to Apprentice:
- `packages/events/` → use `@aprovan/apprentice`
- `packages/graph/` → use `@aprovan/apprentice`
- `packages/orchestrator/` → use `@aprovan/apprentice`

Keep:
- `packages/services/` (service registry)
- `packages/skills/` (skill registry, scanner)
- `packages/stitchery/` (server, chat integration)

## Phase B2: Simplify ServiceRegistry

Remove `utcp` source type. Services are MCP or HTTP.

```typescript
interface ServiceSource {
  type: 'mcp' | 'http' | 'local';
  config: McpConfig | HttpConfig | LocalConfig;
}

interface McpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: AuthConfig;
}

interface LocalConfig {
  handler: string;
}
```

**Changes:**
- Remove `utcp` source type and related code
- Remove `grpc` (not implemented)
- Simplify to MCP spawn + HTTP fetch + local function
- Keep caching with TTL and event-based invalidation

## Phase B3: Refactor SkillRegistry

Skills become the primary 3rd party integration point. Remove all hardcoded provider logic.

```typescript
interface SkillDefinition {
  id: string;
  uri: string;
  name: string;
  description: string;
  instructions: string;
  triggers: SkillTrigger[];
  tools: string[];
  model?: ModelPreference;
  dependencies?: string[];
}

interface SkillRegistry {
  register(skill: SkillDefinition): Promise<void>;
  unregister(skillId: string): Promise<void>;
  get(skillId: string): Promise<SkillDefinition | null>;
  list(): Promise<SkillSummary[]>;
  findByTrigger(envelope: Envelope): Promise<SkillDefinition[]>;
}
```

**Changes:**
- Remove `SkillExecutor` from registry—execution delegated to Apprentice's Orchestrator
- Registry is purely for discovery and trigger matching
- Skills reference services by namespace (resolved at execution time)

## Phase B4: Wire Stitchery to Apprentice

Update `unified.ts` to use Apprentice as the runtime.

```typescript
import { createApprentice } from '@aprovan/apprentice';
import { ServiceRegistry } from '@patchwork/services';
import { SkillRegistry, scanSkills } from '@patchwork/skills';

interface StitcheryConfig {
  dataDir: string;
  skillsDir?: string;
}

async function createStitcheryContext(config: StitcheryConfig) {
  const apprentice = await createApprentice({
    dbPath: `${config.dataDir}/patchwork.db`,
  });

  const serviceRegistry = new ServiceRegistry({
    db: apprentice.db,
    eventBus: apprentice.eventBus,
  });

  const skillRegistry = new SkillRegistry({
    db: apprentice.db,
    entityGraph: apprentice.entityGraph,
    eventBus: apprentice.eventBus,
  });

  if (config.skillsDir) {
    const skills = await scanSkills({ basePath: config.skillsDir });
    for (const skill of skills) {
      await skillRegistry.register(skill);
    }
  }

  apprentice.orchestrator.setSkillResolver((envelope) => 
    skillRegistry.findByTrigger(envelope)
  );

  apprentice.orchestrator.setToolExecutor((namespace, procedure, args) =>
    serviceRegistry.call(namespace, procedure, args)
  );

  return { apprentice, serviceRegistry, skillRegistry };
}
```

## Phase B5: Update apps/chat

Wire chat to use the integrated system.

**Changes:**
- Chat messages → `eventBus.publish()` as `chat.message.sent`
- LLM responses → `eventBus.publish()` as `llm.{sessionId}.chunk`
- Tool calls → `serviceRegistry.call()`
- Entity references in messages → `entityGraph.get()` + `traverse()`

---

# Plan C: Hardcopy Refactor

## Goal

Become the sync engine for bidirectional data flow between remote APIs and local state. Depend on Apprentice for graph/events.

## Phase C1: Remove Duplicated Modules

Delete modules that move to Apprentice:
- `src/events/` → use `@aprovan/apprentice`
- `src/graph/` → use `@aprovan/apprentice`
- `src/orchestrator/` → use `@aprovan/apprentice`
- `src/services/` → use `@patchwork/services`
- `src/skills/` → use `@patchwork/skills`

Keep and refactor:
- `src/hardcopy/` (diff, push, views)
- `src/contrib/` → convert to skills
- `src/provider.ts` → simplify to sync adapter

## Phase C2: Simplify Provider to SyncAdapter

Replace `Provider` + `ProviderContrib` with minimal `SyncAdapter`.

```typescript
interface SyncAdapter {
  name: string;
  
  fetch(uri: string): Promise<SyncResult>;
  push(uri: string, changes: Change[]): Promise<PushResult>;
  
  canHandle(uri: string): boolean;
}

interface SyncResult {
  entity: Entity;
  raw: unknown;
  etag?: string;
}

interface Change {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface PushResult {
  success: boolean;
  entity?: Entity;
  error?: string;
}
```

**Changes:**
- Remove `nodeTypes`, `edgeTypes`, `streams`, `subscribe`, `query` from Provider
- SyncAdapter only handles fetch/push for a URI scheme
- No registration—adapters discovered via skills

## Phase C3: Convert Contribs to Skills

Each provider becomes a skill that registers a SyncAdapter.

**Before (contrib):**
```typescript
export function getGitHubContrib(): ProviderContrib {
  return {
    name: "github",
    createProvider: () => createGitHubProvider(),
    linkExtractors: [githubLinkExtractor],
    formatHandlers: [githubIssueFormat],
    webhookInferrers: [githubWebhookInferrer],
  };
}
```

**After (skill):**
```yaml
# skills/github-sync/SKILL.md
---
name: GitHub Sync
description: Sync GitHub issues and PRs with local state
triggers:
  - eventFilter:
      types: ["sync.request"]
      subjects: ["github:*"]
tools:
  - hardcopy.fetch
  - hardcopy.push
---

When a sync request arrives for a GitHub URI:
1. Parse the URI to extract owner/repo/number
2. Fetch from GitHub API
3. Convert to Entity format
4. Return for merge with local state
```

**Changes:**
- Delete `src/contrib/github.ts`, `jira.ts`, `stripe.ts`
- Create example skills in `skills/` directory
- Link extractors become part of skill instructions
- Format handlers become skill logic
- Webhook inferrers handled by skill triggers

## Phase C4: Core Sync Engine

Keep the diff/merge/view logic as Hardcopy's core value.

```typescript
interface SyncEngine {
  diff(local: Entity, remote: Entity): Change[];
  merge(local: Entity, remote: Entity, strategy: MergeStrategy): Entity;
  renderView(entity: Entity, format: ViewFormat): string;
  parseView(content: string, format: ViewFormat): Partial<Entity>;
}

type MergeStrategy = 'local-wins' | 'remote-wins' | 'manual' | 'field-level';
type ViewFormat = 'markdown' | 'yaml' | 'json';
```

## Phase C5: Expose as Service

Register Hardcopy as a service in Patchwork's registry.

```typescript
// Hardcopy exposes these procedures
const hardcopyService: ServiceDefinition = {
  namespace: 'hardcopy',
  version: '1.0.0',
  source: { type: 'local', config: { handler: 'hardcopy' } },
  procedures: [
    { name: 'fetch', description: 'Fetch entity from remote', input: { uri: 'string' }, output: { entity: 'Entity' } },
    { name: 'push', description: 'Push changes to remote', input: { uri: 'string', changes: 'Change[]' }, output: { result: 'PushResult' } },
    { name: 'diff', description: 'Diff local and remote', input: { local: 'Entity', remote: 'Entity' }, output: { changes: 'Change[]' } },
    { name: 'sync', description: 'Full sync cycle', input: { uri: 'string', strategy: 'MergeStrategy' }, output: { entity: 'Entity' } },
  ],
  types: [],
};
```

---

# Integration Test: apps/chat Flow

## Test Scenario

User mentions a GitHub issue in chat. System fetches issue, responds with context, and can push changes back.

## Flow

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

## Test Checklist

- [ ] Chat message creates event with correct type/source/subject
- [ ] Orchestrator matches skill by trigger
- [ ] Skill can call Hardcopy service
- [ ] Hardcopy delegates to provider skill
- [ ] Entity stored in graph with correct URI
- [ ] Subsequent requests use cached entity
- [ ] Push flow works (user says "close this issue")
- [ ] Events visible in Apprentice search

## Implementation Steps

1. Create `skills/github-assistant/SKILL.md` with chat trigger
2. Create `skills/github-sync/SKILL.md` with sync logic
3. Register Hardcopy as local service in Stitchery
4. Wire chat UI to publish/subscribe events
5. Test full flow with real GitHub issue

---

# Migration Sequence

## Week 1: Apprentice Foundation

1. Add `entities` and `entity_links` tables
2. Implement `EntityGraph` interface
3. Upgrade `events` table to `Envelope` schema
4. Implement `EventBus` with pub/sub

## Week 2: Apprentice Orchestrator

1. Add `sessions` table
2. Implement `SessionManager`
3. Implement `Orchestrator` with event routing
4. Add concurrency control

## Week 3: Patchwork Cleanup

1. Delete duplicated packages
2. Update imports to use `@aprovan/apprentice`
3. Simplify `ServiceRegistry` (remove utcp)
4. Refactor `SkillRegistry` (remove executor)

## Week 4: Hardcopy Cleanup

1. Delete duplicated modules
2. Simplify Provider to SyncAdapter
3. Convert contribs to skills
4. Expose as service

## Week 5: Integration

1. Wire Stitchery to Apprentice
2. Update apps/chat
3. Create example skills
4. Test full flow

---

# File Changes Summary

## Apprentice

| Action | Path |
|--------|------|
| Add | `src/graph/index.ts` |
| Add | `src/graph/types.ts` |
| Add | `src/graph/entity-graph.ts` |
| Add | `src/graph/uri.ts` |
| Modify | `src/events/index.ts` → full EventBus |
| Add | `src/orchestrator/index.ts` |
| Add | `src/orchestrator/session.ts` |
| Modify | `src/db.ts` → add tables |
| Modify | `src/index.ts` → export new modules |

## Patchwork

| Action | Path |
|--------|------|
| Delete | `packages/events/` |
| Delete | `packages/graph/` |
| Delete | `packages/orchestrator/` |
| Modify | `packages/services/src/types.ts` → remove utcp |
| Modify | `packages/skills/src/registry.ts` → remove executor |
| Modify | `packages/stitchery/src/server/unified.ts` → use Apprentice |
| Add | `skills/github-assistant/SKILL.md` |
| Add | `skills/github-sync/SKILL.md` |

## Hardcopy

| Action | Path |
|--------|------|
| Delete | `src/events/` |
| Delete | `src/graph/` |
| Delete | `src/orchestrator/` |
| Delete | `src/services/` |
| Delete | `src/skills/` |
| Delete | `src/contrib/` |
| Modify | `src/provider.ts` → SyncAdapter |
| Modify | `src/hardcopy/` → core sync engine |
| Add | `src/service.ts` → expose as service |
