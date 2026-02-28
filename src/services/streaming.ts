import { randomUUID } from "node:crypto";
import type { EventBus, Envelope } from "../events/types";
import type { ProcedureDefinition } from "./types";

export interface StreamingAdapter {
  connect(): Promise<void>;
  stream(procedure: string, args: unknown): AsyncIterable<unknown>;
  close(): Promise<void>;
}

export interface WebSocketAdapterConfig {
  url: string;
  protocols?: string[];
  headers?: Record<string, string>;
  reconnectAttempts?: number;
  reconnectDelayMs?: number;
}

export class WebSocketAdapter implements StreamingAdapter {
  private config: WebSocketAdapterConfig;
  private ws: WebSocket | null = null;
  private messageHandlers = new Map<string, (data: unknown) => void>();
  private reconnectCount = 0;
  private isConnected = false;

  constructor(config: WebSocketAdapterConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url, this.config.protocols);

        this.ws.onopen = () => {
          this.isConnected = true;
          this.reconnectCount = 0;
          resolve();
        };

        this.ws.onerror = (event) => {
          if (!this.isConnected) {
            reject(new Error(`WebSocket connection failed`));
          }
        };

        this.ws.onclose = () => {
          this.isConnected = false;
          this.tryReconnect();
        };

        this.ws.onmessage = (event) => {
          try {
            const message = JSON.parse(String(event.data));
            const id = message.id ?? message.requestId;
            if (id && this.messageHandlers.has(id)) {
              this.messageHandlers.get(id)!(message.data ?? message.result ?? message);
            }
          } catch {}
        };
      } catch (err) {
        reject(err);
      }
    });
  }

  private async tryReconnect(): Promise<void> {
    const maxAttempts = this.config.reconnectAttempts ?? 3;
    const delay = this.config.reconnectDelayMs ?? 1000;

    if (this.reconnectCount >= maxAttempts) return;

    this.reconnectCount++;
    await this.sleep(delay * this.reconnectCount);
    try {
      await this.connect();
    } catch {}
  }

  async *stream(procedure: string, args: unknown): AsyncIterable<unknown> {
    if (!this.ws || !this.isConnected) {
      await this.connect();
    }

    const requestId = randomUUID();
    const queue: unknown[] = [];
    let resolve: (() => void) | null = null;
    let done = false;

    this.messageHandlers.set(requestId, (data) => {
      if (data === null || (typeof data === "object" && (data as Record<string, unknown>).done)) {
        done = true;
        resolve?.();
        return;
      }
      queue.push(data);
      resolve?.();
    });

    try {
      this.ws!.send(
        JSON.stringify({
          id: requestId,
          method: procedure,
          params: args,
        })
      );

      while (!done) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        if (done) break;
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    } finally {
      this.messageHandlers.delete(requestId);
    }
  }

  async close(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.isConnected = false;
    this.messageHandlers.clear();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export interface SSEAdapterConfig {
  url: string;
  headers?: Record<string, string>;
}

export class SSEAdapter implements StreamingAdapter {
  private config: SSEAdapterConfig;

  constructor(config: SSEAdapterConfig) {
    this.config = config;
  }

  async connect(): Promise<void> {}

  async *stream(procedure: string, args: unknown): AsyncIterable<unknown> {
    const url = new URL(this.config.url);
    url.pathname = `${url.pathname}/${procedure}`.replace(/\/+/g, "/");
    url.searchParams.set("args", JSON.stringify(args));

    const response = await fetch(url.toString(), {
      method: "GET",
      headers: {
        Accept: "text/event-stream",
        ...this.config.headers,
      },
    });

    if (!response.ok || !response.body) {
      throw new Error(`SSE connection failed: ${response.status}`);
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
  }

  async close(): Promise<void> {}
}

export interface StreamEventBridgeConfig {
  source: string;
  eventBus: EventBus;
  typePrefix?: string;
}

export function createStreamEventBridge(config: StreamEventBridgeConfig) {
  const { source, eventBus, typePrefix = "stream" } = config;

  return {
    async *bridge<T>(
      streamId: string,
      stream: AsyncIterable<T>,
      transform?: (item: T) => unknown
    ): AsyncIterable<T> {
      const type = `${typePrefix}.${streamId}`;

      await eventBus.publish(createStreamEnvelope(type, source, "start", { streamId }));

      let index = 0;
      try {
        for await (const item of stream) {
          const data = transform ? transform(item) : item;
          await eventBus.publish(
            createStreamEnvelope(type, source, "data", {
              streamId,
              index: index++,
              data,
            })
          );
          yield item;
        }
        await eventBus.publish(
          createStreamEnvelope(type, source, "complete", {
            streamId,
            totalItems: index,
          })
        );
      } catch (err) {
        await eventBus.publish(
          createStreamEnvelope(type, source, "error", {
            streamId,
            error: err instanceof Error ? err.message : String(err),
            index,
          })
        );
        throw err;
      }
    },

    async bridgeToEvents<T>(
      streamId: string,
      stream: AsyncIterable<T>,
      transform?: (item: T) => unknown
    ): Promise<void> {
      for await (const _ of this.bridge(streamId, stream, transform)) {
      }
    },
  };
}

function createStreamEnvelope(
  type: string,
  source: string,
  phase: "start" | "data" | "complete" | "error",
  data: unknown
): Envelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type: `${type}.${phase}`,
    source,
    data,
    metadata: { phase },
  };
}

export function markStreamingProcedures(
  procedures: ProcedureDefinition[],
  streamingNames: string[]
): ProcedureDefinition[] {
  return procedures.map((proc) => ({
    ...proc,
    streaming: streamingNames.includes(proc.name) || proc.streaming,
  }));
}
