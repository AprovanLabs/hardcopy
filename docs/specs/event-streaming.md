# Event Streaming

Extend Hardcopy from a poll-based sync engine into a continuous event bridge. Hardcopy already has the right bones — a graph DB, CRDTs, a provider interface, views — this spec adds a streaming primitive on top without disrupting any of that.

---

## Context

Hardcopy syncs data from 3rd-party sources via API calls into a local SQLite+GraphQLite graph, resolves conflicts with CRDTs, and renders views to plain-text files. The current `Provider` interface is request/response:

```
fetch(request) → FetchResult { nodes, edges }
push(node, changes) → PushResult
```

This works for entity-oriented data (issues, tasks, branches) but can't express:
- Local agent lifecycle and message events (A2A task state changes, inter-agent messages)
- Shell/process output streams (stdout/stderr of running commands, build logs)
- Live metric/log streams (Datadog, Prometheus)
- Chat or LLM completion streams
- Webhook delivery
- P2P event feeds

We need a new primitive — **events** — that sits alongside nodes/edges in the data model and flows through the same DB, query engine, and view system.

---

## Data Model

### Event

An event is an immutable, timestamped record associated with a stream.

```typescript
interface Event {
  id: string;            // globally unique, e.g. "pipe:agent-abc:00042"
  stream: string;        // stream identifier, e.g. "pipe.agent-abc.stdout"
  type: string;          // event type within stream, e.g. "line", "chunk", "exit"
  timestamp: number;     // epoch ms, ingestion time if source lacks one
  attrs: Record<string, unknown>;
  sourceId?: string;     // optional link to a Node id
  parentId?: string;     // optional link to a parent Event id (e.g. session → message)
}
```

Events are _append-only_. No CRDT merge needed — they're immutable facts, not mutable documents.

`parentId` enables lightweight hierarchies without a separate table — a shell session event can parent individual command events, an agent session can parent task events. Queries filter by `parentId` to scope within a session.

### Stream

A stream is a named, typed channel of events. Streams are declared by providers and registered at runtime.

```typescript
interface Stream {
  name: string;          // "datadog.alerts", "llm.chat", "webhook.inbound"
  provider: string;      // owning provider name
  description?: string;
  schema?: EventSchema;  // optional JSON Schema for event attrs
  retention?: {
    maxAge?: number;     // ms, auto-prune older events
    maxCount?: number;   // cap per stream
  };
}
```

### Storage

Events live in a new `hc_events` table alongside `hc_nodes` and `hc_edges`:

```sql
CREATE TABLE IF NOT EXISTS hc_events (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  attrs TEXT NOT NULL,          -- JSON
  source_id TEXT,              -- FK to hc_nodes.id, nullable
  parent_id TEXT,              -- FK to hc_events.id, nullable (session/group hierarchy)
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_events_stream ON hc_events(stream);
CREATE INDEX IF NOT EXISTS hc_idx_events_ts ON hc_events(timestamp);
CREATE INDEX IF NOT EXISTS hc_idx_events_type ON hc_events(type);
CREATE INDEX IF NOT EXISTS hc_idx_events_source ON hc_events(source_id);
CREATE INDEX IF NOT EXISTS hc_idx_events_parent ON hc_events(parent_id);
```

This extends the existing SQLite-backed graph. Events can be joined to nodes via `source_id` and queried alongside graph data in Cypher views.

---

## Provider Interface Extension

The existing `Provider` interface gains an optional streaming surface:

```typescript
interface Provider {
  // ... existing: fetch, push, fetchNode, getTools, nodeTypes, edgeTypes

  // New — optional streaming capabilities
  streams?: Stream[];

  subscribe?(
    stream: string,
    options?: SubscribeOptions,
  ): AsyncIterable<Event[]>;

  query?(
    stream: string,
    filter: EventFilter,
  ): Promise<EventPage>;
}

interface SubscribeOptions {
  filter?: EventFilter;
  cursor?: string;       // resume from position
  batchSize?: number;    // max events per yield
  batchWindow?: number;  // ms, max wait before yielding partial batch
}

interface EventFilter {
  types?: string[];
  since?: number;        // epoch ms
  until?: number;
  attrs?: Record<string, unknown>; // equality match on attrs fields
  sourceId?: string;
  parentId?: string;     // scope to events within a session/group
}

interface EventPage {
  events: Event[];
  cursor?: string;
  hasMore: boolean;
}
```

Providers that only do request/response (GitHub, Git) don't implement `subscribe`/`query` — nothing changes for them. Providers that produce events declare `streams` and implement one or both methods.

`subscribe` returns an `AsyncIterable<Event[]>` — the simplest possible streaming contract. No custom EventEmitter, no Observable library dependency. Consumers `for await` over batches. The iterable cleans up on `break` or `return`.

