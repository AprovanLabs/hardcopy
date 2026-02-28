export interface Node {
  id: string;
  type: string;
  attrs: Record<string, unknown>;
  syncedAt?: number;
  versionToken?: string;
  cursor?: string;
}

export interface Edge {
  id?: number;
  type: string;
  fromId: string;
  toId: string;
  attrs?: Record<string, unknown>;
}

export interface FetchRequest {
  query: NodeQuery;
  cursor?: string;
  pageSize?: number;
  versionToken?: string;
  syncedAt?: number;
  strategy?: "full" | "incremental";
}

export interface FetchResult {
  nodes: Node[];
  edges: Edge[];
  cursor?: string;
  hasMore: boolean;
  versionToken?: string | null;
  cached?: boolean;
}

export interface PushResult {
  success: boolean;
  error?: string;
  versionToken?: string;
}

export interface NodeQuery {
  id?: string;
  type?: string;
  attrs?: Record<string, unknown>;
}

export interface Change {
  field: string;
  oldValue: unknown;
  newValue: unknown;
}

export interface SyncDecision {
  strategy: "auto" | "llm" | "manual";
  reason: string;
}

export interface SyncError {
  resourceId: string;
  strategy: "auto" | "llm";
  error: string;
  llmExplanation?: string;
  suggestedActions?: string[];
}

export interface SyncPolicy {
  interval: number;
  strategy: "full" | "incremental";
}

export interface IndexState {
  cursor?: string;
  total?: number;
  loaded: number;
  pageSize: number;
  lastFetch: string;
  ttl: number;
}

export interface Event {
  id: string;
  stream: string;
  type: string;
  timestamp: number;
  attrs: Record<string, unknown>;
  sourceId?: string;
  parentId?: string;
}

export interface Stream {
  name: string;
  provider: string;
  description?: string;
  schema?: Record<string, unknown>;
  retention?: {
    maxAge?: number;
    maxCount?: number;
  };
}

export interface SubscribeOptions {
  filter?: EventFilter;
  cursor?: string;
  batchSize?: number;
  batchWindow?: number;
}

export interface EventFilter {
  types?: string[];
  since?: number;
  until?: number;
  attrs?: Record<string, unknown>;
  sourceId?: string;
  parentId?: string;
}

export interface EventPage {
  events: Event[];
  cursor?: string;
  hasMore: boolean;
}

export enum ConflictStatus {
  CLEAN = "clean",
  REMOTE_ONLY = "remote",
  DIVERGED = "diverged",
}

export interface ThreeWayState {
  base: unknown;
  local: unknown;
  remote: unknown;
}

export interface FieldConflict {
  field: string;
  status: ConflictStatus;
  base: unknown;
  local: unknown;
  remote: unknown;
  canAutoMerge: boolean;
}

export interface ConflictInfo {
  nodeId: string;
  nodeType: string;
  filePath: string;
  viewRelPath: string;
  detectedAt: number;
  fields: FieldConflict[];
}
