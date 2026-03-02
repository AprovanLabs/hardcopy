import { randomUUID } from "node:crypto";
import type {
  ServiceDefinition,
  ServiceSummary,
  ServiceRegistry as IServiceRegistry,
  JsonSchema,
  ProcedureDefinition,
  HttpSourceConfig,
  McpSourceConfig,
} from "./types";
import type { ServiceStore } from "./store";
import type { EventBus, Envelope, Subscription } from "../events/types";
import { createSimpleStreamBridge } from "./streaming";

type ServiceAdapter = {
  call(procedure: string, args: unknown, conditionalHeaders?: Record<string, string>): Promise<unknown>;
  stream?(procedure: string, args: unknown): AsyncIterable<unknown>;
  close?(): Promise<void>;
};

type EntityTypeRegistrar = (
  namespace: string,
  types: Array<{ name: string; schema: JsonSchema }>
) => Promise<void>;

export class ServiceRegistry implements IServiceRegistry {
  private store: ServiceStore;
  private adapters = new Map<string, ServiceAdapter>();
  private localHandlers = new Map<string, (procedure: string, args: unknown) => Promise<unknown>>();
  private eventBus: EventBus | null = null;
  private cacheInvalidationSub: Subscription | null = null;
  private entityTypeRegistrar: EntityTypeRegistrar | null = null;

  constructor(store: ServiceStore) {
    this.store = store;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
    this.setupCacheInvalidation();
  }

  setEntityTypeRegistrar(registrar: EntityTypeRegistrar): void {
    this.entityTypeRegistrar = registrar;
  }

  private setupCacheInvalidation(): void {
    if (!this.eventBus) return;

    this.cacheInvalidationSub = this.eventBus.subscribe(
      { types: ["cache.invalidate.*", "service.*.updated"] },
      async (envelope: Envelope) => {
        const data = envelope.data as { namespace?: string; procedure?: string } | undefined;
        if (data?.namespace) {
          this.invalidateCache(data.namespace, data.procedure);
        }
      }
    );
  }

  async register(service: ServiceDefinition): Promise<void> {
    this.store.upsert(service);
    await this.initializeAdapter(service);
    await this.registerEntityTypes(service);
    await this.emitServiceEvent("service.registered", service);
  }

  private async registerEntityTypes(service: ServiceDefinition): Promise<void> {
    if (!this.entityTypeRegistrar || service.types.length === 0) return;

    const entityTypes = service.types.map((t) => ({
      name: t.name.includes(".") ? t.name : `${service.namespace}.${t.name}`,
      schema: t.schema,
    }));

    await this.entityTypeRegistrar(service.namespace, entityTypes);
  }

  private async emitServiceEvent(type: string, service: ServiceDefinition): Promise<void> {
    if (!this.eventBus) return;

    const envelope: Envelope = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      source: "service-registry",
      subject: `service:${service.namespace}`,
      data: {
        namespace: service.namespace,
        version: service.version,
        procedureCount: service.procedures.length,
        typeCount: service.types.length,
      },
      metadata: {},
    };

