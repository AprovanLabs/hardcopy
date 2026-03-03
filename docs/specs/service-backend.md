# Service Backend

Hardcopy currently exposes service functionality by manually integrating providers.

We need move to a world where we don't have to manage integrations. This should take the form of:

- Following the service registry pattern defined in Patchwork, where we abstract away the backing source of services (may be backed by UTCP, another service source, a combination...).
- Integrating with 3rd party open source data connections
- Sharing the service abstraction layer between Hardcopy and Patchwork rather than duplicating it

We must expose strong methods for managing types consistently between services with isolation between namespaces and methods for handling collisions. We want to add more services without corrupting existing data, of course.

Whatever solution, we want it to be flexible, generic, with strong abstractions and module isolation.

---

## Current State

### Hardcopy

A global `Map<string, ProviderFactory>` in `provider.ts` with side-effect imports wired through `providers.ts`. Each concrete provider (GitHub, A2A, Git) self-registers at import time and implements the full `Provider` interface:

```
Provider { name, nodeTypes, edgeTypes, fetch, push, fetchNode, getTools }
```

Adding a provider requires modifying `providers.ts`, the format registry in `hardcopy/index.ts`, and possibly the MCP server's static tool list. There is no collision detection, no tool discovery, no abstract backend layer.

Service configuration lives entirely in `hardcopy.yaml` — each source declares its own provider type, endpoint, orgs, repos, links, etc.

### Patchwork

`ServiceBackend` is defined independently in two places:
- `@aprovan/patchwork` (`services/proxy.ts`) — client-side, with caching/batching
- `@aprovan/stitchery` (`server/services.ts`) — server-side, alongside `ServiceRegistry`

Both define the same interface: `{ call(service, procedure, args): Promise<unknown> }`.

`ServiceRegistry` exists only in Stitchery. It handles MCP tool registration, UTCP backend integration, namespace management, tool metadata, search/discovery, and LLM name mapping. Service configuration is owned by Stitchery's `ServerConfig` (MCP servers, UTCP endpoints, etc.), not by consuming applications.

`@aprovan/patchwork-utcp` bridges UTCP to `ServiceBackend` and depends on `@aprovan/patchwork` for the interface type.

**Key problem:** `ServiceBackend` is duplicated. `ServiceRegistry` is coupled to Stitchery's server. There is no shared package that both Hardcopy and Patchwork can import these abstractions from.

---

## Plan

### 1. Extract shared service abstractions into Stitchery

Stitchery already contains `ServiceBackend`, `ServiceToolInfo`, `ServiceRegistry`, and `generateServicesPrompt`. It's the natural home for the shared abstraction layer. The work is to clean the boundary:

**Move to `@aprovan/stitchery` (or a dedicated sub-export `@aprovan/stitchery/services`):**
- `ServiceBackend` interface
- `ServiceToolInfo` interface
- `ServiceRegistry` class
- `SearchServicesOptions`
- `generateServicesPrompt`

**Deduplicate in `@aprovan/patchwork`:**
- Remove the local `ServiceBackend` definition from `services/proxy.ts`
- Re-export `ServiceBackend` from `@aprovan/stitchery`
- The caching proxy layer stays in `@aprovan/patchwork` — it wraps any `ServiceBackend`

**Update `@aprovan/patchwork-utcp`:**
- Peer-depend on `@aprovan/stitchery` instead of (or alongside) `@aprovan/patchwork` for the `ServiceBackend` type

This gives us a single source of truth: `@aprovan/stitchery` owns the service abstraction, everyone else imports from it.

### 2. Stitchery owns service configuration

Service backends (UTCP endpoints, MCP servers, HTTP services) should be configured once in Stitchery, not re-declared per consumer. Hardcopy connects to a `ServiceRegistry` and references services by namespace — it doesn't need to know _how_ a service is reached.

Two connection modes:

**In-process** — Hardcopy instantiates a `ServiceRegistry` directly and loads a shared service config. This is the default for CLI usage where no Stitchery server is running.

**Remote** — Hardcopy connects to a running Stitchery server via its HTTP proxy API (`POST /api/proxy/:namespace/:procedure`). A thin `ServiceBackend` implementation that forwards `call()` over HTTP.

In both cases, the service topology (which UTCP endpoints exist, which MCP servers to spawn) is defined in a Stitchery config — not in `hardcopy.yaml`.

### 3. Simplify `hardcopy.yaml` to reference services

`hardcopy.yaml` stops declaring backend details. Sources reference a service namespace and add Hardcopy-specific concerns only (views, links, render templates):

