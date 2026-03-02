import type { Entity, SyncAdapter } from "./provider";
import type { Change, PushResult } from "./types";
import {
  diff,
  merge,
  renderView,
  parseView,
} from "./hardcopy/sync-engine";
import type { MergeStrategy, ViewFormat } from "./hardcopy/sync-engine";
import { getAdapterForUri, listAdapters } from "./provider";

export interface ServiceDefinition {
  namespace: string;
  version: string;
  procedures: ProcedureDefinition[];
}

export interface ProcedureDefinition {
  name: string;
  description: string;
  input: Record<string, string>;
  output: Record<string, string>;
}

export interface FetchInput {
  uri: string;
}

export interface FetchOutput {
  entity: Entity;
  raw: unknown;
  etag?: string;
}

export interface PushInput {
  uri: string;
  changes: Change[];
}

export interface PushOutput {
  result: PushResult;
}

export interface DiffInput {
  local: Entity;
  remote: Entity;
}

export interface DiffOutput {
  changes: Change[];
}

export interface SyncInput {
  uri: string;
  strategy?: MergeStrategy;
  local?: Entity;
}

export interface SyncOutput {
  entity: Entity;
  changes: Change[];
}

export const hardcopyService: ServiceDefinition = {
  namespace: "hardcopy",
  version: "1.0.0",
  procedures: [
    {
      name: "fetch",
      description: "Fetch entity from remote",
      input: { uri: "string" },
      output: { entity: "Entity", raw: "unknown", etag: "string?" },
    },
    {
      name: "push",
      description: "Push changes to remote",
      input: { uri: "string", changes: "Change[]" },
      output: { result: "PushResult" },
    },
    {
      name: "diff",
      description: "Diff local and remote entities",
      input: { local: "Entity", remote: "Entity" },
      output: { changes: "Change[]" },
    },
    {
      name: "sync",
      description: "Full sync cycle with merge",
      input: { uri: "string", strategy: "MergeStrategy?", local: "Entity?" },
      output: { entity: "Entity", changes: "Change[]" },
    },
  ],
};

export async function hardcopyFetch(input: FetchInput): Promise<FetchOutput> {
  const adapter = getAdapterForUri(input.uri);
  if (!adapter) {
    throw new Error(`No adapter found for URI: ${input.uri}`);
  }

  const result = await adapter.fetch(input.uri);
  return {
    entity: result.entity,
    raw: result.raw,
    etag: result.etag,
  };
}

export async function hardcopyPush(input: PushInput): Promise<PushOutput> {
  const adapter = getAdapterForUri(input.uri);
  if (!adapter) {
    throw new Error(`No adapter found for URI: ${input.uri}`);
  }

  const result = await adapter.push(input.uri, input.changes);
  return { result };
}

export function hardcopyDiff(input: DiffInput): DiffOutput {
  const changes = diff(input.local, input.remote);
  return { changes };
}

export async function hardcopySync(input: SyncInput): Promise<SyncOutput> {
  const adapter = getAdapterForUri(input.uri);
  if (!adapter) {
    throw new Error(`No adapter found for URI: ${input.uri}`);
  }

  const remoteResult = await adapter.fetch(input.uri);
  const remote = remoteResult.entity;

  if (!input.local) {
    return { entity: remote, changes: [] };
  }

  const changes = diff(input.local, remote);
  const strategy = input.strategy ?? "field-level";
  const merged = await merge(input.local, remote, strategy);

  return { entity: merged, changes };
}

export interface HardcopyServiceHandler {
  fetch(input: FetchInput): Promise<FetchOutput>;
  push(input: PushInput): Promise<PushOutput>;
  diff(input: DiffInput): DiffOutput;
  sync(input: SyncInput): Promise<SyncOutput>;
  renderView(entity: Entity, format: ViewFormat): string;
  parseView(content: string, format: ViewFormat): Partial<Entity>;
  listAdapters(): SyncAdapter[];
}

export function createHardcopyServiceHandler(): HardcopyServiceHandler {
  return {
    fetch: hardcopyFetch,
    push: hardcopyPush,
    diff: hardcopyDiff,
    sync: hardcopySync,
    renderView,
    parseView,
    listAdapters,
  };
}
