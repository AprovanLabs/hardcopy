# Hardcopy API Reference

Quick reference for all types and methods in the unified event system.

---

## Events (`hardcopy/events`)

### Types

```typescript
interface Envelope {
  id: string;                          // UUID
  timestamp: string;                   // ISO 8601
  type: string;                        // e.g. "github.issue.opened"
  source: string;                      // e.g. "webhook:github"
  subject?: string;                    // Entity URI
  data: unknown;                       // Payload
  metadata: Record<string, unknown>;
}

interface EventFilter {
  types?: string[];                    // Supports wildcards: "github.*"
  sources?: string[];
  subjects?: string[];
  since?: string;                      // ISO timestamp
  until?: string;
  metadata?: Record<string, unknown>;
}

interface QueryOptions {
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

interface EventPage {
  events: Envelope[];
  cursor?: string;
  hasMore: boolean;
}

interface BatchConfig {
  maxSize: number;
  maxWaitMs: number;
  dedupeKey?: (e: Envelope) => string;
}

interface DeadLetterEntry {
  envelope: Envelope;
  error: string;
  attempts: number;
  lastAttempt: string;
  handlerId: string;
}
```

### EventBus

```typescript
class EventBus {
  constructor(store: EventStore)
  
  publish(envelope: Envelope): Promise<void>
  publishBatch(envelopes: Envelope[]): Promise<void>
  subscribe(filter: EventFilter, handler: (e: Envelope) => Promise<void>): Subscription
  stream(filter: EventFilter): AsyncIterable<Envelope>
  query(filter: EventFilter, options?: QueryOptions): Promise<EventPage>
  search(query: string, filter?: EventFilter, options?: QueryOptions): Promise<EventPage>
  setBatchConfig(config: BatchConfig): void
  replayDeadLetter(envelopeId: string, handlerId: string): Promise<boolean>
}

function createEnvelope(
  type: string,
  source: string,
  data: unknown,
  options?: { subject?: string; metadata?: Record<string, unknown> }
): Envelope
```

### Adapters

```typescript
interface WebhookConfig {
  pathPrefix?: string;
  secretHeader?: string;
  typeExtractor?: (body: unknown, headers: Record<string, string>) => string;
  sourceExtractor?: (body: unknown, headers: Record<string, string>) => string;
  subjectExtractor?: (body: unknown, headers: Record<string, string>) => string | undefined;
}

interface ScheduleEntry {
  name: string;
  cron: string;                     // @hourly, @daily, @every 5m, */15 * * * *
  metadata?: Record<string, unknown>;
}

class WebhookAdapter {
  constructor(bus: EventBus, config?: WebhookConfig)
  handle(provider: string, body: unknown, headers?: Record<string, string>): Promise<Envelope>
}

class ScheduleAdapter {
  constructor(bus: EventBus)
  register(entry: ScheduleEntry): void
  unregister(name: string): void
  trigger(entry: ScheduleEntry): Promise<Envelope>
  triggerNow(name: string): Promise<Envelope | null>
  list(): ScheduleEntry[]
  stop(): void
}

class ManualAdapter {
  constructor(bus: EventBus)
  emit(type: string, data: unknown, options?: { source?: string; subject?: string; metadata?: Record<string, unknown> }): Promise<Envelope>
}
```

---

## Services (`hardcopy/services`)

### Types

```typescript
interface ServiceDefinition {
  namespace: string;
  version: string;
  source: ServiceSource;
  procedures: ProcedureDefinition[];
  types: TypeDefinition[];
}

interface ServiceSource {
  type: "mcp" | "http" | "grpc" | "local";
  config: McpSourceConfig | HttpSourceConfig | GrpcSourceConfig | LocalSourceConfig;
}

interface McpSourceConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface HttpSourceConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: { type: "bearer"; token: string }
       | { type: "basic"; username: string; password: string }
       | { type: "api-key"; key: string; header?: string };
}

interface ProcedureDefinition {
  name: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  streaming?: boolean;
  cacheTtl?: number;              // seconds
}

interface TypeDefinition {
  name: string;
  schema: JsonSchema;
}

interface ServiceSummary {
  namespace: string;
  version: string;
  procedureCount: number;
  typeCount: number;
}
```

### ServiceRegistry

