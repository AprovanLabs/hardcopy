# Plan B: Patchwork Refactor Spec

## Goal

Manage service registry, skills, and provide the chat UI for integration testing. Depend on Apprentice for graph/events/orchestrator.

---

## Phase B1: Remove Duplicated Modules

Delete packages that move to Apprentice:

- `packages/events/` → use `@aprovan/apprentice`
- `packages/graph/` → use `@aprovan/apprentice`
- `packages/orchestrator/` → use `@aprovan/apprentice`

Keep:

- `packages/services/` (service registry)
- `packages/skills/` (skill registry, scanner)
- `packages/stitchery/` (server, chat integration)

---

## Phase B2: Simplify ServiceRegistry

Remove `utcp` source type. Services are MCP or HTTP.

```typescript
interface ServiceSource {
  type: "mcp" | "http" | "local";
  config: McpConfig | HttpConfig | LocalConfig;
}

interface McpConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: AuthConfig;
}

interface LocalConfig {
  handler: string;
}
```

### Changes

- Remove `utcp` source type and related code
- Remove `grpc` (not implemented)
- Simplify to MCP spawn + HTTP fetch + local function
- Keep caching with TTL and event-based invalidation

---

## Phase B3: Refactor SkillRegistry

Skills become the primary 3rd party integration point. Remove all hardcoded provider logic.

```typescript
interface SkillDefinition {
  id: string;
  uri: string;
  name: string;
  description: string;
  instructions: string;
  triggers: SkillTrigger[];
  tools: string[];
  model?: ModelPreference;
  dependencies?: string[];
}

interface SkillRegistry {
  register(skill: SkillDefinition): Promise<void>;
  unregister(skillId: string): Promise<void>;
  get(skillId: string): Promise<SkillDefinition | null>;
  list(): Promise<SkillSummary[]>;
  findByTrigger(envelope: Envelope): Promise<SkillDefinition[]>;
}
```

### Changes

- Remove `SkillExecutor` from registry—execution delegated to Apprentice's Orchestrator
- Registry is purely for discovery and trigger matching
- Skills reference services by namespace (resolved at execution time)

---

## Phase B4: Wire Stitchery to Apprentice

Update `unified.ts` to use Apprentice as the runtime.

```typescript
import { createApprentice } from "@aprovan/apprentice";
import { ServiceRegistry } from "@patchwork/services";
import { SkillRegistry, scanSkills } from "@patchwork/skills";

interface StitcheryConfig {
  dataDir: string;
  skillsDir?: string;
}

async function createStitcheryContext(config: StitcheryConfig) {
  const apprentice = await createApprentice({
    dbPath: `${config.dataDir}/patchwork.db`,
  });

  const serviceRegistry = new ServiceRegistry({
    db: apprentice.db,
    eventBus: apprentice.eventBus,
  });

  const skillRegistry = new SkillRegistry({
    db: apprentice.db,
    entityGraph: apprentice.entityGraph,
    eventBus: apprentice.eventBus,
  });

  if (config.skillsDir) {
    const skills = await scanSkills({ basePath: config.skillsDir });
    for (const skill of skills) {
      await skillRegistry.register(skill);
    }
  }

  apprentice.orchestrator.setSkillResolver((envelope) =>
    skillRegistry.findByTrigger(envelope),
  );

  apprentice.orchestrator.setToolExecutor((namespace, procedure, args) =>
    serviceRegistry.call(namespace, procedure, args),
  );

  return { apprentice, serviceRegistry, skillRegistry };
}
```

---

## Phase B5: Update apps/chat

Wire chat to use the integrated system.

### Changes

- Chat messages → `eventBus.publish()` as `chat.message.sent`
- LLM responses → `eventBus.publish()` as `llm.{sessionId}.chunk`
- Tool calls → `serviceRegistry.call()`
- Entity references in messages → `entityGraph.get()` + `traverse()`

---

## File Changes

| Action | Path                                                        |
| ------ | ----------------------------------------------------------- |
| Delete | `packages/events/`                                          |
| Delete | `packages/graph/`                                           |
| Delete | `packages/orchestrator/`                                    |
| Modify | `packages/services/src/types.ts` → remove utcp              |
| Modify | `packages/skills/src/registry.ts` → remove executor         |
| Modify | `packages/stitchery/src/server/unified.ts` → use Apprentice |
| Add    | `skills/github-assistant/SKILL.md`                          |
| Add    | `skills/github-sync/SKILL.md`                               |
