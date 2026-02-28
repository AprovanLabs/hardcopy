import type { EventBus, Envelope, Subscription } from "../events/types";
import type { SkillRegistry } from "./registry";
import type { SkillDefinition, SkillExecutionContext } from "./types";
import { randomUUID } from "node:crypto";

export interface TriggerSystemConfig {
  eventBus: EventBus;
  skillRegistry: SkillRegistry;
  onSkillTriggered?: (skill: SkillDefinition, event: Envelope) => Promise<void>;
  onSkillComplete?: (skill: SkillDefinition, event: Envelope, result: unknown) => void;
  onSkillError?: (skill: SkillDefinition, event: Envelope, error: Error) => void;
  maxConcurrent?: number;
  ignorePatterns?: string[];
}

export class TriggerSystem {
  private config: TriggerSystemConfig;
  private subscription: Subscription | null = null;
  private running = 0;
  private queue: Array<{ skill: SkillDefinition; event: Envelope }> = [];

  constructor(config: TriggerSystemConfig) {
    this.config = config;
  }

  start(): void {
    if (this.subscription) return;

    this.subscription = this.config.eventBus.subscribe(
      { types: ["*"] },
      async (envelope: Envelope) => {
        await this.handleEvent(envelope);
      }
    );
  }

  stop(): void {
    if (this.subscription) {
      this.subscription.unsubscribe();
      this.subscription = null;
    }
  }

  private async handleEvent(envelope: Envelope): Promise<void> {
    if (this.shouldIgnore(envelope.type)) return;

    const skills = await this.config.skillRegistry.findByTrigger(
      envelope.type,
      envelope.data
    );

    for (const skill of skills) {
      const maxConcurrent = this.config.maxConcurrent ?? 10;
      if (this.running >= maxConcurrent) {
        this.queue.push({ skill, event: envelope });
        continue;
      }

      this.executeSkill(skill, envelope);
    }
  }

  private async executeSkill(skill: SkillDefinition, event: Envelope): Promise<void> {
    this.running++;

    try {
      const context: SkillExecutionContext = {
        event: event.data,
        parentSessionId: event.metadata?.sessionId as string | undefined,
      };

      if (this.config.onSkillTriggered) {
        await this.config.onSkillTriggered(skill, event);
      }

      await this.config.eventBus.publish({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.execution.started",
        source: "trigger-system",
        subject: skill.uri,
        data: {
          skillId: skill.id,
          eventId: event.id,
          eventType: event.type,
        },
        metadata: {},
      });

      const result = await this.config.skillRegistry.execute(skill.id, context);

      await this.config.eventBus.publish({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.execution.completed",
        source: "trigger-system",
        subject: skill.uri,
        data: {
          skillId: skill.id,
          eventId: event.id,
          result,
        },
        metadata: {},
      });

      if (this.config.onSkillComplete) {
        this.config.onSkillComplete(skill, event, result);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));

      await this.config.eventBus.publish({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.execution.failed",
        source: "trigger-system",
        subject: skill.uri,
        data: {
          skillId: skill.id,
          eventId: event.id,
          error: error.message,
        },
        metadata: {},
      });

      if (this.config.onSkillError) {
        this.config.onSkillError(skill, event, error);
      }
    } finally {
      this.running--;
      this.processQueue();
    }
  }

  private processQueue(): void {
    const maxConcurrent = this.config.maxConcurrent ?? 10;
    while (this.queue.length > 0 && this.running < maxConcurrent) {
      const next = this.queue.shift();
      if (next) {
        this.executeSkill(next.skill, next.event);
      }
    }
  }

  private shouldIgnore(eventType: string): boolean {
    const ignorePatterns = this.config.ignorePatterns ?? [
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
}

export function createTriggerSystem(config: TriggerSystemConfig): TriggerSystem {
  return new TriggerSystem(config);
}
