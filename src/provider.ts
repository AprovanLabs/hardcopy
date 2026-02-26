import type {
  Node,
  Change,
  FetchRequest,
  FetchResult,
  PushResult,
  Stream,
  Event,
  SubscribeOptions,
  EventFilter,
  EventPage,
} from "./types";

export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface Provider {
  name: string;
  nodeTypes: string[];
  edgeTypes: string[];

  fetch(request: FetchRequest): Promise<FetchResult>;
  push(node: Node, changes: Change[]): Promise<PushResult>;
  fetchNode(nodeId: string): Promise<Node | null>;
  getTools(): Tool[];

  streams?: Stream[];
  subscribe?(stream: string, options?: SubscribeOptions): AsyncIterable<Event[]>;
  query?(stream: string, filter: EventFilter): Promise<EventPage>;
}

export type ProviderFactory = (config: Record<string, unknown>) => Provider;

const providers = new Map<string, ProviderFactory>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name, factory);
}

export function getProvider(name: string): ProviderFactory | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}
