# hardcopy

![Aprovan Labs](https://raw.githubusercontent.com/AprovanLabs/aprovan.com/main/docs/assets/header-labs.svg)
<br />
<a href="https://aprovan.com">
<img height="20" src="https://img.shields.io/badge/aprovan.com-ef4444?style=flat-square" alt="aprovan.com">
</a>
<a href="https://github.com/AprovanLabs">
<img height="20" src="https://img.shields.io/badge/-AprovanLabs-000000?style=flat-square&logo=GitHub&logoColor=white&link=https://github.com/AprovanLabs/" alt="Aprovan Labs GitHub" />
</a>
<a href="https://www.linkedin.com/company/aprovan">
<img height="20" src="https://img.shields.io/badge/-Aprovan-blue?style=flat-square&logo=Linkedin&logoColor=white&link=https://www.linkedin.com/company/aprovan)" alt="Aprovan LinkedIn">
</a>

Keep everything close at hand

## Getting Started

### Installation

```bash
pnpm add @aprovan/hardcopy
```

Or for local development:

```bash
# From the hardcopy repo
pnpm install
pnpm -F @aprovan/hardcopy build
```

### Initialize

```bash
# If installed as dependency
pnpm exec hardcopy init

# Local development
pnpm hardcopy init
```

This creates:
- `.hardcopy/` — database and CRDT storage
- `hardcopy.yaml` — source and view configuration

### Configuration

Create a `hardcopy.yaml` in your project root:

```yaml
sources:
  - name: github
    provider: github
    orgs: [AprovanLabs]
    # Or specify repos directly:
    # repos: [AprovanLabs/zolvery, AprovanLabs/hardcopy]

  - name: agents
    provider: a2a
    endpoint: http://localhost:8080
    links:
      - edge: a2a.TRACKS
        to: github.Issue
        match: "github:{{task.meta.github.repository}}#{{task.meta.github.issue_number}}"

  - name: git
    provider: git
    repositories:
      - path: ~/Projects/example
    links:
      - edge: git.TRACKS
        to: a2a.Task
        match: "a2a:{{branch.meta.a2a.task_id}}"

views:
  - path: issues
    description: "Open GitHub issues"
    query: |
      MATCH (i:github.Issue)
      WHERE i.attrs->>'state' = 'open'
      RETURN i
    render:
      - path: "{{attrs.number}}.github.issue.md"
        type: github.Issue
```

### Conflict Resolution

Conflict resolution uses `diff3` for clean merges, with automatic LLM fallback for conflicts. Configure via environment variables:

```bash
export OPENAI_BASE_URL=https://api.openai.com/v1  # or any OpenAI-compatible endpoint
export OPENAI_API_KEY=sk-...
export OPENAI_MODEL=gpt-4o                        # optional, defaults to gpt-4o
```

### Providers

#### GitHub

Requires `GITHUB_TOKEN` environment variable for API access:

```bash
export GITHUB_TOKEN=ghp_xxxxxxxxxxxx
```

Configuration options:
- `orgs` — fetch all repos from these organizations
- `repos` — specific repos (e.g., `owner/repo`)
- `token` — override env token (not recommended)

#### Git

Discovers branches and worktrees from local repositories. Reads A2A metadata from `.a2a/session.json` in worktrees for task linking.

Configuration options:
- `repositories[].path` — paths to git repos (supports `~`)
- `links` — edge configuration for task linking

#### A2A

Connects to an A2A-compatible agent endpoint.

Configuration options:
- `endpoint` — base URL of the A2A server
- `links` — edge configuration for cross-provider linking

### Commands

```bash
# Initialize hardcopy
pnpm hardcopy init

# Sync all sources (fetch remote data)
pnpm hardcopy sync

# Refresh a view (render to file tree)
pnpm hardcopy refresh <view>

# Show sync status
pnpm hardcopy status

# Push local changes to remotes
pnpm hardcopy push [file]
```

### File Structure

After syncing and refreshing views:

```
project/
├── hardcopy.yaml
├── .hardcopy/
│   ├── db.sqlite      # LibSQL database (nodes + edges)
│   ├── crdt/          # Per-node CRDT snapshots
│   └── errors/        # Sync error reports
└── issues/            # View directory
    ├── .index         # Pagination state
    ├── 42.github.issue.md
    └── 43.github.issue.md
```

### Programmatic Usage

```typescript
import { Hardcopy } from "@aprovan/hardcopy";

const hc = new Hardcopy({ root: process.cwd() });
await hc.initialize();

// Sync all sources
const stats = await hc.sync();
console.log(`Synced ${stats.nodes} nodes`);

// Query the database
const db = hc.getDatabase();
const issues = await db.queryNodes("github.Issue");

await hc.close();
```

