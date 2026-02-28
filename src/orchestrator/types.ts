import type { SkillDefinition, SkillContext } from "../skills/types";
import type { Envelope } from "../events/types";

export type SessionStatus = "pending" | "running" | "complete" | "failed" | "cancelled";

export interface Session {
  id: string;
  skillId: string;
  status: SessionStatus;
  events: string[];
  result?: unknown;
  error?: string;
  startedAt: string;
  completedAt?: string;
  parentSessionId?: string;
}

export interface SessionConfig {
  skillId: string;
  model?: ModelConfig;
  context: SkillContext;
  parentSessionId?: string;
}

export interface ModelConfig {
  provider: string;
  model: string;
  temperature?: number;
  maxTokens?: number;
  timeout?: number;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
  error?: string;
}

export interface LLMChunk {
  sessionId: string;
  index: number;
  content: string;
  role?: "assistant" | "tool";
  toolCallId?: string;
}

export interface ProgressEvent {
  sessionId: string;
  type: "started" | "chunk" | "tool_call" | "tool_result" | "complete" | "error";
  timestamp: string;
  data: unknown;
}

export interface Orchestrator {
  startSession(config: SessionConfig): Promise<Session>;
  getSession(sessionId: string): Promise<Session | null>;
  cancelSession(sessionId: string): Promise<void>;
  listSessions(filter?: SessionFilter): Promise<Session[]>;
  onEvent(handler: (event: Envelope) => void): () => void;
}

export interface SessionFilter {
  status?: SessionStatus[];
  skillId?: string;
  since?: string;
  limit?: number;
}

export interface RouteResult {
  skill: SkillDefinition;
  context: SkillContext;
  priority: number;
}

export interface ExternalNotifier {
  sendProgress(session: Session, progress: ProgressEvent): Promise<void>;
  sendCompletion(session: Session): Promise<void>;
}