```typescript
class ServiceRegistry {
  constructor(store: ServiceStore)
  
  setEventBus(eventBus: EventBus): void
  setEntityTypeRegistrar(registrar: EntityTypeRegistrar): void
  
  register(service: ServiceDefinition): Promise<void>
  unregister(namespace: string): Promise<void>
  list(): Promise<ServiceSummary[]>
  get(namespace: string): Promise<ServiceDefinition | null>
  search(query: string): Promise<ServiceDefinition[]>
  
  call(namespace: string, procedure: string, args: unknown): Promise<unknown>
  stream(namespace: string, procedure: string, args: unknown): AsyncIterable<unknown>
  streamWithBridge(namespace: string, procedure: string, args: unknown): AsyncIterable<unknown>
  
  getSchema(namespace: string, typeName: string): Promise<JsonSchema | null>
  registerLocalHandler(namespace: string, handler: (proc: string, args: unknown) => Promise<unknown>): void
  invalidateCache(namespace?: string, procedure?: string): void
  close(): Promise<void>
}
```

### Schema Utilities

```typescript
function extractFromOpenApi(spec: OpenApiSpec): { procedures: ProcedureDefinition[]; types: TypeDefinition[] }
function extractFromMcp(tools: McpToolInfo[]): { procedures: ProcedureDefinition[]; types: TypeDefinition[] }
function generateEntityType(namespace: string, proc: ProcedureDefinition): TypeDefinition
function inferUriPattern(namespace: string, typeName: string): string
```

### Streaming

```typescript
function createStreamEventBridge(config: StreamEventBridgeConfig): StreamBridge
function createSimpleStreamBridge(config: { source: string; eventBus: EventBus; typePrefix: string }): SimpleStreamBridge
function markStreamingProcedures(procedures: ProcedureDefinition[], streamingNames: string[]): void
```

---

## Graph (`hardcopy/graph`)

### Types

```typescript
interface Entity {
  uri: string;                         // e.g. "github:owner/repo#42"
  type: string;                        // e.g. "github.Issue"
  attrs: Record<string, unknown>;
  version?: string;
  syncedAt?: string;
  links?: EntityLink[];
}

interface EntityLink {
  type: string;                        // e.g. "references", "blocks"
  targetUri: string;
  attrs?: Record<string, unknown>;
}

interface ParsedUri {
  scheme: string;
  path: string;
  fragment?: string;
  version?: string;
}

interface ViewDefinition {
  name: string;
  query: string;                       // Cypher
  path: string;                        // Template: "docs/{{attrs.repo}}/{{attrs.number}}.md"
  format: "markdown" | "json" | "yaml" | string;
  template?: string;                   // Handlebars
  ttl?: number;                        // seconds
}

interface LinkExtractor {
  name: string;
  patterns: RegExp[];
  extract(content: string, context: ExtractorContext): ExtractedLink[];
}

interface ExtractedLink {
  sourceUri: string;
  targetUri: string;
  linkType: string;
}
```

### EntityGraph

```typescript
class EntityGraph {
  constructor(db: HardcopyDatabase, options?: { autoExtractLinks?: boolean })
  
  upsert(entity: Entity): Promise<void>
  upsertBatch(entities: Entity[]): Promise<void>
  get(uri: string, version?: string): Promise<Entity | null>
  delete(uri: string): Promise<void>
  
  link(fromUri: string, toUri: string, type: string, attrs?: Record<string, unknown>): Promise<void>
  unlink(fromUri: string, toUri: string, type: string): Promise<void>
  
  query(cypher: string, params?: Record<string, unknown>): Promise<Entity[]>
  traverse(uri: string, depth?: number): Promise<Entity[]>
  inferSchema(type: string): Promise<Record<string, unknown>>
}
```

### URI Utilities

```typescript
function parseUri(uri: string): ParsedUri | null
function buildUri(scheme: string, path: string, fragment?: string, version?: string): string
function normalizeUri(uri: string): string
function withVersion(uri: string, version: string): string
function stripVersion(uri: string): string
function getScheme(uri: string): string | null
function isValidUri(uri: string): boolean
function matchesPattern(uri: string, pattern: string): boolean

const URI_PATTERNS: {
  github: RegExp;
  jira: RegExp;
  file: RegExp;
  skill: RegExp;
  service: RegExp;
}
```

### Link Extraction