```yaml
services: ./services.yaml   # shared Stitchery config, or a Stitchery server URL

sources:
  - name: github
    service: github          # namespace in the registry
    orgs: [AprovanLabs]
    repos: [JacobSampson/kossabos]

  - name: agents
    service: a2a
    links:
      - edge: a2a.TRACKS
        to: github.Issue
        match: "github:{{task.meta.github.repository}}#{{task.meta.github.issue_number}}"

  - name: git
    service: git
    repositories:
      - path: /Users/jsampson/Documents/JacobSampson/kossabos
    links:
      - edge: git.TRACKS
        to: a2a.Task
        match: "a2a:{{branch.meta.a2a.task_id}}"
```

The `services` field points to either:
- A path to a Stitchery-format config file (for in-process registry creation)
- A URL to a running Stitchery server (for remote mode)

This eliminates `provider:` and `endpoint:` from source declarations. Sources that need provider-specific config (like `orgs`, `repositories`) still carry those as source-level fields — the registry resolves _how_ to call the service, the source config tells it _what_ to ask for.

### 4. Adapt Hardcopy providers as `ServiceBackend` implementations

Each existing provider wraps its `fetch`/`push`/`fetchNode` behind `ServiceBackend.call`:

| Procedure | Maps to |
|-----------|---------|
| `fetch` | `provider.fetch(args[0])` |
| `push` | `provider.push(args[0], args[1])` |
| `fetchNode` | `provider.fetchNode(args[0])` |
| Provider-specific tools | `provider.getTools()` entries |

A generic `ProviderBackend` adapter handles this mapping. Individual providers don't change. They register into the shared `ServiceRegistry` as backends under their namespace.

### 5. Enforce namespace isolation

Formalize the existing `namespace.Type` / `namespace:id` conventions as enforced constraints at the registry level:

- Node types and edge types are validated on registration to belong to their declared namespace.
- Node IDs must be prefixed with the provider's namespace.
- Cross-namespace edges are permitted but must reference valid target namespaces.
- Collision on namespace during registration is an error.

This logic lives in Stitchery's `ServiceRegistry` so it's shared across all consumers.

### 6. Dynamic MCP tool exposure

Replace the static MCP tool list in `mcp-server.ts` with a pass-through from the registry:

- On init, query `registry.searchTools()` and expose each as an MCP tool.
- Provider-specific tools (from `getTools()`) surface automatically.
- The `search_services` meta-tool (already in Stitchery) is reused.

### 7. External services via UTCP (no new code)

Because Hardcopy now consumes `ServiceRegistry`, and `ServiceRegistry` already integrates with `@aprovan/patchwork-utcp`, Hardcopy gains UTCP support for free. Adding a new external service means updating the shared Stitchery config — Hardcopy picks it up via namespace reference.

---

## Package Dependency Graph

```
@aprovan/stitchery          ← owns ServiceBackend, ServiceRegistry, ServiceToolInfo
  ├── @aprovan/patchwork-utcp  ← UTCP → ServiceBackend adapter
  │     └── @aprovan/stitchery (peer: ServiceBackend type)
  └── @ai-sdk/mcp             ← MCP tool loading

@aprovan/patchwork           ← re-exports ServiceBackend from stitchery
  └── @aprovan/stitchery       ← import { ServiceBackend }

@aprovan/hardcopy            ← consumes ServiceRegistry
  └── @aprovan/stitchery       ← import { ServiceRegistry, ServiceBackend }
```

---

## Implementation Order

1. **Clean Stitchery exports** — ensure `ServiceBackend`, `ServiceToolInfo`, `ServiceRegistry` are exported from a stable sub-path (`@aprovan/stitchery` or `@aprovan/stitchery/services`). No new code, just export hygiene.
2. **Deduplicate `ServiceBackend`** — remove from `@aprovan/patchwork`, re-export from Stitchery. Update `@aprovan/patchwork-utcp` peer dep.
3. **`ProviderBackend` adapter in Hardcopy** — wraps existing `Provider` as `ServiceBackend`. Existing providers untouched.
4. **Wire `Hardcopy` to `ServiceRegistry`** — replace `_providers` map and `initializeProviders`. Add `@aprovan/stitchery` dependency. Support both in-process and remote registry modes.
5. **Simplify `hardcopy.yaml`** — replace `provider:` with `service:`, add `services:` top-level field, migrate config.
6. **Namespace validation** — add invariant checks in `ServiceRegistry` on registration.
7. **Dynamic MCP exposure** — rewrite `mcp-server.ts` to source tools from registry.
8. **Remove legacy wiring** — delete `providers.ts` barrel, `provider.ts` global map, provider self-registration calls.

## Non-Goals

- Changing the graph data model (`Node`, `Edge`, `FetchResult`, etc.)
- Rewriting existing provider logic (GitHub, A2A, Git internals stay the same)
- Reimplementing the format/conflict systems — they continue to work against `Node` objects regardless of backing source
- Building a new package — Stitchery already exists and already contains the right abstractions
