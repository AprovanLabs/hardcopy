import { randomUUID } from "node:crypto";
import type { EventBus, Envelope } from "../events/types";
import type {
  Session,
  SessionStatus,
  SessionConfig,
  SessionFilter,
  ProgressEvent,
} from "./types";

export class SessionManager {
  private sessions = new Map<string, Session>();
  private eventBus: EventBus;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  async create(config: SessionConfig): Promise<Session> {
    const session: Session = {
      id: randomUUID(),
      skillId: config.skillId,
      status: "pending",
      events: [],
      startedAt: new Date().toISOString(),
      parentSessionId: config.parentSessionId,
    };

    this.sessions.set(session.id, session);
    await this.emitProgress(session, "started", { config });
    return session;
  }

  async get(sessionId: string): Promise<Session | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async updateStatus(sessionId: string, status: SessionStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.status = status;
    if (status === "complete" || status === "failed" || status === "cancelled") {
      session.completedAt = new Date().toISOString();
    }
  }

  async setResult(sessionId: string, result: unknown): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.result = result;
    session.status = "complete";
    session.completedAt = new Date().toISOString();
    await this.emitProgress(session, "complete", { result });
  }

  async setError(sessionId: string, error: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    session.error = error;
    session.status = "failed";
    session.completedAt = new Date().toISOString();
    await this.emitProgress(session, "error", { error });
  }

  async cancel(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== "running") return;

    session.status = "cancelled";
    session.completedAt = new Date().toISOString();
    await this.emitProgress(session, "complete", { cancelled: true });
  }

  async list(filter?: SessionFilter): Promise<Session[]> {
    let sessions = Array.from(this.sessions.values());

    if (filter?.status?.length) {
      sessions = sessions.filter((s) => filter.status!.includes(s.status));
    }
    if (filter?.skillId) {
      sessions = sessions.filter((s) => s.skillId === filter.skillId);
    }
    if (filter?.since) {
      sessions = sessions.filter((s) => s.startedAt >= filter.since!);
    }

    sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));

    if (filter?.limit) {
      sessions = sessions.slice(0, filter.limit);
    }

    return sessions;
  }

  async addEvent(sessionId: string, eventId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.events.push(eventId);
    }
  }

  async emitChunk(sessionId: string, index: number, content: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await this.eventBus.publish({
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: `llm.${sessionId}.chunk`,
      source: "orchestrator",
      subject: `session:${sessionId}`,
      data: { index, content },
      metadata: { sessionId },
    });
  }

  async emitToolCall(
    sessionId: string,
    toolCallId: string,
    name: string,
    args: Record<string, unknown>
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await this.emitProgress(session, "tool_call", {
      toolCallId,
      name,
      arguments: args,
    });
  }

  async emitToolResult(
    sessionId: string,
    toolCallId: string,
    result: unknown
  ): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    await this.emitProgress(session, "tool_result", {
      toolCallId,
      result,
    });
  }

  private async emitProgress(
    session: Session,
    type: ProgressEvent["type"],
    data: unknown
  ): Promise<void> {
    const eventId = randomUUID();
    const event: Envelope = {
      id: eventId,
      timestamp: new Date().toISOString(),
      type: `llm.${session.id}.${type}`,
      source: "orchestrator",
      subject: `session:${session.id}`,
      data,
      metadata: {
        sessionId: session.id,
        skillId: session.skillId,
        parentSessionId: session.parentSessionId,
      },
    };

    await this.eventBus.publish(event);
    session.events.push(eventId);
  }
}
