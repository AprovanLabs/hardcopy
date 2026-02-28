import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type {
  SkillDefinition,
  SkillSummary,
  SkillRegistry as ISkillRegistry,
  SkillExecutionContext,
} from "./types";
import type { EventBus, Envelope, EventFilter } from "../events/types";
import type { EntityGraph } from "../graph/types";
import { randomUUID } from "node:crypto";

const SKILLS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hc_skills (
  id TEXT PRIMARY KEY,
  uri TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  instructions TEXT NOT NULL,
  triggers TEXT NOT NULL,
  tools TEXT NOT NULL,
  model TEXT,
  dependencies TEXT,
  version TEXT,
  path TEXT,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_skills_uri ON hc_skills(uri);
CREATE INDEX IF NOT EXISTS hc_idx_skills_name ON hc_skills(name);

CREATE VIRTUAL TABLE IF NOT EXISTS hc_skills_fts USING fts5(
  id,
  name,
  description,
  instructions,
  content='hc_skills',
  content_rowid='rowid'
);
`;

export class SkillRegistry implements ISkillRegistry {
  private db: BetterSqlite3Database;
  private eventBus: EventBus | null = null;
  private entityGraph: EntityGraph | null = null;
  private executor: SkillExecutor | null = null;
  private initialized = false;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  private initialize(): void {
    if (this.initialized) return;
    const statements = SKILLS_SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      this.db.exec(sql);
    }
    this.initialized = true;
  }

  setEventBus(eventBus: EventBus): void {
    this.eventBus = eventBus;
  }

  setEntityGraph(graph: EntityGraph): void {
    this.entityGraph = graph;
  }

  setExecutor(executor: SkillExecutor): void {
    this.executor = executor;
  }

  async register(skill: SkillDefinition): Promise<void> {
    this.initialize();
    const now = Date.now();

    const stmt = this.db.prepare(`
      INSERT INTO hc_skills (id, uri, name, description, instructions, triggers, tools, model, dependencies, version, path, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        uri = excluded.uri,
        name = excluded.name,
        description = excluded.description,
        instructions = excluded.instructions,
        triggers = excluded.triggers,
        tools = excluded.tools,
        model = excluded.model,
        dependencies = excluded.dependencies,
        version = excluded.version,
        path = excluded.path,
        updated_at = excluded.updated_at
    `);

    stmt.run(
      skill.id,
      skill.uri,
      skill.name,
      skill.description,
      skill.instructions,
      JSON.stringify(skill.triggers),
      JSON.stringify(skill.tools),
      skill.model ? JSON.stringify(skill.model) : null,
      skill.dependencies ? JSON.stringify(skill.dependencies) : null,
      skill.version ?? null,
      skill.path ?? null,
      now,
      now
    );

    this.updateFts(skill);

    if (this.entityGraph) {
      await this.entityGraph.upsert({
        uri: skill.uri,
        type: "skill.Definition",
        attrs: {
          name: skill.name,
          description: skill.description,
          triggerCount: skill.triggers.length,
          toolCount: skill.tools.length,
          path: skill.path,
        },
        version: skill.version,
      });
    }

    if (this.eventBus) {
      await this.eventBus.publish({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.registered",
        source: "skill-registry",
        subject: skill.uri,
        data: {
          id: skill.id,
          name: skill.name,
          triggerCount: skill.triggers.length,
        },
        metadata: {},
      });
    }
  }

  async unregister(skillId: string): Promise<void> {
    this.initialize();
    const skill = await this.get(skillId);
    if (!skill) return;

    const stmt = this.db.prepare("DELETE FROM hc_skills WHERE id = ?");
    stmt.run(skillId);

    const ftsStmt = this.db.prepare("DELETE FROM hc_skills_fts WHERE id = ?");
    ftsStmt.run(skillId);

    if (this.entityGraph) {
      await this.entityGraph.delete(skill.uri);
    }

    if (this.eventBus) {
      await this.eventBus.publish({
        id: randomUUID(),
        timestamp: new Date().toISOString(),
        type: "skill.unregistered",
        source: "skill-registry",
        subject: skill.uri,
        data: { id: skillId, name: skill.name },
        metadata: {},
      });
    }
  }

  async list(): Promise<SkillSummary[]> {
    this.initialize();
    const stmt = this.db.prepare(
      "SELECT id, uri, name, description, triggers, tools FROM hc_skills"
    );
    const rows = stmt.all() as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row["id"] as string,
      uri: row["uri"] as string,
      name: row["name"] as string,
      description: row["description"] as string,
      triggerCount: JSON.parse(row["triggers"] as string).length,
      toolCount: JSON.parse(row["tools"] as string).length,
    }));
  }

  async get(skillId: string): Promise<SkillDefinition | null> {
    this.initialize();
    const stmt = this.db.prepare("SELECT * FROM hc_skills WHERE id = ?");
    const row = stmt.get(skillId) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSkill(row);
  }

  async getByUri(uri: string): Promise<SkillDefinition | null> {
    this.initialize();
    const stmt = this.db.prepare("SELECT * FROM hc_skills WHERE uri = ?");
    const row = stmt.get(uri) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToSkill(row);
  }

  async search(query: string): Promise<SkillDefinition[]> {
    this.initialize();
    const stmt = this.db.prepare(`
      SELECT s.* FROM hc_skills s
      JOIN hc_skills_fts fts ON s.id = fts.id
      WHERE hc_skills_fts MATCH ?
    `);
    const rows = stmt.all(query) as Record<string, unknown>[];
    return rows.map((row) => this.rowToSkill(row));
  }

  async findByTrigger(eventType: string, eventData?: unknown): Promise<SkillDefinition[]> {
    this.initialize();
    const skills = await this.list();
    const matches: Array<{ skill: SkillDefinition; priority: number }> = [];

    for (const summary of skills) {
      const skill = await this.get(summary.id);
      if (!skill) continue;

      for (const trigger of skill.triggers) {
        if (this.matchesFilter(eventType, trigger.eventFilter)) {
          if (trigger.condition && eventData) {
            if (!this.evaluateCondition(trigger.condition, eventData)) {
              continue;
            }
          }
          matches.push({ skill, priority: trigger.priority ?? 0 });
          break;
        }
      }
    }

    return matches
      .sort((a, b) => b.priority - a.priority)
      .map((m) => m.skill);
  }

  async execute(skillId: string, context: SkillExecutionContext): Promise<unknown> {
    const skill = await this.get(skillId);
    if (!skill) {
      throw new Error(`Skill not found: ${skillId}`);
    }

    if (!this.executor) {
      throw new Error("No executor configured for skill registry");
    }

    return this.executor.execute(skill, context);
  }

  private matchesFilter(eventType: string, filter: EventFilter): boolean {
    if (!filter.types || filter.types.length === 0) {
      return true;
    }

    for (const pattern of filter.types) {
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

  private evaluateCondition(condition: string, data: unknown): boolean {
    try {
      const fn = new Function("$", `return ${condition}`);
      return Boolean(fn(data));
    } catch {
      return false;
    }
  }

  private updateFts(skill: SkillDefinition): void {
    const deleteStmt = this.db.prepare("DELETE FROM hc_skills_fts WHERE id = ?");
    deleteStmt.run(skill.id);

    const insertStmt = this.db.prepare(`
      INSERT INTO hc_skills_fts (id, name, description, instructions)
      VALUES (?, ?, ?, ?)
    `);
    insertStmt.run(skill.id, skill.name, skill.description, skill.instructions);
  }

  private rowToSkill(row: Record<string, unknown>): SkillDefinition {
    return {
      id: row["id"] as string,
      uri: row["uri"] as string,
      name: row["name"] as string,
      description: row["description"] as string,
      instructions: row["instructions"] as string,
      triggers: JSON.parse(row["triggers"] as string),
      tools: JSON.parse(row["tools"] as string),
      model: row["model"] ? JSON.parse(row["model"] as string) : undefined,
      dependencies: row["dependencies"]
        ? JSON.parse(row["dependencies"] as string)
        : undefined,
      version: row["version"] as string | undefined,
      path: row["path"] as string | undefined,
    };
  }
}

export interface SkillExecutor {
  execute(skill: SkillDefinition, context: SkillExecutionContext): Promise<unknown>;
}
