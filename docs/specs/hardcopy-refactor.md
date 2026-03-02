# Plan C: Hardcopy Refactor Spec

## Goal

Become the sync engine for bidirectional data flow between remote APIs and local state. Depend on Apprentice for graph/events.

---

## Phase C1: Remove Duplicated Modules

Delete modules that move to Apprentice:

- `src/events/` → use `@aprovan/apprentice`
- `src/graph/` → use `@aprovan/apprentice`
- `src/orchestrator/` → use `@aprovan/apprentice`
- `src/services/` → use `@patchwork/services`
- `src/skills/` → use `@patchwork/skills`

Keep and refactor:

- `src/hardcopy/` (diff, push, views)
- `src/contrib/` → convert to skills
- `src/provider.ts` → simplify to sync adapter

---

## Phase C2: Simplify Provider to SyncAdapter

Replace `Provider` + `ProviderContrib` with minimal `SyncAdapter`.

```typescript
interface SyncAdapter {
  name: string;

  fetch(uri: string): Promise<SyncResult>;
  push(uri: string, changes: Change[]): Promise<PushResult>;

  canHandle(uri: string): boolean;
}

interface SyncResult {
  entity: Entity;
  raw: unknown;
  etag?: string;
}

interface Change {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

interface PushResult {
  success: boolean;
  entity?: Entity;
  error?: string;
}
```

### Changes

- Remove `nodeTypes`, `edgeTypes`, `streams`, `subscribe`, `query` from Provider
- SyncAdapter only handles fetch/push for a URI scheme
- No registration—adapters discovered via skills

---

## Phase C3: Convert Contribs to Skills

Each provider becomes a skill that registers a SyncAdapter.

### Before (contrib)

```typescript
export function getGitHubContrib(): ProviderContrib {
  return {
    name: "github",
    createProvider: () => createGitHubProvider(),
    linkExtractors: [githubLinkExtractor],
    formatHandlers: [githubIssueFormat],
    webhookInferrers: [githubWebhookInferrer],
  };
}
```

### After (skill)

```yaml
# skills/github-sync/SKILL.md
---
name: GitHub Sync
description: Sync GitHub issues and PRs with local state
triggers:
  - eventFilter:
      types: ["sync.request"]
      subjects: ["github:*"]
tools:
  - hardcopy.fetch
  - hardcopy.push
---

When a sync request arrives for a GitHub URI:
1. Parse the URI to extract owner/repo/number
2. Fetch from GitHub API
3. Convert to Entity format
4. Return for merge with local state
```

### Changes

- Delete `src/contrib/github.ts`, `jira.ts`, `stripe.ts`
- Create example skills in `skills/` directory
- Link extractors become part of skill instructions
- Format handlers become skill logic
- Webhook inferrers handled by skill triggers

---

## Phase C4: Core Sync Engine

Keep the diff/merge/view logic as Hardcopy's core value.

```typescript
interface SyncEngine {
  diff(local: Entity, remote: Entity): Change[];
  merge(local: Entity, remote: Entity, strategy: MergeStrategy): Entity;
  renderView(entity: Entity, format: ViewFormat): string;
  parseView(content: string, format: ViewFormat): Partial<Entity>;
}

type MergeStrategy = "local-wins" | "remote-wins" | "manual" | "field-level";
type ViewFormat = "markdown" | "yaml" | "json";
```

---

## Phase C5: Expose as Service

Register Hardcopy as a service in Patchwork's registry.

```typescript
// Hardcopy exposes these procedures
const hardcopyService: ServiceDefinition = {
  namespace: "hardcopy",
  version: "1.0.0",
  source: { type: "local", config: { handler: "hardcopy" } },
  procedures: [
    {
      name: "fetch",
      description: "Fetch entity from remote",
      input: { uri: "string" },
      output: { entity: "Entity" },
    },
    {
      name: "push",
      description: "Push changes to remote",
      input: { uri: "string", changes: "Change[]" },
      output: { result: "PushResult" },
    },
    {
      name: "diff",
      description: "Diff local and remote",
      input: { local: "Entity", remote: "Entity" },
      output: { changes: "Change[]" },
    },
    {
      name: "sync",
      description: "Full sync cycle",
      input: { uri: "string", strategy: "MergeStrategy" },
      output: { entity: "Entity" },
    },
  ],
  types: [],
};
```

---

## File Changes

| Action | Path                                 |
| ------ | ------------------------------------ |
| Delete | `src/events/`                        |
| Delete | `src/graph/`                         |
| Delete | `src/orchestrator/`                  |
| Delete | `src/services/`                      |
| Delete | `src/skills/`                        |
| Delete | `src/contrib/`                       |
| Modify | `src/provider.ts` → SyncAdapter      |
| Modify | `src/hardcopy/` → core sync engine   |
| Add    | `src/service.ts` → expose as service |
