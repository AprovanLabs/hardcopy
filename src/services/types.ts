export interface ServiceSource {
  type: "mcp" | "http" | "grpc" | "local";
  config: McpSourceConfig | HttpSourceConfig | GrpcSourceConfig | LocalSourceConfig;
}

export interface McpSourceConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface HttpSourceConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  auth?: {
    type: "bearer" | "basic" | "api-key";
    token?: string;
    username?: string;
    password?: string;
    header?: string;
    key?: string;
  };
}

export interface GrpcSourceConfig {
  address: string;
  protoPath?: string;
  tls?: boolean;
}

export interface LocalSourceConfig {
  handler: string;
}

export interface TypeReference {
  name: string;
  namespace?: string;
}

export interface TypeDefinition {
  name: string;
  schema: JsonSchema;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  items?: JsonSchema;
  required?: string[];
  enum?: unknown[];
  description?: string;
  default?: unknown;
  [key: string]: unknown;
}

export interface ProcedureDefinition {
  name: string;
  description: string;
  input: JsonSchema;
  output: JsonSchema;
  streaming?: boolean;
  cacheTtl?: number;
}

export interface ServiceDefinition {
  namespace: string;
  version: string;
  source: ServiceSource;
  procedures: ProcedureDefinition[];
  types: TypeDefinition[];
}

export interface ServiceSummary {
  namespace: string;
  version: string;
  sourceType: string;
  procedureCount: number;
}

export interface CacheEntry {
  key: string;
  value: unknown;
  expiresAt: number;
  etag?: string;
  lastModified?: string;
}

export interface ServiceRegistry {
  register(service: ServiceDefinition): Promise<void>;
  unregister(namespace: string): Promise<void>;
  list(): Promise<ServiceSummary[]>;
  get(namespace: string): Promise<ServiceDefinition | null>;
  search(query: string): Promise<ServiceDefinition[]>;
  call(namespace: string, procedure: string, args: unknown): Promise<unknown>;
  stream(namespace: string, procedure: string, args: unknown): AsyncIterable<unknown>;
  getSchema(namespace: string, typeName: string): Promise<JsonSchema | null>;
}
