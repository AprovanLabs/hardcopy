# Plan A: Apprentice Refactor Spec

## Goal

Become the core runtime for graph, events, and orchestration. Other packages depend on Apprentice for these primitives.

---

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
  link(
    from: string,
    to: string,
    type: string,
    attrs?: Record<string, unknown>,
  ): Promise<void>;
  unlink(from: string, to: string, type: string): Promise<void>;
  traverse(uri: string, depth?: number): Promise<Entity[]>;
  query(filter: EntityFilter): Promise<Entity[]>;
}
```

### Changes

- Add `entities` and `entity_links` tables to existing DB schema
- Merge `assets` as entities with `file:` URI scheme
- Merge `events` as entities with `event:` URI scheme
- URI utilities: `parseUri`, `formatUri`, `normalizeUri`

---

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

### Changes

- Refactor `events` table to match `Envelope` schema
- Add in-memory subscription registry
- Add filter matching (types, sources, subjects with wildcards)
- Integrate with EntityGraph (events create/update entities)

---

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
  status: "pending" | "running" | "complete" | "failed" | "cancelled";
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

### Changes

- Add `sessions` table
- Implement event routing: subscribe `{ types: ["*"] }`, filter internal events
- Add concurrency control (`maxConcurrent` with queue)
- Add pluggable `ExternalNotifier` interface (no built-in implementations)

---

## Phase A4: Export Package

Export clean interfaces for Patchwork/Hardcopy to consume.

```typescript
// @aprovan/apprentice
export { EntityGraph, Entity, EntityLink, EntityFilter } from "./graph";
export { EventBus, Envelope, EventFilter, Subscription } from "./events";
export { Orchestrator, Session, SessionManager } from "./orchestrator";
export { SearchEngine, SearchResult } from "./search";
export { createApprentice, ApprenticeConfig } from "./index";
```

---

## File Changes

| Action | Path                                  |
| ------ | ------------------------------------- |
| Add    | `src/graph/index.ts`                  |
| Add    | `src/graph/types.ts`                  |
| Add    | `src/graph/entity-graph.ts`           |
| Add    | `src/graph/uri.ts`                    |
| Modify | `src/events/index.ts` → full EventBus |
| Add    | `src/orchestrator/index.ts`           |
| Add    | `src/orchestrator/session.ts`         |
| Modify | `src/db.ts` → add tables              |
| Modify | `src/index.ts` → export new modules   |