`query` is the historical counterpart — paginated search over persisted events. Same filter shape, different access pattern.

---

## EventBus

The `EventBus` is the internal coordination layer. It multiplexes provider subscriptions, persists events, and exposes a unified subscription surface.

```typescript
class EventBus {
  private db: HardcopyDatabase;
  private subscriptions: Map<string, Set<Subscriber>>;

  // Ingest events from any source
  async emit(events: Event[]): Promise<void>;

  // Subscribe to live events (post-persistence)
  subscribe(
    filter: EventFilter,
    callback: (events: Event[]) => void,
  ): Unsubscribe;

  // Query persisted events
  query(filter: EventFilter): Promise<EventPage>;

  // Start provider stream ingestion
  attach(provider: Provider, stream: string): Promise<Detach>;

  // Prune old events per retention policy
  prune(stream: string, retention: Stream["retention"]): Promise<number>;
}

type Unsubscribe = () => void;
type Detach = () => void;
```

Flow:
1. `attach()` starts consuming a provider's `subscribe()` iterable in the background
2. Each batch is written to `hc_events` via `emit()`
3. `emit()` persists, then fans out to any live `subscribe()` callbacks
4. `query()` reads from `hc_events` directly

The bus doesn't transform events. It persists and routes. Transformation happens at the view/query layer.

---

## Querying Events

### Cypher Integration

Events are queryable alongside the existing graph. Since GraphQLite operates on SQLite tables, events can be exposed as virtual graph nodes or joined via SQL within Cypher queries.

A view query that correlates events with nodes:

```yaml
views:
  - path: docs/alerts
    description: "Recent alerts correlated with issues"
    query: |
      MATCH (i:github.Issue)
      WHERE i.attrs->>'state' = 'open'
      RETURN i
    events:
      stream: datadog.alerts
      filter:
        since: "-24h"
      join:
        on: source_id
        to: i.id
    render:
      - path: "{{attrs.number}}-alerts.md"
        type: github.Issue
```

### SQL Fallback

For consumers that don't need graph traversal, raw SQL on `hc_events` works:

```sql
SELECT * FROM hc_events
WHERE stream = 'datadog.alerts'
  AND timestamp > :since
  AND json_extract(attrs, '$.severity') = 'critical'
ORDER BY timestamp DESC
LIMIT 100;
```

### Embeddability

The storage layer is SQLite (via `better-sqlite3` / `libsql`). Both have WASM builds. The event table, indices, and queries are pure SQL — no server process, no external dependencies. A browser consumer can:

1. Load the `.hardcopy/db.sqlite` file (or a libSQL replica)
2. Query `hc_events` directly
3. Subscribe to new events via a sync protocol (libSQL embedded replicas, or a simple WebSocket relay)

No DuckDB needed. libSQL's embedded replica protocol already solves the "sync a SQLite DB to the browser" problem, and the existing `@libsql/client` dependency supports it.

---

## Local Event Sources

The most important event sources aren't remote APIs — they're local processes. Agents, shells, build tools, and dev servers all produce continuous text/structured output that should flow through the same event primitives.

### The Pipe Abstraction

Every local event source reduces to the same shape: **read from a file descriptor, parse lines/chunks, emit events**. Rather than building bespoke providers for each (agent provider, shell provider, LLM provider), we use a single `pipe` provider that connects to any readable source.

A pipe source is defined by:
1. **Transport** — how to connect (spawn a process, open a unix socket, tail a file, listen on a port)
2. **Codec** — how to parse the byte stream into events (lines, JSON-per-line, SSE, raw chunks)

```typescript
interface PipeSource {
  transport:
    | { type: "exec"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
    | { type: "socket"; path: string }
    | { type: "file"; path: string; follow?: boolean }   // tail -f semantics
    | { type: "http"; port: number; path?: string }       // listen for incoming
    | { type: "tcp"; host: string; port: number };
  codec:
    | { type: "lines" }           // one event per line
    | { type: "jsonl" }           // one event per JSON line, attrs = parsed object
    | { type: "sse" }             // Server-Sent Events
    | { type: "chunks"; size?: number }; // raw byte chunks
  stream: string;                 // stream name, e.g. "pipe.build-server.stdout"
  sourceId?: string;              // link events to a Node
}
```

This covers every local source case:

| Use case | Transport | Codec | Stream name |
|----------|-----------|-------|-------------|
| Agent running | `exec` (spawn agent process) | `jsonl` (structured agent events) | `pipe.agent-{id}.events` |
| Shell session | `exec` (spawn shell) | `lines` (stdout text) | `pipe.shell-{id}.stdout` |
| Build watcher | `exec` (`pnpm dev`) | `lines` | `pipe.build.stdout` |
| LLM completion | `socket` (local inference server) | `sse` | `pipe.llm.completions` |
| Webhook receiver | `http` (listen on port) | `jsonl` | `pipe.webhook.inbound` |
| Log file | `file` (tail) | `lines` | `pipe.logs.app` |

