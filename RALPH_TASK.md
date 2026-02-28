---
task: Implement What's Next - Unified Event System
---

# Task: Implement Unified Event System

[whats-next.md](./docs/specs/whats-next.md) defines a system where "everything is a stream" - unifying Stitchery (dynamic API integration), Hardcopy (entity graph), and Apprentice (events/assets with versioning) into a cohesive event-driven architecture.

Keep iterating, updating this RALPH_TASK.md document as you discover new ideas. Continually refactor as-needed.

Prefer to be concise and simple with your approach. Avoid duplicated code and re-implementing exiting functionality. Always be aware of where code _should_ go.

- DO keep code in separated areas where possible
- DO keep implementation simple and free of comments
- Do NOT keep backwards compatibility. Break legacy implementations where needed and remove deprecated code.
- Re-factor and re-organize as-needed, as you go.


Be generic in your implementation. Think think thoroughly through the abstractions you create and consider if there is a more powerful variant that preserves functionality without major sacrifices.

- ALWAYS use a strong sense of module isolation
- Do NOT plan one-off variants or implementations, unless absolutely necessary and properly isolated.
- ALWAYS consider how the implementation will work long-term and be extensible.
- ALWAYS check with the user if there are open questions, conflicts, or fundamental issues with the approach.


## Success Criteria

- [ ] Event Bus operational with publish/subscribe/query
- [ ] Service Registry extended with versioning, schemas, and streaming
- [ ] Entity Graph supports URI-based linking and dynamic schemas
- [ ] Skills can be triggered by events
- [ ] LLM Orchestrator routes events to skills and monitors execution

---

## Phase 1: Event Bus Foundation

**Goal:** Unify all inputs/outputs through a single event primitive (Envelope).

### 1.1 Define Core Types
- [x] Create `Envelope` type (id, timestamp, type, source, subject, data, metadata)
- [x] Create `EventFilter` type (types, sources, subjects, since, metadata)
- [x] Create `EventBus` interface (publish, subscribe, stream, query)

### 1.2 SQLite Event Store
- [x] Create `events` table with columns matching Envelope schema
- [x] Add FTS index on `type`, `source`, `subject`, `data`
- [x] Add embedding column for vector search (from Apprentice pattern)
- [x] Implement batch insert for high throughput
- [x] Add time-based partitioning for efficient queries

### 1.3 Event Routing
- [x] Implement filter-based subscription matching
- [x] Create dead letter queue for failed handlers
- [x] Implement at-least-once delivery semantics

### 1.4 Ingest Adapters
- [x] Webhook receiver (HTTP POST → Envelope)
- [x] Schedule adapter (CRON → periodic Envelope)
- [x] Manual adapter (CLI/UI → Envelope)

---

## Phase 2: Service Registry with Schemas (Stitchery++)

**Goal:** Extend Stitchery with versioning, caching, and streaming.

### 2.1 Service Persistence
- [ ] Define `ServiceDefinition` type (namespace, version, source, procedures, types)
- [ ] Store service definitions in entity graph
- [ ] Implement semantic version tracking
- [ ] Extract schemas from OpenAPI/MCP definitions

### 2.2 Caching Layer
- [ ] Add per-procedure TTL configuration
- [ ] Implement cache invalidation via events
- [ ] Add ETag/Last-Modified support for HTTP backends

### 2.3 Streaming Support
- [ ] Create WebSocket adapter for streaming procedures
- [ ] Create SSE adapter for streaming procedures
- [ ] Implement Stream → Event bridge (stream events published to bus)
- [ ] Mark streaming procedures in service registry

### 2.4 Auto-Generated Entity Types
- [ ] Extract input/output types from service schemas
- [ ] Register entity types in graph automatically on service registration
- [ ] Create URI patterns from service/procedure combinations

---

## Phase 3: Entity Graph with Dynamic Linking (Hardcopy++)

**Goal:** Extend Hardcopy with URI-based linking and dynamic schemas.

### 3.1 URI Resolver
- [ ] Define URI convention: `scheme:path[#fragment][@version]`
- [ ] Parse URIs into provider/path/fragment/version components
- [ ] Resolve version references to concrete content
- [ ] Implement cross-provider URI validation