```typescript
const githubExtractor: LinkExtractor
const jiraExtractor: LinkExtractor
const urlExtractor: LinkExtractor

class LinkExtractorRegistry {
  register(extractor: LinkExtractor): void
  unregister(name: string): void
  extract(content: string, context: ExtractorContext): ExtractedLink[]
}

function extractLinks(content: string, context: ExtractorContext): ExtractedLink[]
```

### Views

```typescript
class ViewRenderer {
  constructor(graph: EntityGraph, definition: ViewDefinition)
  render(): Promise<ViewRenderResult[]>
}

function refreshView(graph: EntityGraph, definition: ViewDefinition): Promise<ViewRefreshResult>

interface ViewRenderResult {
  entity: Entity;
  path: string;
  content: string;
}

interface ViewRefreshResult {
  refreshed: boolean;
  count: number;
  paths: string[];
}
```

---

## Skills (`hardcopy/skills`)

### Types

```typescript
interface SkillDefinition {
  id: string;
  uri: string;                         // e.g. "skill:planning/SKILL.md"
  name: string;
  description: string;
  instructions: string;
  resources?: SkillResource[];
  triggers: SkillTrigger[];
  tools: string[];                     // Service namespaces
  model?: ModelPreference;
  version?: string;
  dependencies?: string[];
  path?: string;
}

interface SkillTrigger {
  eventFilter: EventFilter;
  condition?: string;                  // JS expression or Cypher-like
  priority?: number;
}

interface SkillResource {
  path: string;
  content: string;
}

interface ModelPreference {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

interface SkillContext {
  event?: unknown;
  entities: unknown[];
  services: string[];
  history?: unknown[];
  params?: Record<string, unknown>;
  parentSessionId?: string;
}

interface SkillResult {
  skillId: string;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
  events?: unknown[];
}

interface SkillSummary {
  id: string;
  uri: string;
  name: string;
  description: string;
  triggerCount: number;
  toolCount: number;
}

interface DependencyResolution {
  resolved: boolean;
  missing: string[];
  available: string[];
}
```

### SkillRegistry

```typescript
class SkillRegistry {
  constructor(options: SkillRegistryOptions)
  
  setServiceRegistry(registry: ServiceRegistry): void
  resolveDependencies(skill: SkillDefinition): Promise<DependencyResolution>
  
  register(skill: SkillDefinition): Promise<void>
  unregister(skillId: string): Promise<void>
  list(): Promise<SkillSummary[]>
  get(skillId: string): Promise<SkillDefinition | null>
  search(query: string): Promise<SkillDefinition[]>
  getAll(): SkillDefinition[]
  
  findByTrigger(eventType: string, data?: unknown): Promise<SkillDefinition[]>
  execute(skillId: string, context: SkillContext): Promise<SkillResult>
  handleEvent(event: Envelope): Promise<SkillResult[]>
}

interface SkillRegistryOptions {
  db: Database;
  graph?: EntityGraph;
  eventBus?: EventBus;
  executor?: SkillExecutor;
  serviceRegistry?: ServiceRegistry;
}

type SkillExecutor = (skill: SkillDefinition, context: SkillContext) => Promise<SkillResult>
```

### Skill Scanning

```typescript
function scanForSkills(directory: string): Promise<SkillDefinition[]>
function parseSkillFile(path: string): Promise<SkillDefinition>
function watchSkillChanges(
  directory: string,
  callback: (event: "add" | "change" | "unlink", skill: SkillDefinition) => void
): FSWatcher
```

### Triggers

```typescript
function matchEvent(event: Envelope, skills: SkillDefinition[]): TriggerMatch[]
function groupByPriority(matches: TriggerMatch[]): Map<number, TriggerMatch[]>
function getHighestPriority(matches: TriggerMatch[]): TriggerMatch[]

interface TriggerMatch {
  skill: SkillDefinition;
  trigger: SkillTrigger;
  priority: number;
}
```

---

## Orchestrator (`hardcopy/orchestrator`)

### Types

