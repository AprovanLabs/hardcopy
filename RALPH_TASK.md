# Patchwork + Hardcopy + Apprentice Consolidation

IMPLEMENT ONLY HARDCOPY FUNCTIONALITY

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

> **Specs:** [docs/specs](docs/specs/)

## Apprentice Refactor (OUT OF SCOPE)

> Spec: [apprentice-refactor.md](docs/specs/apprentice-refactor.md)
> **Status:** Not in current scope - task says "IMPLEMENT ONLY HARDCOPY FUNCTIONALITY"

### Phase A1: Add EntityGraph

- Add `entities` table to DB schema
- Add `entity_links` table to DB schema
- Implement `EntityGraph` interface
- Merge `assets` as entities with `file:` URI scheme
- Merge `events` as entities with `event:` URI scheme
- Add URI utilities: `parseUri`, `formatUri`, `normalizeUri`

### Phase A2: Upgrade EventBus

- Refactor `events` table to match `Envelope` schema
- Add in-memory subscription registry
- Add filter matching (types, sources, subjects with wildcards)
- Integrate EventBus with EntityGraph

### Phase A3: Add Orchestrator

- Add `sessions` table
- Implement `SessionManager`
- Implement `Orchestrator` with event routing
- Add concurrency control (`maxConcurrent` with queue)
- Add pluggable `ExternalNotifier` interface

### Phase A4: Export Package

- Export `EntityGraph`, `Entity`, `EntityLink`, `EntityFilter`
- Export `EventBus`, `Envelope`, `EventFilter`, `Subscription`
- Export `Orchestrator`, `Session`, `SessionManager`
- Export `SearchEngine`, `SearchResult`
- Export `createApprentice`, `ApprenticeConfig`

---

## Patchwork Refactor (OUT OF SCOPE)

> Spec: [patchwork-refactor.md](docs/specs/patchwork-refactor.md)
> **Status:** Not in current scope - task says "IMPLEMENT ONLY HARDCOPY FUNCTIONALITY"

### Phase B1: Remove Duplicated Modules

- Delete `packages/events/` (use `@aprovan/apprentice`)
- Delete `packages/graph/` (use `@aprovan/apprentice`)
- Delete `packages/orchestrator/` (use `@aprovan/apprentice`)

### Phase B2: Simplify ServiceRegistry

- Remove `utcp` source type and related code
- Remove `grpc` (not implemented)
- Simplify to MCP spawn + HTTP fetch + local function
- Keep caching with TTL and event-based invalidation

### Phase B3: Refactor SkillRegistry

- Remove `SkillExecutor` from registry
- Make registry purely for discovery and trigger matching
- Skills reference services by namespace

### Phase B4: Wire Stitchery to Apprentice

- Update `unified.ts` to use Apprentice runtime
- Wire `ServiceRegistry` to Apprentice db/eventBus
- Wire `SkillRegistry` to Apprentice entityGraph
- Set skill resolver on orchestrator
- Set tool executor on orchestrator

### Phase B5: Update apps/chat

- Chat messages → `eventBus.publish()` as `chat.message.sent`
- LLM responses → `eventBus.publish()` as `llm.{sessionId}.chunk`
- Tool calls → `serviceRegistry.call()`
- Entity references → `entityGraph.get()` + `traverse()`

---

## Hardcopy Refactor

> Spec: [hardcopy-refactor.md](docs/specs/hardcopy-refactor.md)

### Phase C1: Remove Duplicated Modules

- [x] Delete `src/events/` (use `@aprovan/apprentice`)
- [x] Delete `src/graph/` (use `@aprovan/apprentice`)
- [x] Delete `src/orchestrator/` (use `@aprovan/apprentice`)
- [x] Delete `src/services/` (use `@patchwork/services`)
- [x] Delete `src/skills/` (use `@patchwork/skills`)

### Phase C2: Simplify Provider to SyncAdapter

- [x] Remove `nodeTypes`, `edgeTypes`, `streams`, `subscribe`, `query` from Provider
- [x] Implement `SyncAdapter` interface (fetch/push/canHandle)
- [x] SyncAdapter handles URI scheme routing

### Phase C3: Convert Contribs to Skills

- [x] Delete `src/contrib/github.ts`
- [x] Delete `src/contrib/jira.ts`
- [x] Delete `src/contrib/stripe.ts`
- [x] Create example skills in `skills/` directory

### Phase C4: Core Sync Engine

- [x] Implement `diff(local, remote)` → `Change[]`
- [x] Implement `merge(local, remote, strategy)` → `Entity`
- [x] Implement `renderView(entity, format)` → `string`
- [x] Implement `parseView(content, format)` → `Partial<Entity>`

### Phase C5: Expose as Service

- [x] Create `src/service.ts`
- [x] Register `hardcopy.fetch` procedure
- [x] Register `hardcopy.push` procedure
- [x] Register `hardcopy.diff` procedure
- [x] Register `hardcopy.sync` procedure

---

## Integration (OUT OF SCOPE - Requires Apprentice/Patchwork)

> Spec: [architecture-overview.md](docs/specs/architecture-overview.md)
> **Status:** Blocked until Apprentice/Patchwork phases are implemented

### Test Checklist (Future)

- Chat message creates event with correct type/source/subject
- Orchestrator matches skill by trigger
- Skill can call Hardcopy service
- Hardcopy delegates to provider skill
- Entity stored in graph with correct URI
- Subsequent requests use cached entity
- Push flow works (user says "close this issue")
- Events visible in Apprentice search

### Implementation Steps

- [x] Create `skills/github-assistant/SKILL.md` with chat trigger
- [x] Create `skills/github-sync/SKILL.md` with sync logic

**Remaining (blocked on Apprentice/Patchwork):**
- Register Hardcopy as local service in Stitchery
- Wire chat UI to publish/subscribe events
- Test full flow with real GitHub issue