### Session Events

Local processes have a lifecycle. The pipe provider automatically emits structural events:

- `session.start` — process/connection opened, `attrs: { pid, command, cwd }`
- `session.end` — process/connection closed, `attrs: { exitCode, duration }`

All events within the session carry `parentId` pointing to the `session.start` event. This lets you query "all output from this shell session" or "all events from this agent run" without filtering by time range.

### Agent Integration

An A2A agent is just a process that speaks a structured protocol. The pipe provider with `exec` transport + `jsonl` codec captures agent events natively:

```yaml
sources:
  - name: agent-worker
    provider: pipe
    pipes:
      - transport: { type: exec, command: "node", args: ["agent.js"], cwd: "./agents" }
        codec: { type: jsonl }
        stream: pipe.agent-worker.events
        sourceId: "a2a:worker-1"  # link to the agent's Node in the graph
```

The agent writes JSONL to stdout — each line becomes an event. The `sourceId` links events back to the agent's `a2a.Task` or `a2a.Agent` node, making them queryable via Cypher alongside the entity graph.

Agents that write unstructured text (logs, debug output) use `lines` codec. Agents that speak SSE use `sse` codec. No code change — just config.

### Shell Streaming

Capture shell sessions for audit, replay, or correlation:

```yaml
sources:
  - name: dev-shell
    provider: pipe
    pipes:
      - transport: { type: exec, command: "zsh" }
        codec: { type: lines }
        stream: pipe.shell.dev
```

Or attach to an existing shell's output via file tailing:

```yaml
sources:
  - name: shell-log
    provider: pipe
    pipes:
      - transport: { type: file, path: "/tmp/shell-session.log", follow: true }
        codec: { type: lines }
        stream: pipe.shell.log
```

Shell events are just text lines. But because they flow through the same `hc_events` table, you can correlate them with everything else — "show me the shell output that happened while this agent task was running."

### Pipe Provider Implementation

```typescript
function createPipeProvider(config: { pipes: PipeSource[] }): Provider {
  return {
    name: "pipe",
    nodeTypes: [],
    edgeTypes: [],
    streams: config.pipes.map(p => ({
      name: p.stream,
      provider: "pipe",
    })),

    async *subscribe(stream, options) {
      const pipe = config.pipes.find(p => p.stream === stream);
      if (!pipe) return;

      const source = openTransport(pipe.transport); // returns AsyncIterable<Buffer>
      const parser = createCodec(pipe.codec);       // returns (buf) => Event[]
      const sessionId = `pipe:${stream}:${Date.now()}`;

      yield [{
        id: sessionId,
        stream,
        type: "session.start",
        timestamp: Date.now(),
        attrs: { transport: pipe.transport },
        sourceId: pipe.sourceId,
      }];

      try {
        for await (const chunk of source) {
          const events = parser(chunk).map((e, i) => ({
            ...e,
            id: `${sessionId}:${Date.now()}:${i}`,
            stream,
            parentId: sessionId,
            sourceId: pipe.sourceId,
          }));
          if (events.length) yield events;
        }
      } finally {
        yield [{
          id: `${sessionId}:end`,
          stream,
          type: "session.end",
          timestamp: Date.now(),
          attrs: {},
          parentId: sessionId,
          sourceId: pipe.sourceId,
        }];
      }
    },
  };
}
```

`openTransport` and `createCodec` are the only two functions that vary by source type. Everything else — persistence, indexing, querying, retention, bus routing — is handled by the generic event infrastructure.

---

## Remote Event Sources

Remote APIs (Datadog, Prometheus, etc.) are just pipe sources with HTTP transports or polling loops. They can use the same pipe provider with `tcp`/`http` transport, or implement `subscribe`/`query` directly on a custom provider when the API is too complex for a simple pipe.

```yaml
sources:
  - name: monitoring
    provider: pipe
    pipes:
      - transport: { type: tcp, host: "datadog-agent.local", port: 8125 }
        codec: { type: jsonl }
        stream: pipe.datadog.metrics
        retention: { maxAge: 604800000 }
```

For sources that need authentication, custom pagination, or API-specific semantics, a dedicated provider is still the right call — but it implements the same `streams`/`subscribe`/`query` interface. The pipe provider just eliminates boilerplate for the common case.

---

## Configuration

Streams are configured in `hardcopy.yaml` alongside existing sources:

