import { readFile } from "fs/promises";
import yaml from "yaml";
import type { SyncPolicy } from "./types";

export interface LinkConfig {
  edge: string;
  to: string;
  match: string;
}

export type PipeTransport =
  | { type: "exec"; command: string; args?: string[]; cwd?: string; env?: Record<string, string> }
  | { type: "socket"; path: string }
  | { type: "file"; path: string; follow?: boolean }
  | { type: "http"; port: number; path?: string }
  | { type: "tcp"; host: string; port: number };

export type PipeCodec =
  | { type: "lines" }
  | { type: "jsonl" }
  | { type: "sse" }
  | { type: "chunks"; size?: number };

export interface PipeConfig {
  transport: PipeTransport;
  codec: PipeCodec;
  stream: string;
  sourceId?: string;
  retention?: { maxAge?: number; maxCount?: number };
}

export interface SourceConfig {
  name: string;
  provider: string;
  orgs?: string[];
  repositories?: { path: string }[];
  links?: LinkConfig[];
  sync?: Partial<SyncPolicy>;
  pipes?: PipeConfig[];
  [key: string]: unknown;
}

export interface RenderConfig {
  path: string;
  type?: string;
  template?: string;
  args?: Record<string, unknown>;
}

export interface ViewEventConfig {
  stream: string;
  filter?: {
    since?: string;
    types?: string[];
  };
  join?: {
    on: string;
    to: string;
  };
}

export interface ViewConfig {
  path: string;
  description?: string;
  query: string;
  partition?: {
    by: string;
    fallback?: string;
  };
  render: RenderConfig[];
  events?: ViewEventConfig;
}

export type MatchCondition =
  | string
  | number
  | boolean
  | { contains: string }
  | { pattern: string };

export type TransitionCondition =
  | { added: string }
  | { removed: string }
  | { from: unknown; to: unknown };

export interface HookTrigger {
  type: string;
  source?: string;
  created?: boolean;
  updated?: boolean;
  match?: Record<string, MatchCondition>;
  transition?: Record<string, TransitionCondition>;
}

export interface HookConfig {
  name: string;
  on: HookTrigger;
  run: string;
  cwd?: string;
  env?: Record<string, string>;
  background?: boolean;
}

export interface Config {
  services?: string;
  sources: SourceConfig[];
  views: ViewConfig[];
  hooks?: HookConfig[];
}

export async function loadConfig(path: string): Promise<Config> {
  const content = await readFile(path, "utf-8");
  return parseConfig(content);
}

export function parseConfig(content: string): Config {
  const parsed = yaml.parse(content);
  return validateConfig(parsed);
}

function validateConfig(data: unknown): Config {
  if (!data || typeof data !== "object") {
    throw new Error("Config must be an object");
  }

  const config = data as Record<string, unknown>;

  return {
    services: typeof config["services"] === "string" ? config["services"] : undefined,
    sources: validateSources(config["sources"]),
    views: validateViews(config["views"]),
    hooks: validateHooks(config["hooks"]),
  };
}

function validateSources(data: unknown): SourceConfig[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((s, i) => {
    if (!s || typeof s !== "object") {
      throw new Error(`Source ${i} must be an object`);
    }
    const source = s as Record<string, unknown>;
    if (typeof source["name"] !== "string") {
      throw new Error(`Source ${i} must have a name`);
    }
    if (typeof source["provider"] !== "string") {
      throw new Error(`Source ${i} must have a provider`);
    }
    return source as unknown as SourceConfig;
  });
}

function validateViews(data: unknown): ViewConfig[] {
  if (!Array.isArray(data)) {
    return [];
  }
  return data.map((v, i) => {
    if (!v || typeof v !== "object") {
      throw new Error(`View ${i} must be an object`);
    }
    const view = v as Record<string, unknown>;
    if (typeof view["path"] !== "string") {
      throw new Error(`View ${i} must have a path`);
    }
    if (typeof view["query"] !== "string") {
      throw new Error(`View ${i} must have a query`);
    }
    if (!Array.isArray(view["render"])) {
      throw new Error(`View ${i} must have render configs`);
    }
    return view as unknown as ViewConfig;
  });
}

function validateHooks(data: unknown): HookConfig[] | undefined {
  if (!Array.isArray(data)) return undefined;
  return data.map((h, i) => {
    if (!h || typeof h !== "object") throw new Error(`Hook ${i} must be an object`);
    const hook = h as Record<string, unknown>;
    if (typeof hook["name"] !== "string") throw new Error(`Hook ${i} must have a name`);
    if (!hook["on"] || typeof hook["on"] !== "object") throw new Error(`Hook ${i} must have an 'on' trigger`);
    if (typeof hook["run"] !== "string") throw new Error(`Hook ${i} must have a run command`);
    const on = hook["on"] as Record<string, unknown>;
    if (typeof on["type"] !== "string") throw new Error(`Hook ${i}.on must have a type`);
    return hook as unknown as HookConfig;
  });
}
