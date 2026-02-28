import type { EventFilter } from "../events/types";

export interface SkillTrigger {
  eventFilter: EventFilter;
  condition?: string;
  priority?: number;
}

export interface SkillTool {
  name: string;
  service?: string;
  procedure?: string;
}

export interface TriggerMetadata {
  event?: string;
  types?: string[];
  sources?: string[];
  subjects?: string[];
  condition?: string;
  priority?: number;
}

export interface ToolMetadata {
  name: string;
  service?: string;
  procedure?: string;
}

export interface SkillMetadata {
  name?: string;
  description?: string;
  triggers?: TriggerMetadata[];
  tools?: (string | ToolMetadata)[];
  model?: {
    provider?: string;
    name?: string;
    temperature?: number;
    maxTokens?: number;
  };
  dependencies?: string[];
}

export interface SkillResource {
  path: string;
  content: string;
}

export interface ModelPreference {
  provider?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}

export interface SkillDefinition {
  id: string;
  uri: string;
  name: string;
  description: string;
  instructions: string;
  resources?: SkillResource[];
  triggers: SkillTrigger[];
  tools: string[];
  model?: ModelPreference;
  version?: string;
  dependencies?: string[];
  path?: string;
}

export interface SkillSummary {
  id: string;
  uri: string;
  name: string;
  description: string;
  triggerCount: number;
  toolCount: number;
}

export interface SkillContext {
  event?: unknown;
  entities: unknown[];
  services: string[];
  history?: unknown[];
  params?: Record<string, unknown>;
}

export interface SkillExecutionContext {
  event?: unknown;
  entities?: unknown[];
  services?: string[];
  params?: Record<string, unknown>;
  parentSessionId?: string;
}

export interface SkillResult {
  skillId: string;
  status: "success" | "error" | "cancelled";
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
  events?: unknown[];
}

export interface SkillRegistry {
  register(skill: SkillDefinition): Promise<void>;
  unregister(skillId: string): Promise<void>;
  list(): Promise<SkillSummary[]>;
  get(skillId: string): Promise<SkillDefinition | null>;
  search(query: string): Promise<SkillDefinition[]>;
  execute(skillId: string, context: SkillContext | SkillExecutionContext): Promise<SkillResult>;
  findByTrigger(eventType: string, eventData?: unknown): Promise<SkillDefinition[]>;
}
