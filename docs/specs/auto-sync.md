Hardcopy currently waits for manual intervention to sync with 3rd party datasources. I'd like to abstract away the syncing process as much as possible.

However, we have these course constraints:
- We do NOT want to overload 3rd party APIs
- We MUST have a way to fetch and update data in an efficient way.
- We must have clear ways to indicate to the user freshness of data, sync intervals, and the like

---

## Plan

### 1. Source-level sync policy (config-driven)

Add an optional `sync` block to each source in `hardcopy.yaml`:

```yaml
sources:
  - name: aprovan
    provider: github
    sync:
      interval: 300        # seconds between fetches (default: manual-only)
      strategy: incremental # "full" | "incremental" (default: full)
```

- `interval` — minimum seconds between automatic fetches. `0` or omitted = manual only.
- `strategy` — how the provider should fetch.

A new `SyncPolicy` type captures this in config parsing. Views inherit freshness from their source nodes' `syncedAt` timestamps — no separate view-level policy needed.

### 2. Incremental fetch via provider contract

Extend `FetchRequest` / `FetchResult` to support delta fetches:

- Pass the source's last `versionToken` and `syncedAt` to the provider on every fetch.
- Providers decide how to use these hints. GitHub can translate `syncedAt` into a `since` query param and use ETags. Git already short-circuits via HEAD commit. A2A can filter by updated timestamp.
- `FetchResult.cached` already exists — if true, skip DB writes entirely.

No new interface methods. The existing `fetch()` contract is sufficient; providers just become smarter about what they return.

### 3. Rate limiting at the provider layer

Add a generic `RateLimiter` utility that wraps outbound requests:

- Token-bucket algorithm, configurable per-provider via defaults (e.g., GitHub: 5000 req/hr).
- Providers acquire a token before each API call. If exhausted, the fetch is deferred and marked `cached: true` with no data.
- Reads `X-RateLimit-Remaining` / `Retry-After` headers from responses to self-tune.

This lives in `src/rate-limit.ts` and is injected into providers at construction time via the factory config. Providers that don't need it (e.g., Git, which is local) skip it.

### 4. Sync scheduler

A `SyncScheduler` class manages timed syncs:

- On `hardcopy sync --watch` (or `hardcopy daemon`), it starts an interval loop.
- Each tick, it iterates sources whose `interval` has elapsed since their last `syncedAt`.
- Calls the existing `Hardcopy.syncSource()` for each eligible source, sequentially per source to avoid overlap.
- After syncing, refreshes any views whose underlying nodes changed.
- Respects the rate limiter — if a source is rate-limited, it skips and retries next tick.

Runs in-process (no separate daemon). The tick interval is the GCD of configured source intervals, floored at 30s.

### 5. Freshness metadata — make existing fields useful

The `IndexState.ttl` and `IndexState.lastFetch` fields are already written but never read. Wire them up:

- `ttl` is derived from the source's `sync.interval` (or a sensible default for manual sources).
- `lastFetch` is the ISO timestamp of the most recent sync for nodes in that view.
- On `hardcopy refresh`, check if `Date.now() - lastFetch < ttl`. If fresh, skip re-render unless `--force` is passed.
- Rendered Markdown files include a `synced_at` frontmatter field so users can see staleness at a glance.

### 6. CLI surface

| Command | Behavior |
|---|---|
| `hardcopy sync` | One-shot sync (unchanged, but now respects `strategy`) |
| `hardcopy sync --watch` | Starts the scheduler loop, syncs + refreshes on interval |
| `hardcopy status` | Shows per-source last sync time, staleness, rate-limit headroom |

### Implementation order

1. `SyncPolicy` config type + parsing
2. `RateLimiter` utility
3. Incremental fetch support in GitHub provider (ETag + `since`)
4. Wire `IndexState.ttl` / `lastFetch` into refresh skip logic
5. `SyncScheduler` + `--watch` flag
6. `hardcopy status` command

