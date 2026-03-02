import type { Envelope } from "../events/types";
import type { EntityGraph, Entity } from "../graph/types";
import type { SkillRegistry } from "../skills/registry";
import type { SkillDefinition, SkillContext } from "../skills/types";
import type { RouteResult, ModelConfig } from "./types";

export interface RouterConfig {
  skillRegistry: SkillRegistry;
  entityGraph?: EntityGraph;
  defaultModel?: ModelConfig;
}

export class EventRouter {
  private config: RouterConfig;

  constructor(config: RouterConfig) {
    this.config = config;
  }

  async route(event: Envelope): Promise<RouteResult[]> {
    const skills = await this.config.skillRegistry.findByTrigger(event.type);

    const results: RouteResult[] = [];

    for (const skill of skills) {
      const context = await this.buildContext(event, skill);
      const priority = this.getHighestPriority(skill, event.type);

      results.push({ skill, context, priority });
    }

    return results.sort((a, b) => b.priority - a.priority);
  }

  async buildContext(event: Envelope, skill: SkillDefinition): Promise<SkillContext> {
    const relatedEntities = await this.getRelatedEntities(event);
    const requiredServices = skill.dependencies ?? [];

    return {
      event: event.data,
      entities: relatedEntities,
      services: requiredServices,
      params: {
        eventId: event.id,
        eventType: event.type,
        eventSource: event.source,
        eventSubject: event.subject,
        eventTimestamp: event.timestamp,
        ...event.metadata,
      },
    };
  }

  selectModel(skill: SkillDefinition): ModelConfig {
    if (skill.model) {
      return {
        provider: skill.model.provider ?? "openai",
        model: skill.model.model ?? "gpt-4",
        temperature: skill.model.temperature,
        maxTokens: skill.model.maxTokens,
      };
    }

    return this.config.defaultModel ?? {
      provider: "openai",
      model: "gpt-4",
      temperature: 0.7,
    };
  }

  private async getRelatedEntities(event: Envelope): Promise<Entity[]> {
    const entities: Entity[] = [];
    const entityGraph = this.config.entityGraph;
    if (!entityGraph) return entities;

    if (event.subject) {
      try {
        const subjectEntity = await entityGraph.get(event.subject);
        if (subjectEntity) {
          entities.push(subjectEntity);
          const related = await entityGraph.traverse(event.subject, 1);
          for (const entity of related) {
            if (entity.uri !== event.subject) {
              entities.push(entity);
            }
          }
        }
      } catch {}
    }

    const data = event.data as Record<string, unknown> | undefined;
    if (data?.uri && typeof data.uri === "string") {
      try {
        const entity = await entityGraph.get(data.uri);
        if (entity && !entities.some((e) => e.uri === entity.uri)) {
          entities.push(entity);
        }
      } catch {}
    }

    return entities;
  }

  private getHighestPriority(skill: SkillDefinition, eventType: string): number {
    let highest = 0;
    for (const trigger of skill.triggers) {
      if (this.matchesEventType(trigger.eventFilter.types ?? [], eventType)) {
        const priority = trigger.priority ?? 0;
        if (priority > highest) {
          highest = priority;
        }
      }
    }
    return highest;
  }

  private matchesEventType(patterns: string[], eventType: string): boolean {
    if (patterns.length === 0) return true;

    for (const pattern of patterns) {
      if (pattern === eventType) return true;
      if (pattern.endsWith(".*")) {
        const prefix = pattern.slice(0, -1);
        if (eventType.startsWith(prefix)) return true;
      }
      if (pattern.includes("*")) {
        const regex = new RegExp(
          "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
        );
        if (regex.test(eventType)) return true;
      }
    }

    return false;
  }
}
