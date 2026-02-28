import { randomUUID } from "node:crypto";
import type { EventBus, Envelope, Subscription } from "../events/types";
import type { EntityGraph } from "../graph/types";
import type { SkillRegistry } from "../skills/registry";
import type { SkillDefinition, SkillContext, SkillExecutionContext } from "../skills/types";
import type {
  Session,
  SessionConfig,
  SessionFilter,
  Orchestrator,
  ModelConfig,
  ExternalNotifier,
  ProgressEvent,
} from "./types";
import { SessionManager } from "./session";
import { EventRouter } from "./router";

export interface OrchestratorConfig {
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  entityGraph: EntityGraph;
  defaultModel?: ModelConfig;
  maxRetries?: number;
  retryDelay?: number;
  maxConcurrent?: number;
  notifiers?: ExternalNotifier[];
  ignorePatterns?: string[];
}

export class LLMOrchestrator implements Orchestrator {
  private config: OrchestratorConfig;
  private sessionManager: SessionManager;
  private router: EventRouter;
  private eventHandlers: Array<(event: Envelope) => void> = [];
  private subscription: Subscription | null = null;
  private running = 0;
  private queue: Array<{ skill: SkillDefinition; context: SkillContext }> = [];

  constructor(config: OrchestratorConfig) {
    this.config = config;
    this.sessionManager = new SessionManager(config.eventBus);
    this.router = new EventRouter({
      skillRegistry: config.skillRegistry,
      entityGraph: config.entityGraph,
      defaultModel: config.defaultModel,
    });
  }

  start(): void {
    if (this.subscription) return;

    this.subscription = this.config.eventBus.subscribe(
      { types: ["*"] },
      async (event: Envelope) => {
        await this.handleEvent(event);
        for (const handler of this.eventHandlers) {
          handler(event);
        }
      }
    );
  }

  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  async startSession(config: SessionConfig): Promise<Session> {
    const session = await this.sessionManager.create(config);
    await this.sessionManager.updateStatus(session.id, "running");

    this.executeSession(session.id, config).catch(async (err) => {
      await this.sessionManager.setError(
        session.id,
        err instanceof Error ? err.message : String(err)
      );
    });

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    return this.sessionManager.get(sessionId);
  }

  async cancelSession(sessionId: string): Promise<void> {
    await this.sessionManager.cancel(sessionId);
  }

  async listSessions(filter?: SessionFilter): Promise<Session[]> {
    return this.sessionManager.list(filter);
  }

  onEvent(handler: (event: Envelope) => void): () => void {
    this.eventHandlers.push(handler);
    return () => {
      const idx = this.eventHandlers.indexOf(handler);
      if (idx >= 0) this.eventHandlers.splice(idx, 1);
    };
  }

  private async handleEvent(event: Envelope): Promise<void> {
    if (this.shouldIgnore(event.type)) return;

    const routes = await this.router.route(event);
    if (routes.length === 0) return;

    for (const route of routes) {
      const model = this.router.selectModel(route.skill);
      const executionContext: SkillContext = {
        event: route.context.event,
        entities: route.context.entities,
        services: route.context.services,
        params: route.context.params,
        parentSessionId: event.metadata?.sessionId as string | undefined,
      };

      const maxConcurrent = this.config.maxConcurrent ?? 10;
      if (this.running >= maxConcurrent) {
        this.queue.push({ skill: route.skill, context: executionContext });
        continue;
      }

      this.executeSkill(route.skill, executionContext, model);
    }
  }

  private async executeSkill(
    skill: SkillDefinition,
    context: SkillContext,
    model: ModelConfig
  ): Promise<void> {
    this.running++;
    let retries = 0;
    const maxRetries = this.config.maxRetries ?? 3;
    const retryDelay = this.config.retryDelay ?? 1000;

    try {
      const session = await this.sessionManager.create({
        skillId: skill.id,
        model,
        context: {
          event: context.event,
          entities: context.entities ?? [],
          services: context.services ?? [],
          params: context.params,
        },
        parentSessionId: context.parentSessionId,
      });

      await this.sessionManager.updateStatus(session.id, "running");

      while (retries <= maxRetries) {
        try {
          const result = await this.config.skillRegistry.execute(skill.id, {
          event: context.event,
          entities: context.entities ?? [],
          services: context.services ?? [],
          params: context.params,
        });
          await this.sessionManager.setResult(session.id, result);
          await this.notifyCompletion(session);
          break;
        } catch (err) {
          retries++;
          if (retries > maxRetries) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            await this.sessionManager.setError(session.id, errorMsg);
            throw err;
          }
          await this.delay(retryDelay * retries);
        }
      }
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private async executeSession(sessionId: string, config: SessionConfig): Promise<void> {
    const skill = await this.config.skillRegistry.get(config.skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${config.skillId}`);
    }

    const model = this.router.selectModel(skill);
    const context: SkillContext = {
      event: config.context.event,
      entities: config.context.entities,
      services: config.context.services,
      params: config.context.params,
      parentSessionId: config.parentSessionId,
    };

    let retries = 0;
    const maxRetries = this.config.maxRetries ?? 3;
    const retryDelay = this.config.retryDelay ?? 1000;

    while (retries <= maxRetries) {
      try {
        const result = await this.config.skillRegistry.execute(skill.id, {
          event: context.event,
          entities: context.entities ?? [],
          services: context.services ?? [],
          params: context.params,
        });
        await this.sessionManager.setResult(sessionId, result);
        const session = await this.sessionManager.get(sessionId);
        if (session) {
          await this.notifyCompletion(session);
        }
        return;
      } catch (err) {
        retries++;
        if (retries > maxRetries) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          await this.sessionManager.setError(sessionId, errorMsg);
          throw err;
        }
        await this.delay(retryDelay * retries);
      }
    }
  }

  private processQueue(): void {
    const maxConcurrent = this.config.maxConcurrent ?? 10;
    while (this.queue.length > 0 && this.running < maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        const model = this.router.selectModel(next.skill);
        this.executeSkill(next.skill, next.context, model);
      }
    }
  }

  private async notifyCompletion(session: Session): Promise<void> {
    if (!this.config.notifiers?.length) return;

    for (const notifier of this.config.notifiers) {
      try {
        await notifier.sendCompletion(session);
      } catch {}
    }
  }

  private shouldIgnore(eventType: string): boolean {
    const ignorePatterns = this.config.ignorePatterns ?? [
      "llm.*",
      "skill.execution.*",
      "skill.registered",
      "skill.unregistered",
    ];

    for (const pattern of ignorePatterns) {
      if (pattern === eventType) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -1);
        if (eventType.startsWith(prefix)) return true;
      }
    }

    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

export function createOrchestrator(config: OrchestratorConfig): LLMOrchestrator {
  return new LLMOrchestrator(config);
}
