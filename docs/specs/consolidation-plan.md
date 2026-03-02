# Patchwork + Hardcopy Consolidation Plan

## Overview

Both projects implement nearly identical abstractions across five core modules. The interfaces are often copy-paste equivalent, indicating a clear consolidation opportunity.

| Module | Patchwork | Hardcopy | Preferred |
|--------|-----------|----------|-----------|
| **Events** | `packages/events/` | `src/events/` | **Patchwork** - cleaner isolation |
| **Graph** | `packages/graph/` | `src/graph/` | **Hardcopy** - richer features |
| **Skills** | `packages/skills/` | `src/skills/` | Tie - identical abstractions |
| **Orchestrator** | `packages/orchestrator/` | `src/orchestrator/` | **Hardcopy** - notifiers, concurrency |
| **Services** | `packages/services/` | `src/services/` | **Hardcopy** - typed configs, streaming |

---

## Module-by-Module Differences

### Events

| Aspect | Patchwork | Hardcopy |
|--------|-----------|----------|
| Core types | `Envelope`, `EventFilter`, `EventBus` | Identical |
| Persistence | SQLite with FTS | SQLite with FTS |
| Routing | `EventRouter` with DLQ | Built into `EventBus` |
| Adapters | `createWebhookAdapter`, `ScheduleAdapter`, `createManualAdapter` | Same + `WebhookInferrer` registry |

**Difference**: Hardcopy has `WebhookInferrer` per provider, patchwork hardcodes GitHub inference in `unified.ts`.

### Graph

| Aspect | Patchwork | Hardcopy |
|--------|-----------|----------|
| Core types | `Entity`, `EntityLink`, `EntityGraph` | Identical |
| Link extraction | `LinkExtractorRegistry` | Same + integrated into `ProviderContrib` |
| Views | `ViewDefinition` | Same + `ViewRenderer` |
| URI handling | `parseUri`, `formatUri`, `UriPatternRegistry` | Same + per-provider URI patterns |

**Difference**: Hardcopy bundles URI patterns with providers via `ProviderContrib`.

### Skills

| Aspect | Patchwork | Hardcopy |
|--------|-----------|----------|
| Definition | `SkillDefinition` with triggers, tools, model | Identical + `dependencies` |
| Registry | `PersistentSkillRegistry` | Same |
| Scanner | `scanSkills()` with `gray-matter` | Same + `watchSkillChanges()` |

**Difference**: Hardcopy adds `dependencies` field for service resolution.

### Orchestrator

| Aspect | Patchwork | Hardcopy |
|--------|-----------|----------|
| Session | `Session` with lifecycle states | Same |
| Routing | Subscribe `{ types: ["*"] }`, filter `llm.*`/`orchestrator.*` | Same + `EventRouter` class |
| Concurrency | Not implemented | `maxConcurrent` with queue |
| Notifiers | None | `GitHubNotifier`, `JiraNotifier`, `CompositeNotifier` |

**Difference**: Hardcopy has production-ready concurrency and external notifiers.

### Services

| Aspect | Patchwork | Hardcopy |
|--------|-----------|----------|
| Source types | `utcp`, `mcp`, `http`, `grpc`, `local` | `mcp`, `http`, `grpc`, `local` |
| Config types | `Record<string, unknown>` (loose) | `McpSourceConfig`, `HttpSourceConfig`, etc. (typed) |
| Streaming | `StreamEvent<T>` | Same + `WebSocketAdapter`, `SSEAdapter` |
| Schema | None | `extractFromOpenApi`, `extractFromMcp` |

**Difference**: Hardcopy has typed source configs and schema extraction from OpenAPI/MCP.

---

## The `ProviderContrib` Pattern

Hardcopy's most valuable abstraction for 3rd party extensibility:

```typescript
interface ProviderContrib {
  name: string;
  createProvider: () => Provider;
  linkExtractors?: LinkExtractor[];
  formatHandlers?: FormatHandler[];
  webhookInferrers?: WebhookInferrer[];
  uriPatterns?: Record<string, Record<string, RegExp>>;
  uriComponentExtractors?: Record<string, (uri: string) => Record<string, string> | null>;
}
```

Bundles all provider-specific concerns (GitHub, Jira, Stripe, etc.) into a single registration. Patchwork lacks this—provider logic is scattered.

---

## Target Architecture

```
@core/events        ← Event bus, envelope, filters, adapters
@core/graph         ← Entity graph, URI, links, views
@core/skills        ← Skill definition, registry, scanner
@core/orchestrator  ← Session, routing, notifiers
@core/services      ← Service registry, backends, caching
@core/contrib       ← ProviderContrib pattern + built-in providers
```

---

## Phase 1: Core Types

Extract shared types into `@core/types`:

