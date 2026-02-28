import { randomUUID } from "node:crypto";
import type {
  Envelope,
  EventFilter,
  EventHandler,
  EventPage,
  QueryOptions,
  Subscription,
  EventBus as IEventBus,
  BatchConfig,
} from "./types";
import type { EventStore } from "./store";

interface HandlerEntry {
  id: string;
  filter: EventFilter;
  handler: EventHandler;
  maxRetries: number;
}

export class EventBus implements IEventBus {
  private store: EventStore;
  private handlers = new Map<string, HandlerEntry>();
  private streamListeners = new Map<string, Set<(e: Envelope) => void>>();
  private batchBuffer: Envelope[] = [];
  private batchTimer: ReturnType<typeof setTimeout> | null = null;
  private batchConfig: BatchConfig | null = null;
  private seenIds = new Set<string>();

  constructor(store: EventStore) {
    this.store = store;
  }

  setBatchConfig(config: BatchConfig): void {
    this.batchConfig = config;
  }

  async publish(envelope: Envelope): Promise<void> {
    if (this.batchConfig) {
      this.addToBatch(envelope);
      return;
    }
    await this.processEnvelope(envelope);
  }

  async publishBatch(envelopes: Envelope[]): Promise<void> {
    if (envelopes.length === 0) return;
    const unique = this.dedupeEnvelopes(envelopes);
    this.store.insertBatch(unique);
    await this.routeEnvelopes(unique);
  }

  subscribe(filter: EventFilter, handler: EventHandler, maxRetries = 3): Subscription {
    const id = randomUUID();
    this.handlers.set(id, { id, filter, handler, maxRetries });
    return {
      unsubscribe: () => {
        this.handlers.delete(id);
      },
    };
  }

  async *stream(filter: EventFilter): AsyncIterable<Envelope> {
    const listenerId = randomUUID();
    const queue: Envelope[] = [];
    let resolve: (() => void) | null = null;

    const listener = (envelope: Envelope) => {
      if (this.matchesFilter(envelope, filter)) {
        queue.push(envelope);
        resolve?.();
      }
    };

    let listeners = this.streamListeners.get("*");
    if (!listeners) {
      listeners = new Set();
      this.streamListeners.set("*", listeners);
    }
    listeners.add(listener);

    try {
      while (true) {
        while (queue.length > 0) {
          yield queue.shift()!;
        }
        await new Promise<void>((r) => {
          resolve = r;
        });
        resolve = null;
      }
    } finally {
      listeners.delete(listener);
      if (listeners.size === 0) {
        this.streamListeners.delete("*");
      }
    }
  }

  async query(filter: EventFilter, options?: QueryOptions): Promise<EventPage> {
    return this.store.query(filter, options);
  }

  async search(query: string, filter?: EventFilter, options?: QueryOptions): Promise<EventPage> {
    return this.store.search(query, filter, options);
  }

  async replayDeadLetter(envelopeId: string, handlerId: string): Promise<boolean> {
    const entries = this.store.getDeadLetterEntries(handlerId);
    const entry = entries.find((e) => e.envelope.id === envelopeId);
    if (!entry) return false;

    const handlerEntry = this.handlers.get(handlerId);
    if (!handlerEntry) return false;

    try {
      await handlerEntry.handler(entry.envelope);
      this.store.removeDeadLetter(envelopeId, handlerId);
      return true;
    } catch {
      return false;
    }
  }

  private async processEnvelope(envelope: Envelope): Promise<void> {
    this.store.insert(envelope);
    await this.routeEnvelope(envelope);
    this.notifyStreamListeners(envelope);
  }

  private addToBatch(envelope: Envelope): void {
    this.batchBuffer.push(envelope);
    if (this.batchBuffer.length >= this.batchConfig!.maxSize) {
      this.flushBatch();
      return;
    }
    if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => this.flushBatch(), this.batchConfig!.maxWaitMs);
    }
  }

  private async flushBatch(): Promise<void> {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batchBuffer.length === 0) return;

    const envelopes = this.dedupeEnvelopes(this.batchBuffer);
    this.batchBuffer = [];
    this.store.insertBatch(envelopes);
    await this.routeEnvelopes(envelopes);
    for (const e of envelopes) {
      this.notifyStreamListeners(e);
    }
  }

  private dedupeEnvelopes(envelopes: Envelope[]): Envelope[] {
    if (!this.batchConfig?.dedupeKey) return envelopes;
    const seen = new Map<string, Envelope>();
    for (const e of envelopes) {
      const key = this.batchConfig.dedupeKey(e);
      if (!this.seenIds.has(key)) {
        seen.set(key, e);
        this.seenIds.add(key);
        if (this.seenIds.size > 10000) {
          const toDelete = Array.from(this.seenIds).slice(0, 5000);
          for (const k of toDelete) this.seenIds.delete(k);
        }
      }
    }
    return Array.from(seen.values());
  }

  private async routeEnvelope(envelope: Envelope): Promise<void> {
    for (const entry of this.handlers.values()) {
      if (this.matchesFilter(envelope, entry.filter)) {
        await this.deliverWithRetry(envelope, entry);
      }
    }
  }

  private async routeEnvelopes(envelopes: Envelope[]): Promise<void> {
    for (const envelope of envelopes) {
      await this.routeEnvelope(envelope);
    }
  }

  private async deliverWithRetry(envelope: Envelope, entry: HandlerEntry): Promise<void> {
    let lastError: Error | null = null;
    for (let attempt = 0; attempt < entry.maxRetries; attempt++) {
      try {
        await entry.handler(envelope);
        return;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < entry.maxRetries - 1) {
          await this.sleep(Math.pow(2, attempt) * 100);
        }
      }
    }
    this.store.insertDeadLetter({
      envelope,
      error: lastError?.message ?? "Unknown error",
      attempts: entry.maxRetries,
      lastAttempt: new Date().toISOString(),
      handlerId: entry.id,
    });
  }

  private notifyStreamListeners(envelope: Envelope): void {
    const listeners = this.streamListeners.get("*");
    if (listeners) {
      for (const listener of listeners) {
        listener(envelope);
      }
    }
  }

  private matchesFilter(envelope: Envelope, filter: EventFilter): boolean {
    if (filter.types?.length) {
      const matches = filter.types.some((pattern) => this.matchPattern(envelope.type, pattern));
      if (!matches) return false;
    }

    if (filter.sources?.length) {
      const matches = filter.sources.some((pattern) => this.matchPattern(envelope.source, pattern));
      if (!matches) return false;
    }

    if (filter.subjects?.length && envelope.subject) {
      const matches = filter.subjects.some((pattern) =>
        this.matchPattern(envelope.subject!, pattern)
      );
      if (!matches) return false;
    } else if (filter.subjects?.length && !envelope.subject) {
      return false;
    }

    if (filter.since && envelope.timestamp < filter.since) return false;
    if (filter.until && envelope.timestamp > filter.until) return false;

    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        const metaValue = envelope.metadata[key];
        if (metaValue !== value) return false;
      }
    }

    return true;
  }

  private matchPattern(value: string, pattern: string): boolean {
    if (!pattern.includes("*")) return value === pattern;
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );
    return regex.test(value);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createEnvelope(
  type: string,
  source: string,
  data: unknown,
  options: { subject?: string; metadata?: Record<string, unknown> } = {}
): Envelope {
  return {
    id: randomUUID(),
    timestamp: new Date().toISOString(),
    type,
    source,
    subject: options.subject,
    data,
    metadata: options.metadata ?? {},
  };
}
