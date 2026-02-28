---
task: Implement What's Next - Unified Event System
---

# Task: Implement Unified Event System

Create new knowledge base docs as you deem fit, in 'docs', while iterating.

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

- [x] Event Bus operational with publish/subscribe/query
- [x] Service Registry extended with versioning, schemas, and streaming
- [x] Entity Graph supports URI-based linking and dynamic schemas
- [x] Skills can be triggered by events
- [x] LLM Orchestrator routes events to skills and monitors execution

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
- [x] Define `ServiceDefinition` type (namespace, version, source, procedures, types)
- [x] Store service definitions in entity graph
- [x] Implement semantic version tracking
- [x] Extract schemas from OpenAPI/MCP definitions

### 2.2 Caching Layer
- [x] Add per-procedure TTL configuration
- [x] Implement cache invalidation via events
- [x] Add ETag/Last-Modified support for HTTP backends

### 2.3 Streaming Support
- [x] Create WebSocket adapter for streaming procedures
- [x] Create SSE adapter for streaming procedures
- [x] Implement Stream → Event bridge (stream events published to bus)
- [x] Mark streaming procedures in service registry

### 2.4 Auto-Generated Entity Types
- [x] Extract input/output types from service schemas
- [x] Register entity types in graph automatically on service registration
- [x] Create URI patterns from service/procedure combinations

---

## Phase 3: Entity Graph with Dynamic Linking (Hardcopy++)

**Goal:** Extend Hardcopy with URI-based linking and dynamic schemas.

### 3.1 URI Resolver
- [x] Define URI convention: `scheme:path[#fragment][@version]`
- [x] Parse URIs into provider/path/fragment/version components
- [x] Resolve version references to concrete content
- [x] Implement cross-provider URI validation

### 3.2 Link Extraction
- [x] Define `LinkExtractor` interface (patterns, extract)
- [x] Implement GitHub link extractor (issue URLs, `#123` references)
- [x] Implement Jira link extractor
- [x] Make extractors pluggable per content type
- [x] Auto-create links on entity upsert
- [x] Maintain bidirectional links

### 3.3 Dynamic Views
- [x] Define `ViewDefinition` type (name, query, path, format, template, ttl)
- [x] Implement Cypher-based view definitions
- [x] Implement file system materialization
- [x] Add incremental refresh based on TTL

### 3.4 Entity API
- [x] Implement `upsert(entity)` and `upsertBatch(entities)`
- [x] Implement `get(uri, version?)` with version resolution
- [x] Implement `link/unlink` operations
- [x] Implement `query(cypher)` and `traverse(uri, depth)`
- [x] Add `inferSchema(type)` for dynamic schema inference

---

## Phase 4: Skill Integration

**Goal:** Skills as first-class event-triggered entities.

### 4.1 Skill Discovery
- [x] Implement file system scanner for SKILL.md files
- [x] Parse skill metadata (triggers, tools, model preferences)
- [x] Link skills to Git-based versioning
- [x] Resolve skill dependencies (required services)

### 4.2 Skill as Entity
- [x] Define `SkillDefinition` type (id, uri, name, description, instructions, triggers, tools, model)
- [x] Store skills in entity graph as `skill.Definition` type
- [x] Create skill URIs: `skill:path/SKILL.md`

### 4.3 Trigger System
- [x] Define `SkillTrigger` type (eventFilter, condition, priority)
- [x] Implement event filter matching against skill triggers
- [x] Add condition evaluation (Cypher predicates or JS expressions)
- [x] Implement priority-based execution ordering

### 4.4 Skill Registry API
- [x] Implement `register(skill)` and `unregister(skillId)`
- [x] Implement `list()`, `get(skillId)`, `search(query)`
- [x] Implement `execute(skillId, context)`

---

## Phase 5: LLM Orchestration

**Goal:** The "dumb" orchestrator that routes events to skills and monitors execution.

### 5.1 Event → Skill Routing
- [x] Match incoming events to skill triggers
- [x] Build context from entity graph (related entities, services)
- [x] Select appropriate model based on skill preference

### 5.2 Session Management
- [x] Define `Session` type (id, skillId, status, events, result)
- [x] Define `SessionConfig` type (skillId, model, context, parentSessionId)
- [x] Implement session lifecycle (running → complete/failed/cancelled)
- [x] Support nested sessions for agent-to-agent calls

### 5.3 Execution Monitoring
- [x] Stream all LLM chunks as events (`llm.{session}.chunk`)
- [x] Emit tool call events (`llm.{session}.tool_call`)
- [x] Track progress events (`llm.{session}.progress`)
- [x] Implement error handling and retry logic

### 5.4 External Updates
- [x] Send periodic progress updates to origin systems (GitHub, Jira)
- [x] Emit completion notifications
- [x] Publish artifacts from LLM sessions

---

## Future Considerations (Out of Scope)

The following are future enhancements to consider, not requirements for this task:

- **Schema evolution**: Strategy for API schema changes over time
- **Conflict resolution**: Handling multiple skills triggering on same event
- **Resource limits**: Token budgets, time limits, cost tracking for LLM sessions
- **Authentication**: Credential vault / OAuth refresh for external APIs
- **Multi-tenancy**: Single-user vs multi-tenant isolation
- **Replay**: Event sourcing patterns for replaying skill executions

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
