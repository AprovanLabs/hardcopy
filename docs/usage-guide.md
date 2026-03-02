# Hardcopy Usage Guide

This guide demonstrates how to use the unified event system that brings together the Event Bus, Service Registry, Entity Graph, Skill Registry, and LLM Orchestrator.

## Table of Contents

1. [Quick Start](#quick-start)
2. [Event Bus](#event-bus)
3. [Service Registry](#service-registry)
4. [Entity Graph](#entity-graph)
5. [Skill Registry](#skill-registry)
6. [LLM Orchestrator](#llm-orchestrator)
7. [End-to-End Examples](#end-to-end-examples)

---

## Quick Start

```typescript
import { HardcopyDatabase } from "hardcopy";
import { EventStore, EventBus } from "hardcopy/events";
import { ServiceStore, ServiceRegistry } from "hardcopy/services";
import { EntityGraph } from "hardcopy/graph";
import { SkillRegistry } from "hardcopy/skills";
import { createOrchestrator } from "hardcopy/orchestrator";

// 1. Initialize database
const db = new HardcopyDatabase("./hardcopy.db");

// 2. Create core components
const eventStore = new EventStore(db);
const eventBus = new EventBus(eventStore);

const serviceStore = new ServiceStore(db);
const serviceRegistry = new ServiceRegistry(serviceStore);
serviceRegistry.setEventBus(eventBus);

const entityGraph = new EntityGraph(db, { autoExtractLinks: true });

const skillRegistry = new SkillRegistry({
  db,
  graph: entityGraph,
  eventBus,
  serviceRegistry,
});

// 3. Create orchestrator
const orchestrator = createOrchestrator({
  eventBus,
  skillRegistry,
  entityGraph,
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
});

// 4. Start processing events
orchestrator.start();
```

---

## Event Bus

The Event Bus is the central nervous system. All inputs become events; all outputs are events.

### Creating Events

```typescript
import { createEnvelope } from "hardcopy/events";

// Create an event using the helper function
const event = createEnvelope(
  "github.issue.opened",           // type
  "webhook:github",                // source
  { number: 42, title: "Bug fix" }, // data
  {
    subject: "github:owner/repo#42",  // optional: entity URI
    metadata: { repository: "owner/repo" },
  }
);

// Publish to the bus
await eventBus.publish(event);

// Or create manually
await eventBus.publish({
  id: crypto.randomUUID(),
  timestamp: new Date().toISOString(),
  type: "user.action.clicked",
  source: "ui:dashboard",
  subject: "user:12345",
  data: { button: "submit", page: "/checkout" },
  metadata: { session: "abc123" },
});
```

### Subscribing to Events

```typescript
// Subscribe with filters
const subscription = eventBus.subscribe(
  {
    types: ["github.issue.*", "github.pr.*"],  // wildcards supported
    sources: ["webhook:github"],
    subjects: ["github:owner/repo*"],          // filter by entity
  },
  async (event) => {
    console.log("Received:", event.type, event.data);
    // Handle the event...
  }
);

// Later: cleanup
subscription.unsubscribe();
```

### Streaming Events

```typescript
// Stream events in real-time
const stream = eventBus.stream({
  types: ["llm.*.chunk"],  // stream LLM output chunks
});

for await (const event of stream) {
  process.stdout.write(event.data.content);
}
```

### Querying Historical Events

```typescript
// Query past events
const page = await eventBus.query(
  {
    types: ["github.issue.*"],
    since: "2025-02-01T00:00:00Z",
    until: "2025-02-28T23:59:59Z",
    metadata: { repository: "owner/repo" },
  },
  { limit: 100, order: "desc" }
);

for (const event of page.events) {
  console.log(event.timestamp, event.type, event.subject);
}

// Pagination
if (page.hasMore) {
  const nextPage = await eventBus.query(filter, { cursor: page.cursor });
}
```

### Full-Text Search

```typescript
// Search event data
const results = await eventBus.search(
  "authentication failed",
  { types: ["error.*"], since: "2025-02-01T00:00:00Z" },
  { limit: 50 }
);
```

### Batching & Deduplication

```typescript
// Configure batching for high-throughput scenarios
eventBus.setBatchConfig({
  maxSize: 100,           // flush after 100 events
  maxWaitMs: 5000,        // or after 5 seconds
  dedupeKey: (e) => `${e.subject}:${e.type}`,  // dedupe by subject+type
});

// Now publish events - they'll be batched automatically
await eventBus.publish(event1);
await eventBus.publish(event2);
await eventBus.publish(event3);
```

### Dead Letter Queue

```typescript
// Failed events go to dead letter queue automatically after retries
// Replay a dead letter entry:
const success = await eventBus.replayDeadLetter(envelopeId, handlerId);
```

---

## Service Registry

The Service Registry manages external APIs with versioning, caching, and streaming support.

### Registering HTTP Services

```typescript
import { ServiceRegistry } from "hardcopy/services";

await serviceRegistry.register({
  namespace: "weather",
  version: "1.0.0",
  source: {
    type: "http",
    config: {
      baseUrl: "https://api.weather.com/v1",
      headers: { "Accept": "application/json" },
      auth: { type: "api-key", key: process.env.WEATHER_API_KEY },
    },
  },
  procedures: [
    {
      name: "get_forecast",
      description: "Get weather forecast for a location",
      input: {
        type: "object",
        properties: {
          location: { type: "string" },
          days: { type: "number" },
        },
        required: ["location"],
      },
      output: {
        type: "object",
        properties: {
          forecast: { type: "array" },
        },
      },
      cacheTtl: 3600,  // cache for 1 hour
    },
  ],
  types: [
    {
      name: "Forecast",
      schema: {
        type: "object",
        properties: {
          date: { type: "string" },
          high: { type: "number" },
          low: { type: "number" },
          conditions: { type: "string" },
        },
      },
    },
  ],
});
```

### Registering MCP Services

```typescript
await serviceRegistry.register({
  namespace: "github",
  version: "1.0.0",
  source: {
    type: "mcp",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    },
  },
  procedures: [
    {
      name: "get_issue",
      description: "Get GitHub issue details",
      input: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, number: { type: "number" } }, required: ["owner", "repo", "number"] },
      output: { type: "object" },
    },
    {
      name: "create_issue",
      description: "Create a new GitHub issue",
      input: { type: "object", properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["owner", "repo", "title"] },
      output: { type: "object" },
    },
  ],
  types: [],
});
```

### Registering Local Services

```typescript
// Register a local handler
serviceRegistry.registerLocalHandler("calculator", async (procedure, args) => {
  const { a, b } = args as { a: number; b: number };
  switch (procedure) {
    case "add": return a + b;
    case "subtract": return a - b;
    case "multiply": return a * b;
    case "divide": return b !== 0 ? a / b : null;
    default: throw new Error(`Unknown procedure: ${procedure}`);
  }
});

await serviceRegistry.register({
  namespace: "calculator",
  version: "1.0.0",
  source: { type: "local", config: {} },
  procedures: [
    { name: "add", description: "Add two numbers", input: { type: "object" }, output: { type: "number" } },
    { name: "subtract", description: "Subtract two numbers", input: { type: "object" }, output: { type: "number" } },
    { name: "multiply", description: "Multiply two numbers", input: { type: "object" }, output: { type: "number" } },
    { name: "divide", description: "Divide two numbers", input: { type: "object" }, output: { type: "number" } },
  ],
  types: [],
});
```

### Calling Services

```typescript
// Call a procedure
const forecast = await serviceRegistry.call("weather", "get_forecast", {
  location: "Seattle, WA",
  days: 5,
});

const issue = await serviceRegistry.call("github", "get_issue", {
  owner: "AprovanLabs",
  repo: "hardcopy",
  number: 42,
});

const sum = await serviceRegistry.call("calculator", "add", { a: 10, b: 20 });
```

### Streaming Services

```typescript
// Stream from SSE/WebSocket endpoints
for await (const chunk of serviceRegistry.stream("openai", "chat_completion", {
  model: "gpt-4",
  messages: [{ role: "user", content: "Hello!" }],
  stream: true,
})) {
  process.stdout.write(chunk.choices[0].delta.content ?? "");
}

// Stream with automatic event bus bridge
for await (const chunk of serviceRegistry.streamWithBridge("openai", "chat_completion", args)) {
  // Each chunk is also published to the event bus as stream.openai.chat_completion.item
  process.stdout.write(chunk.choices[0].delta.content ?? "");
}
```

### Service Discovery

```typescript
// List all services
const services = await serviceRegistry.list();
// => [{ namespace: "weather", version: "1.0.0", procedureCount: 1 }, ...]

// Get full service definition
const github = await serviceRegistry.get("github");

// Search services
const found = await serviceRegistry.search("issue");
```

### Cache Management

```typescript
// Invalidate cache for a service
serviceRegistry.invalidateCache("weather");

// Invalidate specific procedure
serviceRegistry.invalidateCache("weather", "get_forecast");

// Cache is also invalidated via events:
await eventBus.publish(createEnvelope(
  "cache.invalidate.weather",
  "system",
  { namespace: "weather", procedure: "get_forecast" }
));
```

---

## Entity Graph

The Entity Graph stores entities with URI-based addressing and automatic link extraction.

### URI Format

```
scheme:path[#fragment][@version]

Examples:
  github:owner/repo#42           - GitHub issue
  github:owner/repo#42@abc123    - Issue at specific commit
  jira:PROJ-123                  - Jira ticket
  file:/path/to/file.md@HEAD    - Local file at HEAD
  skill:planning/SKILL.md        - Skill definition
```

### Upserting Entities

```typescript
import { EntityGraph } from "hardcopy/graph";

// Upsert a single entity
await entityGraph.upsert({
  uri: "github:AprovanLabs/hardcopy#42",
  type: "github.Issue",
  attrs: {
    number: 42,
    title: "Implement event bus",
    body: "We need an event bus. See JIRA-123 for requirements.",
    state: "open",
    labels: ["enhancement", "priority:high"],
    assignees: ["jsampson"],
    repository: "AprovanLabs/hardcopy",
  },
  version: "abc123",
  syncedAt: new Date().toISOString(),
});

// Links to jira:JIRA-123 are automatically extracted from the body text!

// Upsert with explicit links
await entityGraph.upsert({
  uri: "github:AprovanLabs/hardcopy#43",
  type: "github.Issue",
  attrs: {
    number: 43,
    title: "Follow-up task",
    body: "Continue from #42",
  },
  links: [
    { type: "references", targetUri: "github:AprovanLabs/hardcopy#42" },
    { type: "blocks", targetUri: "jira:PROJ-456" },
  ],
});

// Batch upsert
await entityGraph.upsertBatch([entity1, entity2, entity3]);
```

### Retrieving Entities

```typescript
// Get by URI
const issue = await entityGraph.get("github:AprovanLabs/hardcopy#42");
// => { uri, type, attrs, version, syncedAt, links }

// Get at specific version
const oldIssue = await entityGraph.get("github:AprovanLabs/hardcopy#42", "def456");
```

### Managing Links

```typescript
// Create a link
await entityGraph.link(
  "github:AprovanLabs/hardcopy#42",  // from
  "jira:PROJ-123",                    // to
  "implements",                        // type
  { addedBy: "automation" }           // optional attrs
);

// Remove a link
await entityGraph.unlink(
  "github:AprovanLabs/hardcopy#42",
  "jira:PROJ-123",
  "implements"
);
```

### Querying with Cypher

```typescript
// Find all open issues
const openIssues = await entityGraph.query(`
  MATCH (i:\`github.Issue\`)
  WHERE i.state = 'open'
  RETURN i
  ORDER BY i.created_at DESC
`);

// Find issues with specific label
const priorityIssues = await entityGraph.query(`
  MATCH (i:\`github.Issue\`)
  WHERE $label IN i.labels
  RETURN i
`, { label: "priority:high" });

// Find linked entities
const related = await entityGraph.query(`
  MATCH (issue:\`github.Issue\`)-[:references]->(target)
  WHERE issue.uri = $uri
  RETURN target
`, { uri: "github:AprovanLabs/hardcopy#42" });
```

### Graph Traversal

```typescript
// Traverse from an entity (BFS)
const related = await entityGraph.traverse(
  "github:AprovanLabs/hardcopy#42",
  2  // depth
);

// Returns all entities within 2 hops (both directions)
for (const entity of related) {
  console.log(entity.uri, entity.type);
}
```

### Schema Inference

```typescript
// Infer schema from existing entities
const schema = await entityGraph.inferSchema("github.Issue");
// => {
//   type: "object",
//   title: "github.Issue",
//   properties: {
//     number: { type: "integer" },
//     title: { type: "string" },
//     state: { type: "string" },
//     labels: { type: "array" },
//     ...
//   }
// }
```

### Views (Materialized Queries)

```typescript
import { ViewRenderer, refreshView } from "hardcopy/graph";

// Define a view
const viewDef = {
  name: "open-issues",
  query: `
    MATCH (i:\`github.Issue\`)
    WHERE i.state = 'open'
    RETURN i
    ORDER BY i.number
  `,
  path: "docs/issues/{{attrs.repository}}/issue-{{attrs.number}}.md",
  format: "markdown",
  template: `# {{attrs.title}}

**State:** {{attrs.state}}
**Labels:** {{#each attrs.labels}}{{this}} {{/each}}

{{attrs.body}}
`,
  ttl: 300,  // refresh every 5 minutes
};

// Render view
const renderer = new ViewRenderer(entityGraph, viewDef);
const results = await renderer.render();

for (const result of results) {
  console.log(`Rendered: ${result.path}`);
  // result.content contains the rendered markdown
}

// Refresh if stale
const refreshResult = await refreshView(entityGraph, viewDef);
if (refreshResult.refreshed) {
  console.log(`Refreshed ${refreshResult.count} files`);
}
```

### Link Extractors

```typescript
import { LinkExtractorRegistry, githubExtractor, jiraExtractor } from "hardcopy/graph";

// Built-in extractors
const registry = new LinkExtractorRegistry();
registry.register(githubExtractor);  // Extracts GitHub URLs and #123 references
registry.register(jiraExtractor);    // Extracts PROJ-123 patterns

// Custom extractor
registry.register({
  name: "slack",
  patterns: [/https:\/\/.*\.slack\.com\/archives\/([A-Z0-9]+)\/p(\d+)/g],
  extract(content, context) {
    const links = [];
    for (const match of content.matchAll(this.patterns[0])) {
      links.push({
        sourceUri: context.sourceUri,
        targetUri: `slack:${match[1]}/${match[2]}`,
        linkType: "references",
      });
    }
    return links;
  },
});
```

---

## Skill Registry

Skills are first-class entities that can be triggered by events.

### Defining a Skill

```typescript
import { SkillRegistry, scanForSkills } from "hardcopy/skills";

// Manual registration
await skillRegistry.register({
  id: "issue-planner",
  uri: "skill:planning/SKILL.md",
  name: "Issue Planner",
  description: "Break down GitHub issues into actionable tasks",
  instructions: `
You are a planning assistant. When triggered by a new GitHub issue:

1. Read the issue description
2. Break it down into discrete tasks
3. Create a backlog.md file with the tasks
4. Update the issue with a summary

Use the github and git services to interact with the repository.
`,
  triggers: [
    {
      eventFilter: { types: ["github.issue.labeled"] },
      condition: "event.data.label.name === 'auto-plan'",
      priority: 10,
    },
  ],
  tools: ["github", "git"],
  model: {
    provider: "anthropic",
    model: "claude-opus-4-20250514",
  },
  dependencies: ["github", "git"],
});
```

### Scanning for Skills

```typescript
// Scan directory for SKILL.md files
const skills = await scanForSkills("/path/to/skills");

for (const skill of skills) {
  await skillRegistry.register(skill);
}

// Watch for changes
const watcher = watchSkillChanges("/path/to/skills", async (event, skill) => {
  if (event === "add" || event === "change") {
    await skillRegistry.register(skill);
  } else if (event === "unlink") {
    await skillRegistry.unregister(skill.id);
  }
});
```

### SKILL.md Format

```markdown
---
name: Issue Planner
description: Break down GitHub issues into actionable tasks
triggers:
  - eventFilter:
      types:
        - github.issue.labeled
    condition: event.data.label.name === 'auto-plan'
    priority: 10
tools:
  - github
  - git
model:
  provider: anthropic
  model: claude-opus-4-20250514
dependencies:
  - github
  - git
resources:
  - templates/plan-template.md
---

# Issue Planner

You are a planning assistant. When triggered by a new GitHub issue:

1. Read the issue description
2. Break it down into discrete tasks
3. Create a backlog.md file with the tasks
4. Update the issue with a summary

## Tools Available

- `github.get_issue`: Get issue details
- `github.add_comment`: Add a comment to the issue
- `git.read_file`: Read files from the repository
- `git.write_file`: Write files to the repository
```

The frontmatter supports:
- `name` — Display name (defaults to directory name)
- `description` — Short description (defaults to first paragraph)
- `triggers[]` — Array of trigger configurations
  - `eventFilter` — Filter with `types`, `sources`, `subjects` arrays
  - `condition` — JS expression to evaluate against the event
  - `priority` — Higher priority triggers execute first
- `tools` — Array of service namespaces required
- `model` — Preferred model configuration
- `dependencies` — Required service namespaces (validation)
- `resources` — Additional .md files to load (or auto-detected)

### Executing Skills

```typescript
// Execute a skill directly
const result = await skillRegistry.execute("issue-planner", {
  event: someEvent,
  entities: [relatedEntity1, relatedEntity2],
  services: ["github", "git"],
  params: { extraContext: "value" },
});

if (result.status === "success") {
  console.log("Skill completed:", result.output);
} else {
  console.error("Skill failed:", result.error);
}
```

### Skill Discovery

```typescript
// List all skills
const skills = await skillRegistry.list();

// Get a specific skill
const skill = await skillRegistry.get("issue-planner");

// Search skills
const planners = await skillRegistry.search("planner");

// Find skills by trigger
const matches = await skillRegistry.findByTrigger("github.issue.labeled");
```

### Dependency Resolution

```typescript
const resolution = await skillRegistry.resolveDependencies(skill);

if (!resolution.resolved) {
  console.log("Missing services:", resolution.missing);
  console.log("Available services:", resolution.available);
}
```

---

## LLM Orchestrator

The Orchestrator routes events to skills and manages execution.

### Creating an Orchestrator

```typescript
import { createOrchestrator, GitHubNotifier } from "hardcopy/orchestrator";

const orchestrator = createOrchestrator({
  eventBus,
  skillRegistry,
  entityGraph,
  defaultModel: {
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
  },
  maxRetries: 3,
  retryDelay: 1000,
  maxConcurrent: 5,
  notifiers: [
    new GitHubNotifier({
      token: process.env.GITHUB_TOKEN!,
      owner: "AprovanLabs",
      repo: "hardcopy",
    }),
  ],
  ignorePatterns: [
    "llm.*",              // Ignore LLM internal events
    "skill.execution.*",  // Ignore skill execution events
  ],
});

// Start processing
orchestrator.start();

// Later: stop processing
orchestrator.stop();
```

### Starting Sessions Manually

```typescript
// Start a session without waiting for an event
const session = await orchestrator.startSession({
  skillId: "issue-planner",
  model: { provider: "anthropic", model: "claude-opus-4-20250514" },
  context: {
    event: manualEvent,
    entities: [],
    services: ["github", "git"],
  },
});

console.log("Session started:", session.id);

// Monitor session
const updated = await orchestrator.getSession(session.id);
console.log("Status:", updated?.status);

// Cancel if needed
await orchestrator.cancelSession(session.id);
```

### Monitoring Sessions

```typescript
// List sessions
const sessions = await orchestrator.listSessions({
  status: ["running", "pending"],
  skillId: "issue-planner",
  since: "2025-02-01T00:00:00Z",
  limit: 50,
});

// Listen to all events
const unsubscribe = orchestrator.onEvent((event) => {
  if (event.type.startsWith("llm.")) {
    console.log("LLM event:", event.type, event.data);
  }
});

// Later: stop listening
unsubscribe();
```

### External Notifications

```typescript
import { GitHubNotifier, JiraNotifier, CompositeNotifier } from "hardcopy/orchestrator";

// GitHub notifier posts progress/completion as issue comments
const githubNotifier = new GitHubNotifier({
  token: process.env.GITHUB_TOKEN!,
  owner: "AprovanLabs",
  repo: "hardcopy",
});

// Jira notifier adds comments to Jira tickets
const jiraNotifier = new JiraNotifier({
  baseUrl: "https://company.atlassian.net",
  email: process.env.JIRA_EMAIL!,
  token: process.env.JIRA_TOKEN!,
});

// Combine multiple notifiers
const notifier = new CompositeNotifier([githubNotifier, jiraNotifier]);
```

---

## End-to-End Examples

### Example 1: GitHub Issue Automation

This example shows the complete flow from webhook to skill execution.

```typescript
import { HardcopyDatabase } from "hardcopy";
import { EventStore, EventBus, WebhookAdapter, createEnvelope } from "hardcopy/events";
import { ServiceStore, ServiceRegistry } from "hardcopy/services";
import { EntityGraph } from "hardcopy/graph";
import { SkillRegistry } from "hardcopy/skills";
import { createOrchestrator, GitHubNotifier } from "hardcopy/orchestrator";
import express from "express";

// Initialize
const db = new HardcopyDatabase("./hardcopy.db");
const eventStore = new EventStore(db);
const eventBus = new EventBus(eventStore);
const serviceStore = new ServiceStore(db);
const serviceRegistry = new ServiceRegistry(serviceStore);
serviceRegistry.setEventBus(eventBus);
const entityGraph = new EntityGraph(db);
const skillRegistry = new SkillRegistry({ db, graph: entityGraph, eventBus, serviceRegistry });

// Register GitHub MCP service
await serviceRegistry.register({
  namespace: "github",
  version: "1.0.0",
  source: {
    type: "mcp",
    config: {
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-github"],
      env: { GITHUB_TOKEN: process.env.GITHUB_TOKEN },
    },
  },
  procedures: [
    { name: "get_issue", description: "Get issue", input: { type: "object" }, output: { type: "object" } },
    { name: "add_comment", description: "Add comment", input: { type: "object" }, output: { type: "object" } },
  ],
  types: [],
});

// Register skill
await skillRegistry.register({
  id: "issue-responder",
  uri: "skill:responder/SKILL.md",
  name: "Issue Responder",
  description: "Automatically respond to new issues",
  instructions: "When a new issue is created, analyze it and post a helpful response.",
  triggers: [
    { eventFilter: { types: ["github.issue.opened"] }, priority: 10 },
  ],
  tools: ["github"],
  dependencies: ["github"],
});

// Create orchestrator
const orchestrator = createOrchestrator({
  eventBus,
  skillRegistry,
  entityGraph,
  defaultModel: { provider: "anthropic", model: "claude-sonnet-4-20250514" },
  notifiers: [new GitHubNotifier({ token: process.env.GITHUB_TOKEN!, owner: "AprovanLabs", repo: "hardcopy" })],
});

orchestrator.start();

// Set up webhook endpoint
const app = express();
app.use(express.json());

// WebhookAdapter automatically infers GitHub event types from headers
const webhookAdapter = new WebhookAdapter(eventBus, {
  // Optional: customize type/source/subject extraction
  // typeExtractor: (body, headers) => `github.${headers["x-github-event"]}.${body.action}`,
  // sourceExtractor: (body, headers) => "webhook:github",
  // subjectExtractor: (body, headers) => body.issue ? `github:${body.repository.full_name}#${body.issue.number}` : undefined,
});

app.post("/webhooks/github", async (req, res) => {
  try {
    // Adapter handles the event, publishes to bus, and returns the envelope
    const envelope = await webhookAdapter.handle("github", req.body, req.headers as Record<string, string>);
    res.status(200).json({ id: envelope.id, type: envelope.type });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).send("Error");
  }
});

app.listen(3000, () => console.log("Webhook server running on :3000"));
```

### Example 2: Scheduled Knowledge Sync

```typescript
import { ScheduleAdapter, createEnvelope } from "hardcopy/events";

// Create schedule adapter (requires event bus)
const scheduleAdapter = new ScheduleAdapter(eventBus);

// Register a scheduled task
scheduleAdapter.register({
  name: "sync-github-issues",
  cron: "@every 6h",  // Every 6 hours (or use "0 */6 * * *")
  metadata: { owner: "AprovanLabs", repo: "hardcopy" },
});

// Subscribe to schedule events to perform the sync
eventBus.subscribe(
  { types: ["schedule.triggered"], sources: ["schedule:sync-github-issues"] },
  async (event) => {
    const { owner, repo } = event.metadata.schedule as { owner: string; repo: string };
    
    // Fetch all open issues and sync to graph
    const issues = await serviceRegistry.call("github", "list_issues", {
      owner,
      repo,
      state: "open",
    });

    for (const issue of issues) {
      await entityGraph.upsert({
        uri: `github:${owner}/${repo}#${issue.number}`,
        type: "github.Issue",
        attrs: issue,
        syncedAt: new Date().toISOString(),
      });
    }

    // Publish sync complete event
    await eventBus.publish(createEnvelope(
      "sync.github.complete",
      "schedule:sync-github-issues",
      { issueCount: issues.length },
    ));
  }
);

// Trigger immediately (optional)
await scheduleAdapter.triggerNow("sync-github-issues");

// Stop all schedules on shutdown
// scheduleAdapter.stop();
```

### Example 3: Multi-Skill Workflow

```typescript
// Skill 1: Planner - triggered by labeled issues
await skillRegistry.register({
  id: "planner",
  uri: "skill:planning/SKILL.md",
  name: "Planner",
  description: "Create implementation plan",
  instructions: "Break down the issue into tasks and create a plan.",
  triggers: [
    {
      eventFilter: { types: ["github.issue.labeled"] },
      condition: "event.data.label.name === 'needs-plan'",
      priority: 10,
    },
  ],
  tools: ["github", "git"],
  dependencies: ["github", "git"],
});

// Skill 2: Implementer - triggered by planning completion
await skillRegistry.register({
  id: "implementer",
  uri: "skill:implement/SKILL.md",
  name: "Implementer",
  description: "Implement the plan",
  instructions: "Execute the tasks from the plan.",
  triggers: [
    {
      eventFilter: { types: ["skill.execution.success"] },
      condition: "event.data.skillId === 'planner'",
      priority: 5,
    },
  ],
  tools: ["github", "git"],
  dependencies: ["github", "git"],
});

// Skill 3: Reviewer - triggered by implementation completion
await skillRegistry.register({
  id: "reviewer",
  uri: "skill:review/SKILL.md",
  name: "Reviewer",
  description: "Review the implementation",
  instructions: "Check the implementation for issues and suggest improvements.",
  triggers: [
    {
      eventFilter: { types: ["skill.execution.success"] },
      condition: "event.data.skillId === 'implementer'",
      priority: 5,
    },
  ],
  tools: ["github"],
  dependencies: ["github"],
});

// Flow: issue labeled → planner → implementer → reviewer
```

### Example 4: Real-Time Dashboard

```typescript
import { WebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 8080 });

// Subscribe to all events and broadcast to WebSocket clients
eventBus.subscribe({ types: ["*"] }, async (event) => {
  const message = JSON.stringify({
    type: event.type,
    timestamp: event.timestamp,
    subject: event.subject,
    summary: summarizeEvent(event),
  });

  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(message);
    }
  });
});

function summarizeEvent(event) {
  if (event.type.startsWith("llm.") && event.type.includes(".chunk")) {
    return { content: event.data.content };
  }
  if (event.type.startsWith("skill.")) {
    return { skillId: event.data.skillId, status: event.data.status };
  }
  return event.data;
}
```

---

## Best Practices

### Event Types

Use namespaced, hierarchical event types:

```
{provider}.{resource}.{action}

Examples:
  github.issue.opened
  github.issue.closed
  github.pr.merged
  schedule.triggered
  llm.session123.chunk
  llm.session123.complete
  skill.execution.started
  skill.execution.success
  cache.invalidate.weather
```

### URIs

Use consistent URI patterns:

```
{provider}:{path}[#{fragment}][@{version}]

Examples:
  github:owner/repo#42           # Issue 42
  github:owner/repo/pulls#123    # PR 123
  jira:PROJ-456                  # Jira ticket
  file:src/index.ts@abc123       # File at commit
  skill:planning/SKILL.md        # Skill definition
  service:weather                # Service
```

### Error Handling

```typescript
// Events go to dead letter queue after failed retries
eventBus.subscribe(filter, async (event) => {
  try {
    await processEvent(event);
  } catch (err) {
    // Log error - event will be retried automatically
    console.error(`Failed to process ${event.id}:`, err);
    throw err;  // Re-throw to trigger retry
  }
});

// Replay dead letters periodically
const deadLetters = eventStore.getDeadLetterEntries(handlerId);
for (const entry of deadLetters) {
  if (entry.attempts < 5) {
    await eventBus.replayDeadLetter(entry.envelope.id, entry.handlerId);
  }
}
```

### Observability

```typescript
// Query recent activity
const recentEvents = await eventBus.query({
  since: new Date(Date.now() - 3600000).toISOString(),  // Last hour
}, { limit: 1000, order: "desc" });

// Find related events for debugging
const sessionEvents = await eventBus.query({
  types: ["llm.session123.*"],
}, { order: "asc" });

// Search for errors
const errors = await eventBus.search("error", {
  types: ["*.error", "*.failed"],
  since: "2025-02-01T00:00:00Z",
});
```