```typescript
type SessionStatus = "pending" | "running" | "complete" | "failed" | "cancelled";

interface Session {
  id: string;
  skillId: string;
  status: SessionStatus;
  events: string[];
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  parentSessionId?: string;
}

interface SessionConfig {
  skillId: string;
  model?: ModelConfig;
  context: SkillContext;
  parentSessionId?: string;
}

interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

interface SessionFilter {
  status?: SessionStatus[];
  skillId?: string;
  since?: string;
  limit?: number;
}

interface RouteResult {
  skill: SkillDefinition;
  context: SkillContext;
  priority: number;
}

interface ProgressEvent {
  sessionId: string;
  type: "started" | "chunk" | "tool_call" | "tool_result" | "complete" | "error";
  timestamp: string;
  data: unknown;
}

interface ExternalNotifier {
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>;
  sendCompletion(session: Session): Promise<void>;
}
```

### LLMOrchestrator

```typescript
class LLMOrchestrator {
  constructor(config: OrchestratorConfig)
  
  start(): void
  stop(): void
  
  startSession(config: SessionConfig): Promise<Session>
  getSession(sessionId: string): Promise<Session | null>
  cancelSession(sessionId: string): Promise<void>
  listSessions(filter?: SessionFilter): Promise<Session[]>
  
  onEvent(handler: (event: Envelope) => void): () => void
}

function createOrchestrator(config: OrchestratorConfig): LLMOrchestrator

interface OrchestratorConfig {
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  entityGraph: EntityGraph;
  defaultModel?: ModelConfig;
  maxRetries?: number;             // default: 3
  retryDelay?: number;             // ms, default: 1000
  maxConcurrent?: number;          // default: 10
  notifiers?: ExternalNotifier[];
  ignorePatterns?: string[];       // event types to ignore
}
```

### Session Management

```typescript
class SessionManager {
  constructor(eventBus: EventBus)
  
  create(config: SessionConfig): Promise<Session>
  get(sessionId: string): Promise<Session | null>
  list(filter?: SessionFilter): Promise<Session[]>
  updateStatus(sessionId: string, status: SessionStatus): Promise<void>
  setResult(sessionId: string, result: unknown): Promise<void>
  setError(sessionId: string, error: string): Promise<void>
  cancel(sessionId: string): Promise<void>
}
```

### Event Router

```typescript
class EventRouter {
  constructor(config: RouterConfig)
  
  route(event: Envelope): Promise<RouteResult[]>
  buildContext(event: Envelope, skill: SkillDefinition): Promise<SkillContext>
  selectModel(skill: SkillDefinition): ModelConfig
}

interface RouterConfig {
  skillRegistry: SkillRegistry;
  entityGraph: EntityGraph;
  defaultModel?: ModelConfig;
}
```

### Notifiers

```typescript
class GitHubNotifier implements ExternalNotifier {
  constructor(config: GitHubNotifierConfig)
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>
  sendCompletion(session: Session): Promise<void>
}

interface GitHubNotifierConfig {
  token: string;
  owner: string;
  repo: string;
}

class JiraNotifier implements ExternalNotifier {
  constructor(config: JiraNotifierConfig)
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>
  sendCompletion(session: Session): Promise<void>
}

interface JiraNotifierConfig {
  baseUrl: string;
  email: string;
  token: string;
}

class CompositeNotifier implements ExternalNotifier {
  constructor(notifiers: ExternalNotifier[])
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>
  sendCompletion(session: Session): Promise<void>
}
```

---

## Event Type Conventions

| Pattern | Example | Description |
|---------|---------|-------------|
| `{provider}.{resource}.{action}` | `github.issue.opened` | External provider events |
| `schedule.triggered` | `schedule.triggered` | Scheduled events |
| `stream.{namespace}.{procedure}.{event}` | `stream.openai.chat.item` | Stream bridge events |
| `llm.{session}.{event}` | `llm.abc123.chunk` | LLM session events |
| `skill.{event}` | `skill.execution.success` | Skill lifecycle events |
| `service.{event}` | `service.registered` | Service registry events |
| `cache.invalidate.{namespace}` | `cache.invalidate.weather` | Cache invalidation |

## URI Conventions

| Scheme | Pattern | Example |
|--------|---------|---------|
| `github` | `github:{owner}/{repo}#{number}` | `github:AprovanLabs/hardcopy#42` |
| `jira` | `jira:{project}-{number}` | `jira:PROJ-123` |
| `file` | `file:{path}[@{version}]` | `file:src/index.ts@abc123` |
| `skill` | `skill:{path}` | `skill:planning/SKILL.md` |
| `service` | `service:{namespace}` | `service:github` |
| `user` | `user:{id}` | `user:12345` |
