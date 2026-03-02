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
import type { LinkExtractor } from "./graph/types";
import type { FormatHandler } from "./format";
import type { WebhookInferrer } from "./events/types";

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

export interface ProviderContrib {
  name: string;
  createProvider: () => Provider;
  linkExtractors?: LinkExtractor[];
  formatHandlers?: FormatHandler[];
  webhookInferrers?: WebhookInferrer[];
  uriPatterns?: Record<string, Record<string, RegExp>>;
  uriComponentExtractors?: Record<string, (uri: string) => Record<string, string> | null>;
}

const providers = new Map<string, ProviderFactory>();
const contribs = new Map<string, ProviderContrib>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name, factory);
}

export function getProvider(name: string): ProviderFactory | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function registerContrib(contrib: ProviderContrib): void {
  contribs.set(contrib.name, contrib);
  registerProvider(contrib.name, () => contrib.createProvider());
}

export function getContrib(name: string): ProviderContrib | undefined {
  return contribs.get(name);
}

export function listContribs(): ProviderContrib[] {
  return Array.from(contribs.values());
}