    await this.eventBus.publish(envelope);
  }

  async unregister(namespace: string): Promise<void> {
    const service = this.store.get(namespace);
    const adapter = this.adapters.get(namespace);
    if (adapter?.close) {
      await adapter.close();
    }
    this.adapters.delete(namespace);
    this.store.delete(namespace);

    if (service && this.eventBus) {
      await this.emitServiceEvent("service.unregistered", service);
    }
  }

  async list(): Promise<ServiceSummary[]> {
    return this.store.list();
  }

  async get(namespace: string): Promise<ServiceDefinition | null> {
    return this.store.get(namespace);
  }

  async search(query: string): Promise<ServiceDefinition[]> {
    return this.store.search(query);
  }

  async call(namespace: string, procedure: string, args: unknown): Promise<unknown> {
    const service = this.store.get(namespace);
    if (!service) {
      throw new Error(`Service not found: ${namespace}`);
    }

    const proc = service.procedures.find((p) => p.name === procedure);
    if (!proc) {
      throw new Error(`Procedure not found: ${namespace}.${procedure}`);
    }

    const cacheKey = this.buildCacheKey(namespace, procedure, args);
    const cached = proc.cacheTtl ? this.store.getCache(cacheKey) : null;

    if (cached && !this.isExpiringSoon(cached.expiresAt)) {
      return cached.value;
    }

    let adapter = this.adapters.get(namespace);
    if (!adapter) {
      await this.initializeAdapter(service);
      adapter = this.adapters.get(namespace);
    }

    if (!adapter) {
      throw new Error(`No adapter available for service: ${namespace}`);
    }

    const conditionalHeaders: Record<string, string> = {};
    if (cached?.etag) {
      conditionalHeaders["If-None-Match"] = cached.etag;
    }
    if (cached?.lastModified) {
      conditionalHeaders["If-Modified-Since"] = cached.lastModified;
    }

    const callResult = await adapter.call(procedure, args, conditionalHeaders);

    if (callResult && typeof callResult === "object" && "__notModified" in callResult) {
      if (cached && proc.cacheTtl) {
        this.store.setCache({
          ...cached,
          expiresAt: Date.now() + proc.cacheTtl * 1000,
        });
      }
      return cached?.value;
    }

    const hasHttpMeta = callResult && typeof callResult === "object" && "__data" in callResult;
    const data = hasHttpMeta ? (callResult as { __data: unknown }).__data : callResult;
    const etag: string | undefined = hasHttpMeta
      ? (callResult as { __etag?: unknown }).__etag as string | undefined
      : undefined;
    const lastModified: string | undefined = hasHttpMeta
      ? (callResult as { __lastModified?: unknown }).__lastModified as string | undefined
      : undefined;

    if (proc.cacheTtl) {
      this.store.setCache({
        key: cacheKey,
        value: data,
        expiresAt: Date.now() + proc.cacheTtl * 1000,
        etag,
        lastModified,
      });
    }

    return data;
  }

  private isExpiringSoon(expiresAt: number): boolean {
    return expiresAt - Date.now() < 10000;
  }

  async *stream(namespace: string, procedure: string, args: unknown): AsyncIterable<unknown> {
    const service = this.store.get(namespace);
    if (!service) {
      throw new Error(`Service not found: ${namespace}`);
    }

    const proc = service.procedures.find((p) => p.name === procedure);
    if (!proc?.streaming) {
      throw new Error(`Procedure ${namespace}.${procedure} does not support streaming`);
    }

    let adapter = this.adapters.get(namespace);
    if (!adapter) {
      await this.initializeAdapter(service);
      adapter = this.adapters.get(namespace);
    }

    if (!adapter?.stream) {
      throw new Error(`Service ${namespace} does not support streaming`);
    }

    yield* adapter.stream(procedure, args);
  }

  streamWithBridge(namespace: string, procedure: string, args: unknown): AsyncIterable<unknown> {
    const service = this.store.get(namespace);
    if (!service) {
      throw new Error(`Service not found: ${namespace}`);
    }

    const adapter = this.adapters.get(namespace);
    if (!adapter?.stream) {
      throw new Error(`Service ${namespace} does not support streaming`);
    }

    const rawStream = adapter.stream(procedure, args);

    if (!this.eventBus) {
      return rawStream;
    }

    const bridge = createSimpleStreamBridge({
      source: `service:${namespace}`,
      eventBus: this.eventBus,
      typePrefix: `stream.${namespace}.${procedure}`,
    });

    return bridge.bridge(`${namespace}.${procedure}`, rawStream);
  }

  async getSchema(namespace: string, typeName: string): Promise<JsonSchema | null> {
    const service = this.store.get(namespace);
    if (!service) return null;
    const typeDef = service.types.find((t) => t.name === typeName);
    return typeDef?.schema ?? null;
  }

  registerLocalHandler(
    namespace: string,
    handler: (procedure: string, args: unknown) => Promise<unknown>
  ): void {
    this.localHandlers.set(namespace, handler);
  }

  invalidateCache(namespace: string, procedure?: string): void {
    this.store.pruneCache();
  }

  private async initializeAdapter(service: ServiceDefinition): Promise<void> {
    switch (service.source.type) {
      case "http":
        this.adapters.set(
          service.namespace,
          this.createHttpAdapter(service.source.config as HttpSourceConfig, service.procedures)
        );
        break;
      case "mcp":
        this.adapters.set(
          service.namespace,
          await this.createMcpAdapter(service.source.config as McpSourceConfig)
        );
        break;
      case "local":
        this.adapters.set(service.namespace, this.createLocalAdapter(service.namespace));
        break;
      case "grpc":
        throw new Error("gRPC adapter not yet implemented");
    }
  }

  private createHttpAdapter(
    config: HttpSourceConfig,
    procedures: ProcedureDefinition[]
  ): ServiceAdapter {
    return {
      async call(procedure: string, args: unknown, conditionalHeaders?: Record<string, string>): Promise<unknown> {
        const url = `${config.baseUrl}/${procedure}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...config.headers,
          ...conditionalHeaders,
        };

        if (config.auth) {
          switch (config.auth.type) {
            case "bearer":
              headers["Authorization"] = `Bearer ${config.auth.token}`;
              break;
            case "basic":
              headers["Authorization"] = `Basic ${Buffer.from(
                `${config.auth.username}:${config.auth.password}`
              ).toString("base64")}`;
              break;
            case "api-key":
              headers[config.auth.header ?? "X-API-Key"] = config.auth.key ?? "";
              break;
          }
        }

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        });

        if (response.status === 304) {
          return { __notModified: true };
        }

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const etag = response.headers.get("ETag") ?? undefined;
        const lastModified = response.headers.get("Last-Modified") ?? undefined;
        const data = await response.json();

        if (etag || lastModified) {
          return { __data: data, __etag: etag, __lastModified: lastModified };
        }
        return data;
      },

      async *stream(procedure: string, args: unknown): AsyncIterable<unknown> {
        const url = `${config.baseUrl}/${procedure}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
          ...config.headers,
        };

        const response = await fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(args),
        });

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (line.startsWith("data: ")) {
                const data = line.slice(6);
                if (data === "[DONE]") return;
                try {
                  yield JSON.parse(data);
                } catch {
                  yield data;
                }
              }
            }
          }
        } finally {
          reader.releaseLock();
        }
      },
    };
  }

  private async createMcpAdapter(config: McpSourceConfig): Promise<ServiceAdapter> {
    const { spawn } = await import("node:child_process");
    const proc = spawn(config.command, config.args ?? [], {
      env: { ...globalThis.process.env, ...config.env },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let messageId = 0;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    let buffer = "";

    proc.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) {
              p.reject(new Error(msg.error.message));
            } else {
              p.resolve(msg.result);
            }
          }
        } catch {}
      }
    });

    return {
      async call(procedure: string, args: unknown): Promise<unknown> {
        const id = ++messageId;
        const request = {
          jsonrpc: "2.0",
          id,
          method: `tools/call`,
          params: { name: procedure, arguments: args },
        };

        return new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          proc.stdin.write(JSON.stringify(request) + "\n");
        });
      },

      async close(): Promise<void> {
        proc.kill();
      },
    };
  }

  private createLocalAdapter(namespace: string): ServiceAdapter {
    return {
      call: async (procedure: string, args: unknown): Promise<unknown> => {
        const handler = this.localHandlers.get(namespace);
        if (!handler) {
          throw new Error(`No local handler registered for ${namespace}`);
        }
        return handler(procedure, args);
      },
    };
  }

  private buildCacheKey(namespace: string, procedure: string, args: unknown): string {
    const argsHash = JSON.stringify(args);
    return `${namespace}:${procedure}:${argsHash}`;
  }

  async close(): Promise<void> {
    if (this.cacheInvalidationSub) {
      this.cacheInvalidationSub.unsubscribe();
      this.cacheInvalidationSub = null;
    }

    for (const adapter of this.adapters.values()) {
      if (adapter.close) {
        await adapter.close();
      }
    }
    this.adapters.clear();
  }
}
