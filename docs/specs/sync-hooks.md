Hardcopy syncs remote resources to a local graph database on a polling interval. Currently, sync is fire-and-forget — nodes are upserted, but nothing reacts to *what changed*. I want a system where config-defined hooks fire in response to node-level changes detected during sync.

The motivating use case: when a GitHub issue is created in `AprovanLabs/projects` with label `plan`, spawn a Claude agent worktree session with a planning prompt. When an issue transitions from *not* having the `implement` label to having it, spawn a different Claude session with an execution prompt that updates the ticket with progress.

Constraints:
- Hooks must be config-driven (in `hardcopy.yaml`)
- Change detection must be generic — not GitHub-specific
- The system must distinguish between "node created", "node updated", and fine-grained field transitions (label added, state changed, etc.)
- Hook execution is a shell command with template substitution — hardcopy doesn't need to know about Claude specifically

---

## Plan

### 1. Change detection during sync

Sync currently calls `db.upsertNodes()` in bulk. To detect changes, sync needs to compare incoming nodes against their prior state *before* upserting.

Add a `diffNodes` step to the sync pipeline:

```
for each incoming node:
  prior = db.getNode(node.id)
  if prior is null → change type is "created"
  else → diff prior.attrs vs node.attrs → produces Change[]
  if Change[] is non-empty → change type is "updated"
```

This produces a `NodeChange` per affected node:

```typescript
interface NodeChange {
  node: Node;
  prior: Node | null;
  type: "created" | "updated";
  changes: Change[];  // reuses existing Change type (field, oldValue, newValue)
}
```

The diff uses the existing `Change` interface from `types.ts`. For array fields like `labels`, the diff produces a single change entry where `oldValue` and `newValue` are the full arrays — hook matchers handle the set-difference logic.

`sync()` and `syncSource()` return `NodeChange[]` on `SyncStats` so downstream consumers (hooks, events, CLI) can use them.

### 2. Hook configuration in `hardcopy.yaml`

Add a top-level `hooks` array to the config:

```yaml
hooks:
  - name: plan-on-issue
    on:
      type: github.Issue
      source: projects          # optional: restrict to a named source
      created: true             # fires on node creation
      match:                    # attribute conditions (all must match)
        labels:
          contains: plan
        repository: AprovanLabs/projects

    run: |
      claude --worktree --prompt "$(cat docs/prompts/plan.md)" \
        --context "Issue #{{attrs.number}}: {{attrs.title}}\n\n{{attrs.body}}"

  - name: implement-on-label
    on:
      type: github.Issue
      source: projects
      updated: true
      transition:               # field transition conditions
        labels:
          added: implement      # "implement" was not in old, is in new
      match:
        repository: AprovanLabs/projects

    run: |
      claude --worktree --prompt "$(cat docs/prompts/implement.md)" \
        --context "Issue #{{attrs.number}}: {{attrs.title}}\n\n{{attrs.body}}" \
        --notify-url "https://api.github.com/repos/{{attrs.repository}}/issues/{{attrs.number}}/comments"

  - name: investigate
    run: |
      gemini --prompt "$(cat docs/prompts/implement.md)"
```

#### Config schema

```typescript
interface HookConfig {
  name: string;
  on: HookTrigger;
  run: string;
  cwd?: string;          // working directory, defaults to project root
  env?: Record<string, string>;
  background?: boolean;  // default true — don't block sync
}

interface HookTrigger {
  type: string;           // node type to match
  source?: string;        // restrict to named source
  created?: boolean;      // fire on new nodes
  updated?: boolean;      // fire on changed nodes
  match?: Record<string, MatchCondition>;      // attribute filters
  transition?: Record<string, TransitionCondition>; // field change filters
}

type MatchCondition =
  | string | number | boolean           // exact match
  | { contains: string }                // array contains value
  | { pattern: string };                // regex match

type TransitionCondition =
  | { added: string }                   // value entered array field
  | { removed: string }                 // value left array field
  | { from: unknown; to: unknown };     // exact field transition
```

### 3. Hook evaluation engine

A `HookRunner` takes the list of `HookConfig` from config and a batch of `NodeChange[]` from sync, and determines which hooks to fire.

```
for each NodeChange:
  for each HookConfig:
    if trigger matches change → execute hook
```

**Trigger matching logic:**

1. **Type check** — `change.node.type === trigger.type`
2. **Source check** — if `trigger.source`, verify the change came from that source
3. **Created/updated** — `trigger.created` matches `change.type === "created"`, `trigger.updated` matches `change.type === "updated"`. If both are true, either fires.
4. **Match conditions** — each key in `trigger.match` is checked against `change.node.attrs`:
   - Exact: `attrs[key] === value`
   - `contains`: `Array.isArray(attrs[key]) && attrs[key].includes(value)`
   - `pattern`: `new RegExp(value).test(String(attrs[key]))`
