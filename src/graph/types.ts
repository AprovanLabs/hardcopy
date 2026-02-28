export interface ParsedUri {
  scheme: string;
  path: string;
  fragment?: string;
  version?: string;
  raw: string;
}

export interface Entity {
  uri: string;
  type: string;
  attrs: Record<string, unknown>;
  version?: string;
  syncedAt?: string;
  links?: EntityLink[];
}

export interface EntityLink {
  type: string;
  targetUri: string;
  attrs?: Record<string, unknown>;
}

export interface LinkExtractor {
  name: string;
  patterns: RegExp[];
  extract(content: string, context?: ExtractorContext): ExtractedLink[];
}

export interface ExtractorContext {
  sourceUri?: string;
  sourceType?: string;
}

export interface ExtractedLink {
  targetUri: string;
  linkType: string;
  position?: { start: number; end: number };
}

export interface ViewDefinition {
  name: string;
  query: string;
  path: string;
  format: "markdown" | "json" | "yaml";
  template?: string;
  ttl?: number;
}

export interface EntityGraph {
  upsert(entity: Entity): Promise<void>;
  upsertBatch(entities: Entity[]): Promise<void>;
  get(uri: string, version?: string): Promise<Entity | null>;
  delete(uri: string): Promise<void>;
  link(fromUri: string, toUri: string, type: string, attrs?: Record<string, unknown>): Promise<void>;
  unlink(fromUri: string, toUri: string, type: string): Promise<void>;
  query(cypher: string, params?: Record<string, unknown>): Promise<Entity[]>;
  traverse(uri: string, depth?: number): Promise<Entity[]>;
  inferSchema(type: string): Promise<Record<string, unknown>>;
}