```yaml
sources:
  - name: github
    provider: github
    orgs: [AprovanLabs]

  - name: agents
    provider: a2a
    endpoint: http://localhost:8080

  - name: local
    provider: pipe
    pipes:
      # Agent process — structured JSONL events
      - transport: { type: exec, command: "node", args: ["agent.js"] }
        codec: { type: jsonl }
        stream: pipe.agent.events
        sourceId: "a2a:worker-1"
        retention: { maxAge: 604800000 }   # 7 days

      # Dev shell capture
      - transport: { type: file, path: "/tmp/dev-shell.log", follow: true }
        codec: { type: lines }
        stream: pipe.shell.dev
        retention: { maxCount: 50000 }

      # Build output
      - transport: { type: exec, command: "pnpm", args: ["dev"] }
        codec: { type: lines }
        stream: pipe.build.dev
        retention: { maxAge: 86400000 }    # 1 day

      # Webhook listener
      - transport: { type: http, port: 9090 }
        codec: { type: jsonl }
        stream: pipe.webhook.inbound
        retention: { maxCount: 10000 }
```

No new top-level config key. Pipes are a property of the `pipe` source, same as links on entity sources.

---

## CLI

```bash
# List active streams
hardcopy streams

# Tail a stream (live)
hardcopy stream tail datadog.alerts

# Query historical events
hardcopy stream query datadog.alerts --since 2h --type alert.triggered

# Start background ingestion for all configured streams
hardcopy stream watch
```

The `watch` command starts the `EventBus`, attaches all provider streams, and runs until interrupted. This is the long-running counterpart to the one-shot `sync` command.

---

## MCP Surface

Extend the existing MCP server with event tools:

```typescript
{
  name: "stream_query",
  description: "Query historical events from a stream",
  inputSchema: {
    type: "object",
    properties: {
      stream: { type: "string" },
      since: { type: "string", description: "Duration like '2h' or ISO timestamp" },
      types: { type: "array", items: { type: "string" } },
      limit: { type: "number", default: 50 },
    },
    required: ["stream"],
  },
}

{
  name: "streams",
  description: "List available event streams and their metadata",
  inputSchema: { type: "object", properties: {} },
}
```

No live subscription over MCP — MCP is request/response. Agents query historical events and get the latest state.

---

## Service Registry Integration

When Hardcopy moves to dynamic providers (following the Patchwork `ServiceRegistry` pattern), event streams register the same way as node providers:

1. A `ServiceBackend` advertises its capabilities — including available streams
2. `ServiceRegistry.registerBackend()` picks up stream declarations alongside tool declarations
3. The `EventBus` auto-attaches to discovered streams

The `Provider` interface already has `streams` as an optional field. A dynamic provider discovered via UTCP or MCP can declare streams in its capability advertisement. The bus treats them identically to statically-configured providers.

No special integration needed — the streaming system is provider-agnostic by design.

---

## Implementation Plan

### Phase 1: Core Primitives
- [ ] Add `Event`, `Stream`, `EventFilter`, `EventPage` types to `types.ts`
- [ ] Add `hc_events` table + indices to `db.ts` schema
- [ ] Add `insertEvents`, `queryEvents`, `pruneEvents` to `HardcopyDatabase`
- [ ] Extend `Provider` interface with optional `streams`, `subscribe`, `query`

### Phase 2: EventBus
- [ ] Implement `EventBus` class in `src/event-bus.ts`
- [ ] Wire into `Hardcopy` core alongside DB and CRDT stores
- [ ] Add `hardcopy stream watch` CLI command
- [ ] Add `hardcopy stream tail` and `hardcopy stream query` commands

### Phase 3: Views + MCP
- [ ] Extend view config to support event correlation (`events` key in view YAML)
- [ ] Add `stream_query` and `streams` MCP tools
- [ ] Add event rendering to view refresh pipeline

### Phase 4: Pipe Provider
- [ ] Implement `openTransport` for `exec`, `file`, `socket` transports
- [ ] Implement `createCodec` for `lines`, `jsonl`, `sse` codecs
- [ ] Session lifecycle events (`session.start`, `session.end`)
- [ ] `http` transport (webhook listener)
- [ ] `tcp` transport

### Phase 5: Agent & Shell Integration
- [ ] Wire A2A agent process as `exec` + `jsonl` pipe source
- [ ] Shell session capture via `exec` or `file` pipe source
- [ ] Correlate pipe events with A2A/Git nodes via `sourceId`
- [ ] Example: query agent events alongside linked GitHub issues

### Phase 6: Embeddability
- [ ] Validate libSQL WASM builds with `hc_events` queries
- [ ] Document browser consumption via embedded replicas
- [ ] Optional WebSocket relay for live subscriptions in browser contexts
