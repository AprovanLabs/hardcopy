import type { HardcopyDatabase } from "./db";
import type { Provider } from "./provider";
import type { Event, EventFilter, EventPage, Stream } from "./types";

type Subscriber = (events: Event[]) => void;
type Unsubscribe = () => void;
type Detach = () => void;

export class EventBus {
  private db: HardcopyDatabase;
  private subscribers = new Map<string, Set<Subscriber>>();
  private detachers = new Map<string, Detach>();
  private streams = new Map<string, Stream>();

  constructor(db: HardcopyDatabase) {
    this.db = db;
  }

  registerStream(stream: Stream): void {
    this.streams.set(stream.name, stream);
  }

  getStreams(): Stream[] {
    return Array.from(this.streams.values());
  }

  async emit(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    await this.db.insertEvents(events);

    for (const [key, subs] of this.subscribers) {
      const matching = events.filter((e) => this.matchesFilter(e, key));
      if (matching.length > 0) {
        for (const sub of subs) {
          try {
            sub(matching);
          } catch {
            // subscriber error, ignore
          }
        }
      }
    }
  }

  subscribe(filter: EventFilter, callback: Subscriber): Unsubscribe {
    const key = this.filterKey(filter);
    let subs = this.subscribers.get(key);
    if (!subs) {
      subs = new Set();
      this.subscribers.set(key, subs);
    }
    subs.add(callback);
    return () => {
      subs!.delete(callback);
      if (subs!.size === 0) {
        this.subscribers.delete(key);
      }
    };
  }

  async query(stream: string, filter: EventFilter, limit?: number, cursor?: string): Promise<EventPage> {
    return this.db.queryStreamEvents(stream, filter, limit, cursor);
  }

  async attach(provider: Provider, streamName: string): Promise<Detach> {
    if (!provider.subscribe) {
      throw new Error(`Provider ${provider.name} does not support streaming`);
    }

    const key = `${provider.name}:${streamName}`;
    if (this.detachers.has(key)) {
      return this.detachers.get(key)!;
    }

    let cancelled = false;
    const iterator = provider.subscribe(streamName);

    const run = async () => {
      try {
        for await (const batch of iterator) {
          if (cancelled) break;
          await this.emit(batch);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(`Stream ${key} error:`, err);
        }
      }
    };

    run();

    const detach = () => {
      cancelled = true;
      this.detachers.delete(key);
    };

    this.detachers.set(key, detach);
    return detach;
  }

  async prune(stream: string): Promise<number> {
    const streamDef = this.streams.get(stream);
    if (!streamDef?.retention) return 0;
    return this.db.pruneEvents(stream, streamDef.retention);
  }

  async detachAll(): Promise<void> {
    for (const detach of this.detachers.values()) {
      detach();
    }
    this.detachers.clear();
  }

  private filterKey(filter: EventFilter): string {
    return JSON.stringify(filter);
  }

  private matchesFilter(event: Event, filterKey: string): boolean {
    const filter: EventFilter = JSON.parse(filterKey);
    if (filter.types && !filter.types.includes(event.type)) return false;
    if (filter.since && event.timestamp < filter.since) return false;
    if (filter.until && event.timestamp > filter.until) return false;
    if (filter.sourceId && event.sourceId !== filter.sourceId) return false;
    if (filter.parentId && event.parentId !== filter.parentId) return false;
    return true;
  }
}
