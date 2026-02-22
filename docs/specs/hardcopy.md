# Hardcopy: Local-Remote Sync System

## Overview

Hardcopy synchronizes remote resources (GitHub, Jira, Google Docs, A2A agents, Git) to a local file tree with bi-directional editing. Uses a graph database for relationships and CRDT for conflict-free merges.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                         Providers                                │
│  github │ jira │ linear │ a2a │ git │ gdocs │ confluence        │
└────────────────────────┬────────────────────────────────────────┘
                         │ fetch / push
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    LibSQL + GraphQLite                           │
│         (Node/Edge attributes, sync state, pagination)           │
└────────────────────────┬────────────────────────────────────────┘
                         │
          ┌──────────────┴──────────────┐
          ▼                             ▼
┌──────────────────┐          ┌──────────────────────────────────┐
│   CRDT Store     │          │        File Tree                  │
│ (Loro snapshots) │          │  (Markdown bodies, blobs, diffs)  │
└──────────────────┘          └──────────────────────────────────┘
```

### Storage Split

| Data Type | Storage Location | Rationale |
|-----------|------------------|-----------|
| Node attributes (title, state, labels) | LibSQL | Fast queries, indexes |
| Edge relationships | LibSQL (GraphQLite) | Graph traversal |
| Sync state (version tokens, cursors) | LibSQL | Durability |
| Document bodies (Markdown, rich text) | File tree | Editable, diffable |
| CRDT snapshots (per-node) | `.hardcopy/crdt/{node_id}` | Granular conflict resolution |
| Binary blobs | File tree | Direct access |

### CRDT Strategy: Per-Node

Each node gets its own CRDT document stored at `.hardcopy/crdt/{encoded_node_id}.loro`. This enables:
- Granular sync — only changed nodes need conflict resolution
- Independent versioning — nodes sync at different rates
- Isolated failures — one conflict doesn't block others

Tradeoff: more files, but nodes are typically small and compression helps.

---

## Namespaced Types

Types and relationships are namespaced by provider to avoid collisions:

```
github.Issue          # GitHub issue
jira.Issue            # Jira issue  
linear.Issue          # Linear issue
a2a.Task              # Agent task
git.Branch            # Git branch
git.Worktree          # Git worktree
gdocs.Document        # Google Doc
```

### Edge Types (also namespaced)

```
github.ASSIGNED_TO    # Issue -> User
github.HAS_LABEL      # Issue -> Label
github.REFERENCES     # Issue -> Issue (cross-reference)
a2a.TRACKS            # Task -> github.Issue
git.TRACKS            # Branch -> a2a.Task
```

### Cross-Provider Links

```cypher
-- Agent task linked to GitHub issue, tracked by Git branch
MATCH (t:a2a.Task)-[:a2a.TRACKS]->(i:github.Issue)
MATCH (b:git.Branch)-[:git.TRACKS]->(t)
RETURN t, i, b
```

---

## Query Engine: GraphQLite on LibSQL

Use [graphqlite](https://github.com/colliery-io/graphqlite) SQLite extension on LibSQL for embedded graph queries.

### Schema

```sql
-- Nodes table (all types)
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,           -- "github:owner/repo#42"
  type TEXT NOT NULL,            -- "github.Issue"
  attrs JSONB NOT NULL,          -- { title, state, labels, ... }
  synced_at INTEGER,             -- Unix timestamp
  version_token TEXT,            -- Provider-managed cache/version token
  cursor TEXT                    -- Pagination cursor for children
);

CREATE INDEX idx_nodes_type ON nodes(type);
CREATE INDEX idx_nodes_synced ON nodes(synced_at);

-- Edges table
CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,            -- "github.ASSIGNED_TO"
  from_id TEXT NOT NULL REFERENCES nodes(id),
  to_id TEXT NOT NULL REFERENCES nodes(id),
  attrs JSONB,                   -- Edge properties
  UNIQUE(type, from_id, to_id)
);

