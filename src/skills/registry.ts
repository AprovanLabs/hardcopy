import type { Database } from "../db";
import type { EntityGraph } from "../graph/types";
import type { EventBus, Envelope } from "../events/types";
import type { ServiceRegistry as IServiceRegistry } from "../services/types";
import type {
  SkillDefinition,
  SkillSummary,
  SkillContext,
  SkillExecutionContext,
  SkillResult,
  SkillRegistry as ISkillRegistry,
} from "./types";
import { matchEvent } from "./triggers";

const SKILL_TYPE = "skill.Definition";

export interface DependencyResolution {
  resolved: boolean;
  missing: string[];
  available: string[];
}

export interface SkillRegistryOptions {
  db: Database;
  graph?: EntityGraph;
  eventBus?: EventBus;
  executor?: SkillExecutor;
  serviceRegistry?: IServiceRegistry;
}

export type SkillExecutor = (
  skill: SkillDefinition,
  context: SkillContext
) => Promise<SkillResult>;

export class SkillRegistry implements ISkillRegistry {
  private skills = new Map<string, SkillDefinition>();
  private db: Database;
  private graph?: EntityGraph;
  private eventBus?: EventBus;
  private executor?: SkillExecutor;
  private serviceRegistry?: IServiceRegistry;

  constructor(options: SkillRegistryOptions) {
    this.db = options.db;
    this.graph = options.graph;
    this.eventBus = options.eventBus;
    this.executor = options.executor;
    this.serviceRegistry = options.serviceRegistry;
  }

  setServiceRegistry(registry: IServiceRegistry): void {
    this.serviceRegistry = registry;
  }

  async resolveDependencies(skill: SkillDefinition): Promise<DependencyResolution> {
    const dependencies = skill.dependencies ?? [];
    if (dependencies.length === 0 || !this.serviceRegistry) {
      return { resolved: true, missing: [], available: [] };
    }

    const available: string[] = [];
    const missing: string[] = [];

    for (const dep of dependencies) {
      const service = await this.serviceRegistry.get(dep);
      if (service) {
        available.push(dep);
      } else {
        missing.push(dep);
      }
    }

    return {
      resolved: missing.length === 0,
      missing,
      available,
    };
  }

  async register(skill: SkillDefinition): Promise<void> {
    this.skills.set(skill.id, skill);

    if (this.graph) {
      await this.graph.upsert({
        uri: skill.uri,
        type: SKILL_TYPE,
        attrs: {
          id: skill.id,
          name: skill.name,
          description: skill.description,
          instructions: skill.instructions,
          triggers: skill.triggers,
          tools: skill.tools,
          model: skill.model,
          dependencies: skill.dependencies,
        },
        version: skill.version,
      });
    }

    if (this.eventBus) {
      await this.eventBus.publish({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.registered",
        source: "skill-registry",
        subject: skill.uri,
        data: { id: skill.id, name: skill.name, triggerCount: skill.triggers.length },
        metadata: {},
      });
    }
  }

  async unregister(skillId: string): Promise<void> {
    const skill = this.skills.get(skillId);
    this.skills.delete(skillId);

    if (skill && this.eventBus) {
      await this.eventBus.publish({
        id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.unregistered",
        source: "skill-registry",
        subject: skill.uri,
        data: { id: skillId },
        metadata: {},
      });
    }
  }

  async list(): Promise<SkillSummary[]> {
    return Array.from(this.skills.values()).map((skill) => ({
      id: skill.id,
      uri: skill.uri,
      name: skill.name,
      description: skill.description,
      triggerCount: skill.triggers.length,
      toolCount: skill.tools.length,
    }));
  }

  async get(skillId: string): Promise<SkillDefinition | null> {
    return this.skills.get(skillId) ?? null;
  }

  async search(query: string): Promise<SkillDefinition[]> {
    const lowerQuery = query.toLowerCase();
    return Array.from(this.skills.values()).filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerQuery) ||
        skill.description.toLowerCase().includes(lowerQuery) ||
        skill.instructions.toLowerCase().includes(lowerQuery)
    );
  }

  async findByTrigger(eventType: string, _data?: unknown): Promise<SkillDefinition[]> {
    return Array.from(this.skills.values()).filter((skill) =>
      skill.triggers.some((trigger) =>
        trigger.eventFilter.types?.some(
          (pattern) =>
            eventType === pattern || this.matchWildcard(eventType, pattern)
        )
      )
    );
  }

  async execute(skillId: string, context: SkillContext | SkillExecutionContext): Promise<SkillResult> {
    const skill = this.skills.get(skillId);
    if (!skill) {
      return {
        skillId,
        status: "error",
        error: `Skill not found: ${skillId}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    if (!this.executor) {
      return {
        skillId,
        status: "error",
        error: "No executor configured",
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    const deps = await this.resolveDependencies(skill);
    if (!deps.resolved) {
      return {
        skillId,
        status: "error",
        error: `Missing required services: ${deps.missing.join(", ")}`,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    const normalizedContext: SkillContext = {
      event: context.event,
      entities: context.entities ?? [],
      services: context.services ?? [],
      params: context.params,
    };

    const startedAt = new Date().toISOString();

    if (this.eventBus) {
      await this.eventBus.publish({
        id: crypto.randomUUID(),
        timestamp: startedAt,
        type: "skill.execution.started",
        source: "skill-registry",
        subject: skill.uri,
        data: { skillId, context: normalizedContext },
        metadata: {},
      });
    }

    try {
      const result = await this.executor(skill, normalizedContext);

      if (this.eventBus) {
        await this.eventBus.publish({
          id: crypto.randomUUID(),
          timestamp: result.completedAt,
          type: `skill.execution.${result.status}`,
          source: "skill-registry",
          subject: skill.uri,
          data: result,
          metadata: {},
        });
      }

      return result;
    } catch (err) {
      const completedAt = new Date().toISOString();
      const errorMsg = err instanceof Error ? err.message : String(err);

      if (this.eventBus) {
        await this.eventBus.publish({
          id: crypto.randomUUID(),
          timestamp: completedAt,
          type: "skill.execution.error",
          source: "skill-registry",
          subject: skill.uri,
          data: { skillId, error: errorMsg },
          metadata: {},
        });
      }

      return {
        skillId,
        status: "error",
        error: errorMsg,
        startedAt,
        completedAt,
      };
    }
  }

  async handleEvent(event: Envelope): Promise<SkillResult[]> {
    const skills = Array.from(this.skills.values());
    const matches = matchEvent(event, skills);
    const results: SkillResult[] = [];

    for (const match of matches) {
      const context: SkillContext = {
        event,
        entities: [],
        services: match.skill.tools,
      };

      const result = await this.execute(match.skill.id, context);
      results.push(result);
    }

    return results;
  }

  private matchWildcard(value: string, pattern: string): boolean {
    if (!pattern.includes("*")) return false;
    const regex = new RegExp(
      "^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$"
    );
    return regex.test(value);
  }

  getAll(): SkillDefinition[] {
    return Array.from(this.skills.values());
  }
}