### 3.2 Link Extraction
- [ ] Define `LinkExtractor` interface (patterns, extract)
- [ ] Implement GitHub link extractor (issue URLs, `#123` references)
- [ ] Implement Jira link extractor
- [ ] Make extractors pluggable per content type
- [ ] Auto-create links on entity upsert
- [ ] Maintain bidirectional links

### 3.3 Dynamic Views
- [ ] Define `ViewDefinition` type (name, query, path, format, template, ttl)
- [ ] Implement Cypher-based view definitions
- [ ] Implement file system materialization
- [ ] Add incremental refresh based on TTL

### 3.4 Entity API
- [ ] Implement `upsert(entity)` and `upsertBatch(entities)`
- [ ] Implement `get(uri, version?)` with version resolution
- [ ] Implement `link/unlink` operations
- [ ] Implement `query(cypher)` and `traverse(uri, depth)`
- [ ] Add `inferSchema(type)` for dynamic schema inference

---

## Phase 4: Skill Integration

**Goal:** Skills as first-class event-triggered entities.

### 4.1 Skill Discovery
- [ ] Implement file system scanner for SKILL.md files
- [ ] Parse skill metadata (triggers, tools, model preferences)
- [ ] Link skills to Git-based versioning
- [ ] Resolve skill dependencies (required services)

### 4.2 Skill as Entity
- [ ] Define `SkillDefinition` type (id, uri, name, description, instructions, triggers, tools, model)
- [ ] Store skills in entity graph as `skill.Definition` type
- [ ] Create skill URIs: `skill:path/SKILL.md`

### 4.3 Trigger System
- [ ] Define `SkillTrigger` type (eventFilter, condition, priority)
- [ ] Implement event filter matching against skill triggers
- [ ] Add condition evaluation (Cypher predicates or JS expressions)
- [ ] Implement priority-based execution ordering

### 4.4 Skill Registry API
- [ ] Implement `register(skill)` and `unregister(skillId)`
- [ ] Implement `list()`, `get(skillId)`, `search(query)`
- [ ] Implement `execute(skillId, context)`

---

## Phase 5: LLM Orchestration

**Goal:** The "dumb" orchestrator that routes events to skills and monitors execution.

### 5.1 Event → Skill Routing
- [ ] Match incoming events to skill triggers
- [ ] Build context from entity graph (related entities, services)
- [ ] Select appropriate model based on skill preference

### 5.2 Session Management
- [ ] Define `Session` type (id, skillId, status, events, result)
- [ ] Define `SessionConfig` type (skillId, model, context, parentSessionId)
- [ ] Implement session lifecycle (running → complete/failed/cancelled)
- [ ] Support nested sessions for agent-to-agent calls

### 5.3 Execution Monitoring
- [ ] Stream all LLM chunks as events (`llm.{session}.chunk`)
- [ ] Emit tool call events (`llm.{session}.tool_call`)
- [ ] Track progress events (`llm.{session}.progress`)
- [ ] Implement error handling and retry logic

### 5.4 External Updates
- [ ] Send periodic progress updates to origin systems (GitHub, Jira)
- [ ] Emit completion notifications
- [ ] Publish artifacts from LLM sessions

---

## Open Questions to Address

- [ ] **Schema evolution**: Strategy for API schema changes over time
- [ ] **Conflict resolution**: Handling multiple skills triggering on same event
- [ ] **Resource limits**: Token budgets, time limits, cost tracking for LLM sessions
- [ ] **Authentication**: Credential vault / OAuth refresh for external APIs
- [ ] **Multi-tenancy**: Single-user vs multi-tenant isolation
- [ ] **Replay**: Event sourcing patterns for replaying skill executions

---

## Architecture Reference

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVENT BUS                                       │
│  Envelope[] → routing, batching, deduplication, dead letter                 │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       │                           │                           │
       ▼                           ▼                           ▼
┌──────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  SERVICE REGISTRY │     │    ENTITY GRAPH     │     │   SKILL REGISTRY    │
│  (Stitchery++)    │     │    (Hardcopy++)     │     │   (Skills++)        │
└───────┬──────────┘     └──────────┬──────────┘     └──────────┬──────────┘
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LLM ORCHESTRATOR                                  │
└─────────────────────────────────────────────────────────────────────────────┘
```

## Context

- [whats-next.md](./docs/specs/whats-next.md) - Full design specification
- [unified-event-system.md](./docs/specs/unified-event-system.md) - Related spec
