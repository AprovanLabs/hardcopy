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

type ServiceAdapter = {
  call(procedure: string, args: unknown): Promise<unknown>;
  stream?(procedure: string, args: unknown): AsyncIterable<unknown>;
  close?(): Promise<void>;
};

export class ServiceRegistry implements IServiceRegistry {
  private store: ServiceStore;
  private adapters = new Map<string, ServiceAdapter>();
  private localHandlers = new Map<string, (procedure: string, args: unknown) => Promise<unknown>>();

  constructor(store: ServiceStore) {
    this.store = store;
  }

  async register(service: ServiceDefinition): Promise<void> {
    this.store.upsert(service);
    await this.initializeAdapter(service);
  }

  async unregister(namespace: string): Promise<void> {
    const adapter = this.adapters.get(namespace);
    if (adapter?.close) {
      await adapter.close();
    }
    this.adapters.delete(namespace);
    this.store.delete(namespace);
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

    if (proc.cacheTtl) {
      const cacheKey = this.buildCacheKey(namespace, procedure, args);
      const cached = this.store.getCache(cacheKey);
      if (cached) return cached.value;
    }

    let adapter = this.adapters.get(namespace);
    if (!adapter) {
      await this.initializeAdapter(service);
      adapter = this.adapters.get(namespace);
    }

    if (!adapter) {
      throw new Error(`No adapter available for service: ${namespace}`);
    }

    const result = await adapter.call(procedure, args);

    if (proc.cacheTtl) {
      const cacheKey = this.buildCacheKey(namespace, procedure, args);
      this.store.setCache({
        key: cacheKey,
        value: result,
        expiresAt: Date.now() + proc.cacheTtl * 1000,
      });
    }

    return result;
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
      async call(procedure: string, args: unknown): Promise<unknown> {
        const url = `${config.baseUrl}/${procedure}`;
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
          ...config.headers,
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

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return response.json();
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
    for (const [, adapter] of this.adapters) {
      if (adapter.close) {
        await adapter.close();
      }
    }
    this.adapters.clear();
  }
}
