import type { Node, Change, FetchRequest, FetchResult, PushResult } from "./types";

export interface Entity {
  uri: string;
  type: string;
  attrs: Record<string, unknown>;
  etag?: string;
  syncedAt?: number;
}

export interface SyncResult {
  entity: Entity;
  raw: unknown;
  etag?: string;
}

export interface SyncAdapter {
  name: string;
  fetch(uri: string): Promise<SyncResult>;
  push(uri: string, changes: Change[]): Promise<PushResult>;
  canHandle(uri: string): boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters?: Record<string, unknown>;
}

export interface Provider {
  name: string;
  fetch(request: FetchRequest): Promise<FetchResult>;
  push(node: Node, changes: Change[]): Promise<PushResult>;
  fetchNode(nodeId: string): Promise<Node | null>;
  getTools(): Tool[];
}

export type ProviderFactory = (config: Record<string, unknown>) => Provider;

const providers = new Map<string, ProviderFactory>();
const adapters = new Map<string, SyncAdapter>();

export function registerProvider(name: string, factory: ProviderFactory): void {
  providers.set(name, factory);
}

export function getProvider(name: string): ProviderFactory | undefined {
  return providers.get(name);
}

export function listProviders(): string[] {
  return Array.from(providers.keys());
}

export function registerAdapter(adapter: SyncAdapter): void {
  adapters.set(adapter.name, adapter);
}

export function getAdapter(name: string): SyncAdapter | undefined {
  return adapters.get(name);
}

export function getAdapterForUri(uri: string): SyncAdapter | undefined {
  for (const adapter of adapters.values()) {
    if (adapter.canHandle(uri)) {
      return adapter;
    }
  }
  return undefined;
}

export function listAdapters(): SyncAdapter[] {
  return Array.from(adapters.values());
}