```typescript
// Envelope, EventFilter, Entity, EntityLink, SkillDefinition, ServiceDefinition
// URI utilities: parseUri, formatUri, normalizeUri
// Common patterns: Subscription, AsyncIterable wrappers
```

## Phase 2: Events Module

**Keep from Patchwork**: Package isolation, `EventRouter` as separate class
**Adopt from Hardcopy**: `WebhookInferrer` registry

```typescript
interface EventBus {
  publish(envelope: Envelope): Promise<void>;
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
  stream(filter: EventFilter): AsyncIterable<Envelope>;
  query(filter: EventFilter, options?: QueryOptions): Promise<EventPage>;
}

interface WebhookInferrer {
  provider: string;
  inferType(body: unknown, headers: Record<string, string>): string | null;
  inferSubject(body: unknown): string | undefined;
}
```

## Phase 3: Graph Module

**Keep from Patchwork**: Package isolation
**Adopt from Hardcopy**: `LinkExtractor` integration with providers, `ViewRenderer`

```typescript
interface EntityGraph {
  upsert(entity: Entity): Promise<void>;
  get(uri: string, version?: string): Promise<Entity | null>;
  link(from: string, to: string, type: string): Promise<void>;
  traverse(uri: string, depth?: number): Promise<Entity[]>;
  query(filter: EntityFilter): Promise<Entity[]>;
}
```

## Phase 4: Services Module

**Keep from Patchwork**: Package isolation, `utcp` source type
**Adopt from Hardcopy**: Typed source configs, schema extraction, streaming adapters

```typescript
interface ServiceSource {
  type: "utcp" | "mcp" | "http" | "grpc" | "local";
  config: UtcpConfig | McpConfig | HttpConfig | GrpcConfig | LocalConfig;
}

interface ServiceRegistry {
  register(service: ServiceDefinition): Promise<void>;
  call<T>(namespace: string, procedure: string, args: unknown): Promise<T>;
  stream<T>(namespace: string, procedure: string, args: unknown): AsyncIterable<T>;
}
```

## Phase 5: Orchestrator Module

**Keep from Patchwork**: Package isolation
**Adopt from Hardcopy**: Concurrency control, external notifiers

```typescript
interface Orchestrator {
  start(): void;
  stop(): void;
  startSession(config: SessionConfig): Promise<Session>;
}

interface ExternalNotifier {
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>;
  sendCompletion(session: Session): Promise<void>;
}
```

## Phase 6: Contrib Module

Port `ProviderContrib` pattern as first-class module:

```typescript
interface ProviderContrib {
  name: string;
  createProvider: () => Provider;
  linkExtractors?: LinkExtractor[];
  formatHandlers?: FormatHandler[];
  webhookInferrers?: WebhookInferrer[];
  uriPatterns?: Record<string, RegExp>;
}

// Built-in contribs
export { getGitHubContrib } from './providers/github';
export { getJiraContrib } from './providers/jira';
export { getStripeContrib } from './providers/stripe';
```

## Phase 7: Unified Wiring

Single factory function that wires everything:

```typescript
interface CoreConfig {
  dataDir: string;
  skillsDir?: string;
  contribs?: ProviderContrib[];
  llmAdapter?: LLMAdapter;
  enableOrchestrator?: boolean;
}

async function createCore(config: CoreConfig): Promise<Core> {
  const eventBus = new EventStore({ dbPath: `${config.dataDir}/core.db` });
  const entityGraph = new EntityStore({ dbPath, eventBus });
  const serviceRegistry = new ServiceRegistry({ dbPath, eventBus });
  const skillRegistry = new SkillRegistry({ entityGraph, eventBus, serviceRegistry });
  const orchestrator = new Orchestrator({ eventBus, entityGraph, skillRegistry, serviceRegistry });
  
  for (const contrib of config.contribs ?? []) {
    registerContrib(contrib);
  }
  
  return { eventBus, entityGraph, serviceRegistry, skillRegistry, orchestrator };
}
```

---

## Migration Path

1. Create `@core/*` packages with interfaces (no implementation)
2. Implement `@core/events` using patchwork base + hardcopy inferrers
3. Implement `@core/graph` using patchwork base + hardcopy views
4. Implement `@core/services` using hardcopy typed configs + patchwork utcp
5. Implement `@core/skills` (merge is trivial—nearly identical)
6. Implement `@core/orchestrator` using hardcopy notifiers + concurrency
7. Port `src/contrib/*` from hardcopy to `@core/contrib`
8. Update both repos to depend on `@core/*`

---

## Open Questions

1. **Where does `@core` live?** Separate repo, or within patchwork's monorepo?
2. **utcp vs mcp**: Patchwork adds `utcp` source type—is this still needed, or can it be a specialized MCP adapter?
3. **Database strategy**: Both use SQLite. Single DB vs per-module DBs?
4. **Provider interface**: Hardcopy's `Provider` has `fetch`/`push` semantics. Keep or simplify to contrib-only?
