# Unified Event System: Comprehensive Design Specification

> **Design Philosophy**: Everything is a stream. Just as Unix treats everything as a file descriptor, this system treats everything as an event stream with typed payloads. APIs, files, webhooks, websockets, LLM outputs—all flow through the same primitives.

---

## Table of Contents

1. [Current State Analysis](#current-state-analysis)
2. [Core Abstractions](#core-abstractions)
3. [Unified Architecture](#unified-architecture)
4. [Implementation Roadmap](#implementation-roadmap)
5. [Hypothetical Flow Walkthrough](#hypothetical-flow-walkthrough)

---

## Current State Analysis

### Patchwork/Stitchery: Dynamic API Integration

**What it does well:**
- Config-driven API registration via `.utcp_config.json`
- Unified `namespace.procedure()` interface across MCP/HTTP/GRPC
- Service discovery via `search_services` tool
- Widgets can call any registered API without code changes
- LLM validation loop ensures services are tested before widget generation

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  .utcp_config.json                                                       │
│  { "manual_call_templates": [{ name, call_template_type, ... }] }       │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  ServiceRegistry                                                         │
│  - registerBackend(backend, toolInfos[])                                │
│  - registerTools(mcpTools, namespace)                                   │
│  - call(namespace, procedure, args) → tries backends, then MCP          │
│  - getTools() → returns all registered tools for LLM                    │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  Widget Runtime (iframe)                                                 │
│  window.weather.get_forecast({...})                                     │
│    → Proxy → postMessage('patchwork:call')                              │
│    → Parent → POST /api/proxy/weather/get_forecast                      │
│    → ServiceRegistry.call() → UTCP/MCP backend                          │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Insight**: The `namespace.procedure` pattern is powerful. Services are discovered dynamically, and the LLM can generate code that calls them without knowing implementation details.

**Limitations:**
- Request/response only—no streaming support
- No caching layer (each call hits the API)
- No entity linking between API responses
- Services are ephemeral (discovered at runtime, not persisted)

---

### Hardcopy: Graph-Based Entity Linking

**What it does well:**
- SQLite + GraphQLite for Cypher queries
- Cross-system entity linking via ID conventions (`github:owner/repo#42`, `a2a:task-id`)
- Plain text (Markdown) as the intermediary format
- CRDT-based editing with three-way merge
- Views that materialize graph queries to file system

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Providers (github, a2a, git, pipe)                                      │
│  fetch() → Node[] + Edge[]                                              │
│  push() → update remote                                                 │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  SQLite Graph (hc_nodes, hc_edges)                                       │
│  - Node: { id, type, attrs, syncedAt, versionToken }                    │
│  - Edge: { type, fromId, toId, attrs }                                  │
│  - Cypher queries via GraphQLite extension                              │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  Views                                                                   │
│  query: "MATCH (i:github.Issue) WHERE i.state = 'open' RETURN i"        │
│  → renderNode() → Markdown files in docs/issues/                        │
│  → CRDT sync for collaborative editing                                  │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Insight**: The ID convention (`provider:path#identifier`) enables cross-system linking. Edges can reference nodes from different providers, creating a unified graph.

**Limitations:**
- Providers must be known at compile time (hardcoded)
- No dynamic API discovery (unlike Stitchery)
- LinkConfig templates are partially implemented
- No streaming or event subscription model

---

### Apprentice: Events vs Assets with Versioning

**What it does well:**
- Clear separation: Events (point-in-time) vs Assets (content with versions)
- Namespaced metadata (`shell.*`, `git.*`, `ai.*`)
- Hybrid search (FTS + vector with RRF fusion)
- Version filters (`ref`, `branch`, `before`, `history`)
- Context-based scoping with mounts
- Related context via temporal windows or metadata grouping

**Architecture:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Contexts (registered folders)                                           │
│  { id, path, version_provider: "git", enabled, include/exclude }        │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  Assets                                                                  │
│  { id: SHA256(context:key), content_hash, metadata, head_version_ref }  │
│  - content_store: deduplicated by hash                                  │
│  - asset_versions: per-file history linked to version_refs              │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  Events                                                                  │
│  { id: UUIDv7, timestamp, message, metadata, relations[] }              │
│  - relations: [{ asset_id, type: "shell.executed" }]                    │
│  - auto-enriched with git.ref, git.branch from cwd                      │
└────────────────────────────────────┬────────────────────────────────────┘
                                     │
┌────────────────────────────────────▼────────────────────────────────────┐
│  Search                                                                  │
│  - FTS: events_fts, assets_fts (BM25)                                   │
│  - Vector: event_embeddings, asset_embeddings (768-dim)                 │
│  - Hybrid: RRF fusion (FTS 0.4, vector 0.6)                             │
│  - Related context: grouped by session or temporal window               │
└─────────────────────────────────────────────────────────────────────────┘
```

**Key Insight**: The event/asset distinction with relations is powerful. Events are ephemeral occurrences; assets are durable content. Events can reference assets at specific versions.

**Limitations:**
- No external API integration (local files only)
- No graph linking between entities
- Version providers are limited to Git

---

## Core Abstractions

### The Fundamental Types

Drawing from all three systems, here are the core abstractions:

```typescript
// Everything flows through streams
type Stream<T> = AsyncIterable<T>;

// The universal event envelope
interface Envelope {
  id: string;                    // UUIDv7
  timestamp: string;             // ISO 8601
  type: string;                  // Namespaced: "github.issue.created"
  source: string;                // Origin: "webhook:github", "schedule:hourly"
  subject?: string;              // Entity URI: "github:AprovanLabs/projects#42"
  data: unknown;                 // Payload (JSON)
  metadata: Record<string, unknown>;  // Namespaced metadata
}

// Entities are nodes in the graph
interface Entity {
  uri: string;                   // Canonical: "github:owner/repo#42"
  type: string;                  // Schema type: "github.Issue"
  attrs: Record<string, unknown>;
  version?: string;              // Content hash or SHA for versioned entities
  syncedAt?: string;
  links?: EntityLink[];          // Outbound edges
}

// Links connect entities
interface EntityLink {
  type: string;                  // Relationship: "github.REFERENCES"
  targetUri: string;             // Target entity URI
  attrs?: Record<string, unknown>;
}

// Services expose procedures
interface Service {
  namespace: string;             // "github", "weather"
  version?: string;              // Semantic version
  procedures: Procedure[];
  schemas: Map<string, Schema>;  // Input/output types
}

interface Procedure {
  name: string;                  // "get_issue"
  description: string;
  input: Schema;
  output: Schema;
  streaming?: boolean;           // Supports SSE/WebSocket
}
```

### The URI Convention

All entities are addressable via URIs:

```
scheme:path[#fragment][@version]

Examples:
  github:AprovanLabs/projects#42           // GitHub issue
  github:AprovanLabs/projects#42@abc123    // Issue at specific commit
  jira:PROJ-123                            // Jira ticket
  file:/path/to/file.md@HEAD               // Local file at HEAD
  file:/path/to/file.md@abc123             // File at specific SHA
  a2a:task-uuid                            // A2A task
  skill:backlog/SKILL.md                   // Skill definition
```

This enables:
1. **Cross-system linking**: Extract URIs from text (GitHub comment mentioning Jira)
2. **Version resolution**: `@abc123` or `@HEAD` resolves content at that version
3. **Graph queries**: "Find all entities linked to this issue"

### Events vs Assets: A Unification

The key insight: **Assets are entities with content. Events are occurrences that may reference entities.**

```
┌──────────────────────────────────────────────────────────────────┐
│                         ENTITY                                    │
│  uri, type, attrs, version?, syncedAt?, links[]                  │
└──────────────────────────────────────────────────────────────────┘
                    ▲                           ▲
          ┌────────┴────────┐         ┌────────┴────────┐
          │      ASSET      │         │      EVENT      │
          │  (has content)  │         │  (is occurrence)│
          │  content_hash   │         │  timestamp      │
          │  content        │         │  source         │
          └─────────────────┘         └─────────────────┘

Asset examples:
  - file:/path/to/script.sh → content is the script
  - github:owner/repo#42 → content is issue body + comments
  - skill:backlog/SKILL.md → content is skill definition

Event examples:
  - github.issue.created → references the issue entity
  - shell.command.executed → references the script asset
  - schedule.triggered → references the schedule config
```

Files in Git are assets where `version` is the SHA. The "current time" interpretation you mentioned is handled by `syncedAt` for external assets and `version@HEAD` for local files.

---

## Unified Architecture

### System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              EVENT BUS                                       │
│  Envelope[] → routing, batching, deduplication, dead letter                 │
│  Sources: webhooks, schedules, streams, manual                              │
│  Sinks: handlers, LLM orchestrators, graph updates                          │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       │                           │                           │
       ▼                           ▼                           ▼
┌──────────────────┐     ┌─────────────────────┐     ┌─────────────────────┐
│  SERVICE REGISTRY │     │    ENTITY GRAPH     │     │   SKILL REGISTRY    │
│  (Stitchery++)    │     │    (Hardcopy++)     │     │   (Skills++)        │
│                   │     │                     │     │                     │
│ namespace.proc()  │     │ Cypher queries      │     │ SKILL.md + scripts  │
│ schemas + versions│     │ URI-based linking   │     │ Mounted as entities │
│ streaming support │     │ Sync + cache        │     │ Trigger conditions  │
└───────┬──────────┘     └──────────┬──────────┘     └──────────┬──────────┘
        │                           │                           │
        │                           │                           │
        └───────────────────────────┼───────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            LLM ORCHESTRATOR                                  │
│  - Receives events matching registered conditions                           │
│  - Given: purpose, context (from graph), tools (from services + skills)     │
│  - Produces: new events, entity updates, service calls                      │
│  - Status streamed as events for observability                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Component Details

#### 1. Event Bus

The central nervous system. All inputs become events; all outputs are events.

```typescript
interface EventBus {
  // Ingest
  publish(envelope: Envelope): Promise<void>;
  publishBatch(envelopes: Envelope[]): Promise<void>;
  
  // Consume
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
  
  // Streaming
  stream(filter: EventFilter): AsyncIterable<Envelope>;
  
  // Persistence
  query(filter: EventFilter, options?: QueryOptions): Promise<Envelope[]>;
}

interface EventFilter {
  types?: string[];              // ["github.issue.*", "schedule.*"]
  sources?: string[];            // ["webhook:github", "schedule:*"]
  subjects?: string[];           // ["github:AprovanLabs/*"]
  since?: string;                // ISO timestamp
  metadata?: Record<string, unknown>;  // Namespaced filters
}

interface EventHandler {
  (envelope: Envelope): Promise<void>;
}
```

**Event Sources:**

| Source | Type Pattern | Example |
|--------|--------------|---------|
| Webhook | `webhook:{provider}.{resource}.{action}` | `webhook:github.issue.opened` |
| Schedule | `schedule.triggered` | CRON-based heartbeats |
| Stream | `stream:{provider}.{event}` | WebSocket/SSE events |
| Service | `service.{namespace}.{procedure}.{result}` | `service.weather.get_forecast.success` |
| LLM | `llm.{session}.{event}` | `llm.abc123.chunk`, `llm.abc123.complete` |
| Manual | `manual.{type}` | User-triggered events |

**Batching and Deduplication:**

```typescript
interface BatchConfig {
  maxSize: number;               // Max events per batch
  maxWaitMs: number;             // Max time to wait for batch
  dedupeKey?: (e: Envelope) => string;  // Deduplication key
}

// Example: Batch GitHub events by repository
const batchConfig: BatchConfig = {
  maxSize: 100,
  maxWaitMs: 5000,
  dedupeKey: (e) => `${e.subject}:${e.type}`,
};
```

#### 2. Service Registry (Stitchery++)

Extends Stitchery with versioning, schemas, and streaming.

```typescript
interface ServiceRegistry {
  // Registration
  register(service: ServiceDefinition): Promise<void>;
  unregister(namespace: string): Promise<void>;
  
  // Discovery
  list(): Promise<ServiceSummary[]>;
  get(namespace: string): Promise<ServiceDefinition | null>;
  search(query: string): Promise<SearchResult[]>;
  
  // Invocation
  call(namespace: string, procedure: string, args: unknown[]): Promise<unknown>;
  stream(namespace: string, procedure: string, args: unknown[]): AsyncIterable<unknown>;
  
  // Schema
  getSchema(namespace: string, typeName: string): Promise<Schema | null>;
}

interface ServiceDefinition {
  namespace: string;
  version: string;               // Semantic version
  source: ServiceSource;         // Where this came from
  procedures: ProcedureDefinition[];
  types: TypeDefinition[];       // Input/output schemas
}

interface ServiceSource {
  type: "utcp" | "mcp" | "http" | "grpc" | "local";
  config: unknown;               // Source-specific config
}

interface ProcedureDefinition {
  name: string;
  description: string;
  input: TypeReference;
  output: TypeReference;
  streaming?: boolean;
  cacheTtl?: number;             // Cache TTL in seconds
}
```

**Auto-Generated Entity Types:**

When a service is registered, its input/output types are extracted and become entity types in the graph:

```typescript
// Service: github
// Procedure: get_issue
// Output type: github.Issue

// Automatically registered entity type:
{
  uri_pattern: "github:{owner}/{repo}#{number}",
  type: "github.Issue",
  schema: {
    number: "integer",
    title: "string",
    body: "string",
    state: "string",
    labels: "string[]",
    assignees: "string[]",
    // ... from OpenAPI/MCP schema
  }
}
```

**Streaming Support:**

```typescript
// SSE/WebSocket procedures are marked as streaming
const stream = registry.stream("github", "watch_issues", [{ owner, repo }]);

for await (const event of stream) {
  // Each event is also published to the event bus
  await eventBus.publish({
    id: uuidv7(),
    timestamp: new Date().toISOString(),
    type: "stream:github.issue.updated",
    source: "stream:github",
    subject: `github:${owner}/${repo}#${event.number}`,
    data: event,
    metadata: {},
  });
}
```

#### 3. Entity Graph (Hardcopy++)

Extends Hardcopy with dynamic schema inference and URI-based linking.

```typescript
interface EntityGraph {
  // CRUD
  upsert(entity: Entity): Promise<void>;
  upsertBatch(entities: Entity[]): Promise<void>;
  get(uri: string, version?: string): Promise<Entity | null>;
  delete(uri: string): Promise<void>;
  
  // Links
  link(fromUri: string, toUri: string, type: string, attrs?: unknown): Promise<void>;
  unlink(fromUri: string, toUri: string, type: string): Promise<void>;
  
  // Query
  query(cypher: string, params?: Record<string, unknown>): Promise<Entity[]>;
  traverse(uri: string, depth?: number): Promise<EntityGraph>;
  
  // Schema
  inferSchema(type: string): Promise<Schema>;
  getTypes(): Promise<TypeDefinition[]>;
}
```

**URI-Based Link Extraction:**

When entities are stored, their content is scanned for URIs that become links:

```typescript
// Issue body: "See also JIRA-123 and https://github.com/other/repo/issues/45"

// Extracted links:
[
  { type: "mentions", targetUri: "jira:JIRA-123" },
  { type: "mentions", targetUri: "github:other/repo#45" },
]
```

**Link extractors are pluggable:**

```typescript
interface LinkExtractor {
  patterns: RegExp[];
  extract(content: string): EntityLink[];
}

// Built-in extractors:
const githubExtractor: LinkExtractor = {
  patterns: [
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/g,
    /#(\d+)/g,  // Relative issue references
  ],
  extract(content) {
    // Return extracted links
  },
};
```

**Dynamic Views (Hardcopy's best feature, generalized):**

```typescript
interface ViewDefinition {
  name: string;
  query: string;                 // Cypher query
  path: string;                  // Output path template
  format: string;                // "markdown" | "json" | "yaml"
  template?: string;             // Handlebars template
  ttl?: number;                  // Refresh interval
}

// Example: Dynamic view for GitHub issues
const issuesView: ViewDefinition = {
  name: "open-issues",
  query: `
    MATCH (i:\`github.Issue\`)
    WHERE i.state = 'open'
    RETURN i
    ORDER BY i.created_at DESC
  `,
  path: "docs/issues/{{attrs.repository}}/issue-{{attrs.number}}.md",
  format: "markdown",
  ttl: 300,
};
```

#### 4. Skill Registry

Skills become first-class entities that can be triggered by events.

```typescript
interface SkillRegistry {
  // Registration
  register(skill: SkillDefinition): Promise<void>;
  unregister(skillId: string): Promise<void>;
  
  // Discovery
  list(): Promise<SkillSummary[]>;
  get(skillId: string): Promise<SkillDefinition | null>;
  search(query: string): Promise<SkillDefinition[]>;
  
  // Execution
  execute(skillId: string, context: SkillContext): Promise<SkillResult>;
}

interface SkillDefinition {
  id: string;                    // "backlog", "issue-planner"
  uri: string;                   // "skill:backlog/SKILL.md"
  name: string;
  description: string;
  instructions: string;          // SKILL.md content
  resources: SkillResource[];    // Supporting .md files and scripts
  triggers?: SkillTrigger[];     // Event conditions
  tools?: string[];              // Required service namespaces
  model?: ModelPreference;       // Preferred model
}

interface SkillTrigger {
  eventFilter: EventFilter;      // When to activate
  condition?: string;            // Additional Cypher/JS condition
  priority?: number;             // Execution priority
}

interface SkillContext {
  event: Envelope;               // Triggering event
  entities: Entity[];            // Related entities from graph
  services: string[];            // Available service namespaces
  history?: Envelope[];          // Recent related events
}
```

**Skill as Entity:**

```typescript
// Skills are stored in the entity graph
const backlogSkill: Entity = {
  uri: "skill:backlog/SKILL.md",
  type: "skill.Definition",
  attrs: {
    name: "Backlog Manager",
    description: "Manage project tasks using backlog.md files",
    triggers: [
      {
        eventFilter: { types: ["github.issue.opened"] },
        condition: "event.data.labels CONTAINS 'auto-plan'",
      },
    ],
  },
  version: "abc123",  // Git SHA of SKILL.md
};
```

#### 5. LLM Orchestrator

The "dumb" orchestration layer that routes events to skills and manages execution.

```typescript
interface Orchestrator {
  // Configuration
  registerSkillTrigger(skillId: string, trigger: SkillTrigger): void;
  
  // Execution
  handleEvent(envelope: Envelope): Promise<void>;
  
  // Sessions
  startSession(config: SessionConfig): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
}

interface SessionConfig {
  skillId: string;
  model: ModelSpec;
  context: SkillContext;
  parentSessionId?: string;      // For nested agent calls
}

interface Session {
  id: string;
  skillId: string;
  status: "running" | "complete" | "failed" | "cancelled";
  startedAt: string;
  completedAt?: string;
  events: Envelope[];            // All events from this session
  result?: unknown;
}

interface ModelSpec {
  provider: string;              // "anthropic", "openai"
  model: string;                 // "claude-opus-4-20250514"
  temperature?: number;
  maxTokens?: number;
}
```

**Execution Flow:**

```typescript
async function handleEvent(envelope: Envelope): Promise<void> {
  // 1. Find matching skills
  const skills = await findMatchingSkills(envelope);
  
  for (const skill of skills) {
    // 2. Build context from entity graph
    const entities = await buildContext(envelope, skill);
    
    // 3. Start LLM session
    const session = await startSession({
      skillId: skill.id,
      model: skill.model ?? { provider: "anthropic", model: "claude-sonnet-4-20250514" },
      context: { event: envelope, entities, services: skill.tools ?? [] },
    });
    
    // 4. Stream session events to event bus
    for await (const event of session.events) {
      await eventBus.publish({
        id: uuidv7(),
        timestamp: new Date().toISOString(),
        type: `llm.${session.id}.${event.type}`,
        source: `orchestrator:${skill.id}`,
        subject: envelope.subject,
        data: event.data,
        metadata: {
          session: { id: session.id, skillId: skill.id },
          parent: envelope.id,
        },
      });
    }
  }
}
```

---

## Implementation Roadmap

### Phase 1: Event Bus Foundation

**Goal:** Unify all inputs/outputs through a single event primitive.

1. **SQLite-based event store**
   - `events` table with FTS and embedding columns (from Apprentice)
   - Batch insert for high throughput
   - Time-based partitioning for efficient queries

2. **Event routing**
   - Filter-based subscription matching
   - Dead letter queue for failed handlers
   - At-least-once delivery semantics

3. **Ingest adapters**
   - Webhook receiver (HTTP POST → Envelope)
   - Schedule adapter (CRON → periodic Envelope)
   - Manual adapter (CLI/UI → Envelope)

### Phase 2: Service Registry with Schemas

**Goal:** Extend Stitchery with versioning, caching, and streaming.

1. **Service persistence**
   - Store service definitions in entity graph
   - Version tracking with semantic versioning
   - Schema extraction from OpenAPI/MCP

2. **Caching layer**
   - Per-procedure TTL configuration
   - Cache invalidation via events
   - ETag/Last-Modified support

3. **Streaming support**
   - WebSocket adapter
   - SSE adapter
   - Stream → Event bridge

### Phase 3: Entity Graph with Dynamic Linking

**Goal:** Extend Hardcopy with URI-based linking and dynamic schemas.

1. **URI resolver**
   - Parse URIs into provider/path/fragment/version
   - Resolve version references to concrete content
   - Cross-provider URI validation

2. **Link extraction**
   - Pluggable extractors per content type
   - Automatic link creation on entity upsert
   - Bidirectional link maintenance

3. **Dynamic views**
   - Cypher-based view definitions
   - File system materialization
   - Incremental refresh

### Phase 4: Skill Integration

**Goal:** Skills as first-class event-triggered entities.

1. **Skill discovery**
   - File system scanner for SKILL.md
   - Git-based versioning
   - Dependency resolution (required services)

2. **Trigger system**
   - Event filter matching
   - Condition evaluation (Cypher predicates)
   - Priority-based execution

3. **Session management**
   - Session lifecycle events
   - Nested session support
   - Result aggregation

### Phase 5: LLM Orchestration

**Goal:** The "dumb" orchestrator that routes and monitors.

1. **Event → Skill routing**
   - Match events to skill triggers
   - Build context from entity graph
   - Select appropriate model

2. **Execution monitoring**
   - Stream all LLM chunks as events
   - Progress tracking
   - Error handling and retry

3. **External updates**
   - Periodic progress updates to origin (GitHub, Jira)
   - Completion notifications
   - Artifact publishing

---

## Hypothetical Flow Walkthrough

Let's trace through your example scenario:

### Setup

```yaml
# services.yaml
services:
  - namespace: git
    source:
      type: mcp
      config:
        command: git-mcp
        args: []
    
  - namespace: github
    source:
      type: mcp
      config:
        command: github-mcp
        args: []

# skills/ralph-wiggum/SKILL.md
triggers:
  - eventFilter:
      types: ["schedule.triggered"]
    condition: "event.metadata.schedule.name = 'ralph-wiggum'"

instructions: |
  Keep running over and over. Never give up. Never surrender.
  
# skills/issue-planner/SKILL.md  
triggers:
  - eventFilter:
      types: ["github.issue.labeled"]
    condition: "event.data.label.name = 'auto-plan'"

instructions: |
  Break down this issue into tasks using backlog.md format.
  Use Claude Opus 4.5 for planning.
  
model:
  provider: anthropic
  model: claude-opus-4-20250514
  
tools:
  - git
  - github

# skills/backlog/SKILL.md
triggers:
  - eventFilter:
      types: ["llm.*.plan.complete"]
    condition: "event.metadata.skill.id = 'issue-planner'"

instructions: |
  Implement the tasks from the plan using backlog.md format.
  Update the GitHub issue with progress.
```

### Flow

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ 1. GitHub Webhook                                                            │
│    POST /webhooks/github                                                     │
│    { action: "labeled", issue: {...}, label: { name: "auto-plan" } }        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 2. Event Bus: Publish                                                        │
│    {                                                                         │
│      id: "evt_abc123",                                                       │
│      type: "github.issue.labeled",                                           │
│      source: "webhook:github",                                               │
│      subject: "github:AprovanLabs/projects#42",                              │
│      data: { action: "labeled", issue: {...}, label: {...} },               │
│      metadata: { github: { repository: "AprovanLabs/projects" } }           │
│    }                                                                         │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 3. Orchestrator: Match Skills                                                │
│    - issue-planner matches (type + condition on label.name)                 │
│    - Build context:                                                          │
│      - Entity: github:AprovanLabs/projects#42 (from graph)                  │
│      - Related: linked entities, recent events                              │
│      - Services: [git, github]                                              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 4. Start LLM Session: issue-planner                                          │
│    Session ID: sess_plan_xyz                                                 │
│    Model: claude-opus-4-20250514                                             │
│    Prompt: SKILL.md instructions + context                                   │
│                                                                              │
│    LLM uses tools:                                                           │
│    - git.read_file("backlog.md") → existing tasks                           │
│    - github.get_issue(42) → full issue details                              │
│    - git.write_file("backlog.md", newTasks) → update tasks                  │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ (streaming events)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 5. Event Bus: LLM Events                                                     │
│    llm.sess_plan_xyz.chunk → streamed tokens                                │
│    llm.sess_plan_xyz.tool_call → git.read_file, etc.                        │
│    llm.sess_plan_xyz.plan.complete → planning done                          │
│                                                                              │
│    (All events visible for monitoring/hooking)                              │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 6. Orchestrator: Match Skills (again)                                        │
│    - backlog skill matches llm.*.plan.complete where skill = issue-planner  │
│    - Build context with plan results                                        │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 7. Start LLM Session: backlog                                                │
│    Session ID: sess_impl_abc                                                 │
│    Model: claude-sonnet-4-20250514 (default, medium-intelligence)            │
│    Parent: sess_plan_xyz                                                     │
│                                                                              │
│    LLM implements tasks:                                                     │
│    - Read backlog.md tasks                                                   │
│    - For each task: implement, test, mark complete                          │
│    - github.add_comment(42, progressNote) → periodic updates                │
└──────────────────────────────────┬──────────────────────────────────────────┘
                                   │
                                   │ (streaming events)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ 8. Event Bus: Implementation Events                                          │
│    llm.sess_impl_abc.chunk → streamed tokens                                │
│    llm.sess_impl_abc.tool_call → file edits, tests                          │
│    llm.sess_impl_abc.progress → task completion updates                     │
│    service.github.add_comment.success → comment posted                      │
│    llm.sess_impl_abc.complete → implementation done                         │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Observability

At any point, you can:

```typescript
// Query recent events for the issue
const events = await eventBus.query({
  subjects: ["github:AprovanLabs/projects#42"],
  since: "2025-02-28T00:00:00Z",
});

// See all LLM sessions
const sessions = await eventBus.query({
  types: ["llm.*.complete", "llm.*.failed"],
  since: "2025-02-28T00:00:00Z",
});

// Get related entities
const entity = await graph.get("github:AprovanLabs/projects#42");
const related = await graph.traverse(entity.uri, 2);

// See skill execution history
const skillEvents = await eventBus.query({
  metadata: { "skill.id": "issue-planner" },
  since: "2025-02-01T00:00:00Z",
});
```

---

## Open Questions

1. **Schema evolution**: How do we handle API schema changes over time? Version the schemas and migrate entities?

2. **Conflict resolution**: When multiple skills trigger on the same event, how do we coordinate? Priority? Mutex? Saga pattern?

3. **Resource limits**: How do we prevent runaway LLM sessions? Token budgets? Time limits? Cost tracking?

4. **Authentication**: How do services authenticate to external APIs? Credential vault? OAuth refresh?

5. **Multi-tenancy**: Is this system single-user or multi-tenant? How do we isolate data and costs?

6. **Replay**: Can we replay events to re-run skill executions? Event sourcing patterns?

---

## Summary

The unified event system combines:

| System | Contribution |
|--------|--------------|
| **Stitchery** | Dynamic service registry with namespace.procedure() |
| **Hardcopy** | Entity graph with Cypher queries and URI-based linking |
| **Apprentice** | Event/asset distinction with versioning and hybrid search |
| **New** | Event bus for routing, skill triggers, LLM orchestration |

**The core insight**: Everything is an event stream. Services emit events. Entities are updated by events. Skills trigger on events. LLMs produce events. This creates a unified, observable, hookable system where LLMs can integrate with arbitrary APIs and respond to arbitrary inputs without custom code.