5. **Transition conditions** — each key in `trigger.transition` is checked against `change.changes`:
   - `added`: find the Change for that field, check that `newValue` array contains the value and `oldValue` array does not
   - `removed`: inverse of `added`
   - `from/to`: exact match on `oldValue` and `newValue`

All conditions are AND — every specified condition must match for the hook to fire.

### 4. Template substitution in `run`

The `run` string supports `{{...}}` template expressions resolved against the node:

| Template | Resolves to |
|----------|-------------|
| `{{id}}` | `node.id` |
| `{{type}}` | `node.type` |
| `{{attrs.field}}` | `node.attrs.field` (JSON-stringified if object/array) |
| `{{prior.field}}` | `prior.attrs.field` (null if created) |
| `{{changes}}` | JSON array of Change objects |
| `{{source}}` | source name |

The same template engine used by format render paths (`{{attrs.field}}` substitution) should be reused.

### 5. Hook execution

Hooks run as child processes via `spawn`:

- **Background** (default): fire-and-forget, stdout/stderr logged to `.hardcopy/hooks/{name}-{timestamp}.log`
- **Foreground** (`background: false`): sync blocks until the hook exits. Non-zero exit code is a sync error.
- **Environment**: hook process inherits `process.env`, merged with `hook.env`, plus injected `HC_NODE_ID`, `HC_NODE_TYPE`, `HC_CHANGE_TYPE`, `HC_SOURCE`.
- **Deduplication**: a running hook for the same `{name, nodeId}` pair is not re-spawned. Track active hooks in a `Map<string, ChildProcess>`.

### 6. Integration points

**Sync pipeline** (`src/hardcopy/sync.ts`):
- Before `db.upsertNodes()`, batch-fetch prior nodes via `db.getNodesByIds()`
- Compute `NodeChange[]` by diffing prior vs incoming
- After upserting, pass `NodeChange[]` to `HookRunner.evaluate()`
- Attach `NodeChange[]` to `SyncStats`

**Config** (`src/config.ts`, `src/types.ts`):
- Add `hooks?: HookConfig[]` to `Config`
- Validate hook configs in `validateConfig()`

**EventBus integration**:
- Hook fires can optionally emit events to the `hardcopy.hooks` stream:
  ```
  { type: "hook.fired", attrs: { hook: name, nodeId, changeType }, sourceId: nodeId }
  { type: "hook.completed", attrs: { hook: name, exitCode }, sourceId: nodeId }
  { type: "hook.failed", attrs: { hook: name, error }, sourceId: nodeId }
  ```
- This is additive — hooks work without the EventBus, but if it's initialized, lifecycle events are emitted.

### 7. File structure

```
src/
  hooks/
    index.ts          # HookRunner class, evaluate + execute
    match.ts          # trigger matching logic (matchCondition, transitionCondition)
    template.ts       # {{...}} substitution (extract from format.ts if shared)
    diff.ts           # diffNodes(prior, incoming) → NodeChange[]
```

### 8. CLI surface

`hardcopy sync` and `hardcopy sync --watch` gain hook evaluation automatically. No new commands needed.

`hardcopy status` shows active hook processes (from the dedup map) and recent hook log entries.

### 9. Validating the use case

With this system, the two motivating scenarios work as follows:

**Issue created with `plan` label:**
1. `sync --watch` polls `AprovanLabs/projects` on interval
2. New issue appears → `diffNodes` produces `NodeChange { type: "created" }`
3. `plan-on-issue` hook: `type` matches `github.Issue`, `created: true` matches, `match.labels.contains: plan` checks `attrs.labels` → match
4. Template substitution fills in issue number, title, body
5. Claude worktree session spawns in background

**Issue gains `implement` label:**
1. Next sync poll fetches updated issue
2. `diffNodes` sees labels changed from `["plan"]` to `["plan", "implement"]` → `NodeChange { type: "updated", changes: [{ field: "labels", oldValue: ["plan"], newValue: ["plan", "implement"] }] }`
3. `implement-on-label` hook: `updated: true` matches, `transition.labels.added: implement` checks that `implement` is in newValue but not oldValue → match
4. Different Claude session spawns with execution prompt

### 10. Implementation order

1. `src/hooks/diff.ts` — `diffNodes()` function, `NodeChange` type
2. Wire diff into `sync.ts` — compute changes before upsert, attach to `SyncStats`
3. `src/hooks/match.ts` — trigger matching logic
4. `src/hooks/template.ts` — template substitution
5. `src/hooks/index.ts` — `HookRunner` class (evaluate + spawn)
6. Config types + validation for `hooks`
7. Wire `HookRunner` into sync pipeline
8. EventBus integration (hook lifecycle events)
