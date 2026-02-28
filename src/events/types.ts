export interface Envelope {
  id: string;
  timestamp: string;
  type: string;
  source: string;
  subject?: string;
  data: unknown;
  metadata: Record<string, unknown>;
}

export interface EventFilter {
  types?: string[];
  sources?: string[];
  subjects?: string[];
  since?: string;
  until?: string;
  metadata?: Record<string, unknown>;
}

export interface QueryOptions {
  limit?: number;
  cursor?: string;
  order?: "asc" | "desc";
}

export interface EventPage {
  events: Envelope[];
  cursor?: string;
  hasMore: boolean;
}

export type EventHandler = (envelope: Envelope) => Promise<void>;

export interface Subscription {
  unsubscribe: () => void;
}

export interface EventBus {
  publish(envelope: Envelope): Promise<void>;
  publishBatch(envelopes: Envelope[]): Promise<void>;
  subscribe(filter: EventFilter, handler: EventHandler): Subscription;
  stream(filter: EventFilter): AsyncIterable<Envelope>;
  query(filter: EventFilter, options?: QueryOptions): Promise<EventPage>;
}

export interface DeadLetterEntry {
  envelope: Envelope;
  error: string;
  attempts: number;
  lastAttempt: string;
  handlerId: string;
}

export interface BatchConfig {
  maxSize: number;
  maxWaitMs: number;
  dedupeKey?: (e: Envelope) => string;
}