CREATE INDEX idx_edges_from ON edges(from_id);
CREATE INDEX idx_edges_to ON edges(to_id);
CREATE INDEX idx_edges_type ON edges(type);
```

### Query Translation

GraphQLite provides Cypher-like syntax over SQLite:

```cypher
-- Find my open tasks with linked issues and branches
MATCH (t:a2a.Task {status: 'in-progress'})
MATCH (t)-[:a2a.TRACKS]->(i:github.Issue {state: 'open'})
OPTIONAL MATCH (b:git.Branch)-[:git.TRACKS]->(t)
WHERE i.attrs->>'assignee' = $me
RETURN t, i, b
```

---

## POC Config

```yaml
# hardcopy/hardcopy.yaml
sources:
  - name: github
    provider: github
    orgs: [AprovanLabs, JacobSampson]
    
  - name: agents
    provider: a2a
    # Populated by A2A protocol - tracks agent execution, tasks, progress
    # Links to GitHub issues via explicit task metadata
    links:
      - edge: a2a.TRACKS
        to: github.Issue
        # Task metadata includes github.issue_number and github.repository
        match: "github:{{task.meta.github.repository}}#{{task.meta.github.issue_number}}"
    
  - name: git
    provider: git
    repositories:
      - path: ~/AprovanLabs/**
    # Explicit linking config — don't rely on branch naming conventions
    links:
      - edge: git.TRACKS
        to: a2a.Task
        # Option 1: Parse from branch name (if convention is used)
        # match: "a2a:{{branch.name | regex_extract: 'task-([0-9]+)'}}"
        # Option 2: Use A2A session metadata (preferred)
        match: "a2a:{{branch.meta.a2a.task_id}}"

views:
  - path: my-tasks
    description: "Open agent tasks with linked GitHub issues and Git branches"
    query: |
      MATCH (t:a2a.Task)
      WHERE t.attrs->>'status' <> 'completed'
      MATCH (t)-[:a2a.TRACKS]->(i:github.Issue)
      WHERE i.attrs->>'state' = 'open'
        AND i.attrs->>'assignee' = $me
      OPTIONAL MATCH (b:git.Branch)-[:git.TRACKS]->(t)
      RETURN t, i, b
      ORDER BY t.attrs->>'updated_at' DESC

    partition:
      by: b.attrs->>'name'
      fallback: _untracked

    render:
      - path: status.md
        template: |
          # {{t.attrs.name}}
          
          **Status:** {{t.attrs.status}}
          **Branch:** {{b.attrs.name | default: "No branch"}}
          
          ## Linked Issue
          - [#{{i.attrs.number}}]({{i.attrs.url}}) {{i.attrs.title}}
          
      - path: "{{i.attrs.number}}.github.issue.md"
        type: github.issue
        
      - path: diff.patch
        type: git.diff
        args:
          ref: "{{b.attrs.name}}"
          base: HEAD

  - path: zolvery
    description: "Open issues in zolvery repo"
    query: |
      MATCH (i:github.Issue)
      WHERE i.attrs->>'repository' = 'zolvery'
        AND i.attrs->>'state' = 'open'
      RETURN i
      ORDER BY i.attrs->>'updated_at' DESC
      
    render:
      - path: "{{i.attrs.number}}.github.issue.md"
        type: github.issue
```

---

## Lazy Loading Strategy

### File Tree as Discovery Mechanism

```
hardcopy/
├── hardcopy.yaml
├── .hardcopy/
│   ├── db.sqlite          # LibSQL database
│   └── crdt/              # CRDT snapshots
├── my-tasks/              # View directory (metadata only until opened)
│   ├── .index             # Pagination state, total count
│   ├── feature/
│   │   └── auth-refactor/
│   │       ├── status.md
│   │       ├── 123.github.issue.md
│   │       └── diff.patch
│   └── feature/
│       └── new-api/
│           └── ...
└── zolvery/
    ├── .index             # { cursor: "abc", total: 47, loaded: 10 }
    ├── 101.github.issue.md
    ├── 102.github.issue.md
    └── ...                # Only first page loaded
```

### Loading Behavior

1. **View directory exists** → Show folders from cached index, don't fetch
2. **User opens folder** → Fetch first page of children, create `.index`
3. **User scrolls/requests more** → Load next page, update cursor
4. **TTL expires** → Re-fetch on next access, merge with CRDT

### Index File

```yaml
# zolvery/.index
cursor: "Y3Vyc29yOnYyOpK5MjAyNi0wMi0yMVQxMDowMDowMFo"
total: 47
loaded: 10
page_size: 10
last_fetch: 2026-02-21T10:30:00Z
ttl: 300  # seconds
```

---

## Bi-Directional Sync

### Sync Flow

```
┌─────────────┐    edit    ┌─────────────┐    save    ┌─────────────┐
│  File Tree  │ ─────────> │ CRDT Merge  │ ─────────> │   Decide    │
└─────────────┘            └─────────────┘            └──────┬──────┘
                                                             │
                           ┌─────────────────────────────────┼─────────────────────────────────┐
                           │                                 │                                 │
                           ▼                                 ▼                                 ▼
                    ┌─────────────┐                  ┌─────────────┐                  ┌─────────────┐
                    │  API Push   │                  │ LLM Resolve │                  │ User Alert  │
                    │  (auto)     │                  │ (via UTCP)  │                  │ (conflict)  │
                    └─────────────┘                  └─────────────┘                  └─────────────┘
```

### Decision Logic

```typescript
interface SyncDecision {
  strategy: 'auto' | 'llm' | 'manual';
  reason: string;
}

function decideSyncStrategy(
  localCRDT: Loro,
  remoteCRDT: Loro,
  provider: Provider
): SyncDecision {
  // 1. Try CRDT merge
  const merged = localCRDT.fork();
  merged.import(remoteCRDT.export({ mode: 'update' }));
  
  // 2. Check for conflicts
  const conflicts = detectConflicts(localCRDT, remoteCRDT, merged);
  
  if (conflicts.length === 0) {
    // Clean merge - check if API supports direct update
    if (provider.supportsAtomicUpdate()) {
      return { strategy: 'auto', reason: 'Clean merge, API supports update' };
    }
    return { strategy: 'llm', reason: 'Clean merge, but API needs orchestration' };
  }
  
  // 3. Conflicts exist - can LLM resolve?
  if (conflicts.every(c => c.resolvable)) {
    return { strategy: 'llm', reason: `${conflicts.length} resolvable conflicts` };
  }
  
  // 4. Unresolvable - escalate to user
  return { strategy: 'manual', reason: 'Unresolvable conflicts detected' };
}
```

### LLM Resolution (via UTCP)

When CRDT can't auto-merge or API needs orchestration:

```typescript
interface ReconciliationRequest {
  local: {
    content: string;      // Current local file
    crdt: Uint8Array;     // CRDT state
  };
  remote: {
    content: string;      // Fetched remote state
    crdt: Uint8Array;
  };
  diff: string;           // Unified diff
  resourceType: string;   // "github.issue"
  resourceId: string;     // "github:owner/repo#42"
}

// LLM has access to provider tools via UTCP
const tools = [
  'github.updateIssue',
  'github.addLabels',
  'github.removeLabels',
  'github.updateIssueBody',
  // ...
];

// Prompt template
const prompt = `
Reconcile the following local and remote changes to a ${request.resourceType}.

## Local Version
${request.local.content}

## Remote Version  
${request.remote.content}

## Diff
${request.diff}

Use the available tools to update the remote resource to reflect the intended changes.
If you cannot determine the user's intent, explain the conflict and suggest options.
`;
```

### Error Handling

```typescript
interface SyncError {
  resourceId: string;
  strategy: 'auto' | 'llm';
  error: string;
  llmExplanation?: string;  // If LLM attempted resolution
  suggestedActions?: string[];
}

// Surface to user
function reportSyncError(error: SyncError): void {
  // Write to .hardcopy/errors/{resourceId}.md
  // Notify via configured channel (file watcher, webhook, etc.)
}
```

---

## Provider Interface

```typescript
interface Provider {
  name: string;
  nodeTypes: string[];      // ["github.Issue", "github.Label", ...]
  edgeTypes: string[];      // ["github.ASSIGNED_TO", ...]
  
  // Fetch with optional caching
  // Provider manages its own caching strategy (ETags, timestamps, etc.)
  fetch(request: FetchRequest): Promise<FetchResult>;
  
  // Push changes to remote
  push(node: Node, changes: Change[]): Promise<PushResult>;
  
  // Tools (for LLM reconciliation)
  getTools(): Tool[];
}

interface FetchRequest {
  query: NodeQuery;
  cursor?: string;
  pageSize?: number;
  // Cached version token from previous fetch (provider-specific format)
  versionToken?: string;
}

interface FetchResult {
  nodes: Node[];
  edges: Edge[];
  cursor?: string;
  hasMore: boolean;
  // Provider returns new version token for caching
  // null if provider doesn't support caching, undefined if unchanged
  versionToken?: string | null;
  // True if data unchanged from cache (provider handled internally)
  cached?: boolean;
}
```

### Git Provider (Example)

```typescript
const gitProvider: Provider = {
  name: 'git',
  nodeTypes: ['git.Branch', 'git.Worktree', 'git.Commit'],
  edgeTypes: ['git.TRACKS', 'git.CONTAINS', 'git.WORKTREE_OF'],
  
  async fetch(request: FetchRequest): Promise<FetchResult> {
    const results: FetchResult = { nodes: [], edges: [], hasMore: false };
    
    for (const repo of config.repositories) {
      // Version token for git is the HEAD commit SHA
      const currentHead = await execGit(repo.path, 'rev-parse', 'HEAD');
      if (request.versionToken === currentHead) {
        return { ...results, cached: true, versionToken: currentHead };
      }
      
      const worktrees = await execGit(repo.path, 'worktree', 'list', '--porcelain');
      const branches = await execGit(repo.path, 'branch', '-a', '--format=%(refname:short)');
      
      // Add worktree nodes
      for (const wt of worktrees) {
        results.nodes.push({
          id: `git:worktree:${wt.path}`,
          type: 'git.Worktree',
          attrs: {
            path: wt.path,
            branch: wt.branch,
            bare: wt.bare,
            // A2A metadata if present (set by agent when creating worktree)
            meta: await readWorktreeMeta(wt.path),
          }
        });
      }
      
      // Add branch nodes
      for (const branch of branches) {
        const branchNode = {
          id: `git:branch:${repo.path}:${branch}`,
          type: 'git.Branch',
          attrs: {
            name: branch,
            repository: repo.path,
            lastCommit: await getLastCommit(repo.path, branch),
            // Check if any worktree is on this branch
            worktreePath: worktrees.find(wt => wt.branch === branch)?.path,
          }
        };
        results.nodes.push(branchNode);
        
        // Create links based on explicit config
        const taskId = await resolveTaskLink(branch, config.links);
        if (taskId) {
          results.edges.push({
            type: 'git.TRACKS',
            from_id: branchNode.id,
            to_id: taskId,
          });
        }
      }
    }
    
    // Return new version token (latest HEAD)
    const latestHead = await execGit(config.repositories[0].path, 'rev-parse', 'HEAD');
    return { ...results, versionToken: latestHead };
  },
  
  async push(node, changes) {
    // For diff generation, switch to worktree directory if needed
    const workdir = node.attrs.worktreePath || node.attrs.repository;
    return execGit(workdir, 'push', ...args);
  },
  
  // Generate diff from worktree location for accurate results
  async getDiff(branch: string, base: string): Promise<string> {
    const node = await getNode(`git:branch:*:${branch}`);
    const workdir = node.attrs.worktreePath || node.attrs.repository;
    return execGit(workdir, 'diff', base, branch);
  },
  
  getTools: () => [
    { name: 'git.checkout', description: 'Checkout branch' },
    { name: 'git.push', description: 'Push changes' },
    { name: 'git.createBranch', description: 'Create new branch' },
    { name: 'git.createWorktree', description: 'Create worktree for branch' },
  ],
};

// Helper: Read A2A metadata from worktree (if agent left it)
async function readWorktreeMeta(path: string): Promise<Record<string, any> | null> {
  const metaPath = join(path, '.a2a', 'session.json');
  if (await exists(metaPath)) {
    return JSON.parse(await readFile(metaPath, 'utf-8'));
  }
  return null;
}

// Helper: Resolve task link from config
async function resolveTaskLink(
  branch: { name: string; meta?: Record<string, any> },
  links: LinkConfig[]
): Promise<string | null> {
  for (const link of links) {
    if (link.edge === 'git.TRACKS') {
      // Try A2A metadata first (preferred)
      if (branch.meta?.a2a?.task_id) {
        return `a2a:${branch.meta.a2a.task_id}`;
      }
      // Fallback to branch name pattern if configured
      if (link.match.includes('regex_extract')) {
        const pattern = extractPattern(link.match);
        const match = branch.name.match(pattern);
        if (match) return `a2a:${match[1]}`;
      }
    }
  }
  return null;
}
```

---

## CLI Commands

```bash
# Initialize hardcopy in current directory
hardcopy init

# Manual sync (fetch all sources, update graph)
hardcopy sync

# Refresh specific view (lazy-load first page)
hardcopy refresh my-tasks

# Push local changes to remotes
hardcopy push

# Push specific file
hardcopy push my-tasks/feature/auth/123.github.issue.md

# Show sync status (pending changes, conflicts)
hardcopy status

# Show rate limit status
hardcopy rate-limit
```

---

## POC Milestones

### Phase 1: Core Infrastructure
- [x] LibSQL setup and schema
- [x] Provider interface definition
- [x] Config parser (YAML → sources + views)
- [x] CLI skeleton (`init`, `sync`, `status`, `refresh`, `push`)
- [x] Per-node CRDT storage structure

### Phase 2: GitHub Provider
- [x] Fetch issues with pagination
- [x] Node/edge creation in LibSQL
- [ ] Conditional requests (304 caching with ETags)
- [x] `github.issue.md` format handler

### Phase 3: A2A Provider
- [x] Task fetching from A2A protocol (skeleton)
- [x] Explicit link config parsing
- [x] Edge creation (a2a.TRACKS → github.Issue)
- [ ] Session metadata in worktrees

### Phase 4: Git Provider
- [x] Branch/worktree discovery (single sync per repo)
- [x] Worktree metadata reading (`.a2a/session.json`)
- [x] Explicit link resolution (metadata > branch name)
- [ ] Diff generation from worktree directory

### Phase 5: View Rendering
- [ ] Cypher query execution via GraphQLite
- [ ] Partition logic (group by field)
- [x] File tree generation
- [x] Lazy loading with `.index` files

### Phase 6: Bi-Directional Sync
- [x] CRDT integration (Loro) per-node
- [ ] File watcher for local edits
- [ ] Auto-push for clean CRDT merges
- [ ] LLM reconciliation via UTCP

### Phase 7: Conflict Handling
- [ ] Conflict detection
- [ ] Error file generation (`.hardcopy/errors/`)
- [ ] Manual resolution workflow
- [ ] `hardcopy status` conflict display

---

## File Format: github.issue.md

```markdown
---
_type: github.issue
_id: "github:AprovanLabs/zolvery#123"
_synced: 2026-02-21T10:30:00Z
number: 123
title: "Implement auth flow"
state: open
labels: [enhancement, auth]
assignee: jsampson
milestone: "v1.0"
created_at: 2026-02-15T08:00:00Z
updated_at: 2026-02-20T14:30:00Z
url: "https://github.com/AprovanLabs/zolvery/issues/123"
---

Issue body in Markdown...

## Acceptance Criteria
- [ ] OAuth2 integration
- [ ] Token refresh
```

### Format Handler

```typescript
interface FormatHandler {
  type: string;  // "github.issue"
  
  // Node → File content
  render(node: Node): string;
  
  // File content → Node changes
  parse(content: string): { attrs: Record<string, any>; body: string };
  
  // Which fields are editable locally
  editableFields: string[];  // ["title", "body", "labels", "assignee"]
}
```

---

## Design Decisions

### 1. CRDT Granularity: Per-Node

Each node has its own CRDT document. This allows independent sync rates, isolated conflict resolution, and granular failure handling. Storage overhead is acceptable given typical node sizes.

### 2. Branch → Task Linking: Explicit Config

Don't rely on branch naming conventions. Instead, use explicit configuration:

```yaml
links:
  - edge: git.TRACKS
    to: a2a.Task
    # Option A: A2A session metadata (preferred)
    match: "a2a:{{branch.meta.a2a.task_id}}"
    # Option B: Branch name pattern (fallback)
    # match: "a2a:{{branch.name | regex_extract: 'task-([0-9]+)'}}"
```

The A2A provider writes metadata to `.a2a/session.json` in worktrees it creates, which the Git provider reads.

### 3. Worktree Support: Single Sync, Branch-Centric

- `git worktree list` from any repo directory returns all worktrees
- Single sync operation per repository discovers all branches and worktrees
- Worktrees are nodes with a `path` attribute; branches reference their worktree if one exists
- For diff generation, the Git provider switches to the worktree directory to ensure accurate results
- Changes flow through branches (push to remote), keeping a central source of truth

### 4. Caching: Manual Refresh + Provider-Managed Tokens

**Refresh is manual by default.** Users explicitly trigger `hardcopy sync` or `hardcopy refresh <view>`.

The core stores a generic `version_token` per node. Providers manage their own caching:

```typescript
// Core sync logic — provider-agnostic
async function syncNode(provider: Provider, nodeId: string): Promise<void> {
  const cached = await db.get('SELECT version_token FROM nodes WHERE id = ?', nodeId);
  
  const result = await provider.fetch({
    query: { id: nodeId },
    versionToken: cached?.version_token,
  });
  
  if (result.cached) {
    // Provider determined data unchanged — skip update
    return;
  }
  
  // Update node and store new version token
  await db.run(
    'UPDATE nodes SET attrs = ?, synced_at = ?, version_token = ? WHERE id = ?',
    result.nodes[0].attrs,
    Date.now(),
    result.versionToken,
    nodeId
  );
}
```

**Provider implementations vary:**
- **GitHub**: Uses ETags via `If-None-Match` header (304 = cached)
- **Jira**: Uses `updated` timestamp comparison
- **Git**: Uses commit SHA comparison
- **Google Docs**: Uses revision ID

This abstraction lets each provider optimize for its API while core remains generic.
