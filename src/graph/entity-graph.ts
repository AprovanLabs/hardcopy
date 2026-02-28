import type { HardcopyDatabase } from "../db";
import type { Entity, EntityLink, EntityGraph as IEntityGraph } from "./types";
import { parseUri, normalizeUri } from "./uri";
import { extractLinks } from "./links";

export class EntityGraph implements IEntityGraph {
  private db: HardcopyDatabase;
  private autoExtractLinks: boolean;

  constructor(db: HardcopyDatabase, options: { autoExtractLinks?: boolean } = {}) {
    this.db = db;
    this.autoExtractLinks = options.autoExtractLinks ?? true;
  }

  async upsert(entity: Entity): Promise<void> {
    const nodeId = normalizeUri(entity.uri);
    const parsed = parseUri(entity.uri);

    await this.db.upsertNode({
      id: nodeId,
      type: entity.type,
      attrs: {
        ...entity.attrs,
        __uri: entity.uri,
        __scheme: parsed?.scheme,
        __version: entity.version,
      },
      syncedAt: entity.syncedAt ? Date.parse(entity.syncedAt) : Date.now(),
      versionToken: entity.version,
    });

    if (entity.links) {
      for (const link of entity.links) {
        await this.link(entity.uri, link.targetUri, link.type, link.attrs);
      }
    }

    if (this.autoExtractLinks) {
      const textContent = this.extractTextContent(entity.attrs);
      if (textContent) {
        const extracted = extractLinks(textContent, {
          sourceUri: entity.uri,
          sourceType: entity.type,
        });
        for (const link of extracted) {
          await this.link(entity.uri, link.targetUri, link.linkType);
        }
      }
    }
  }

  async upsertBatch(entities: Entity[]): Promise<void> {
    for (const entity of entities) {
      await this.upsert(entity);
    }
  }

  async get(uri: string, version?: string): Promise<Entity | null> {
    const nodeId = normalizeUri(uri);
    const node = await this.db.getNode(nodeId);
    if (!node) return null;

    const { __uri, __scheme, __version, ...attrs } = node.attrs as Record<string, unknown>;
    const edges = await this.db.getEdges(nodeId);
    const links: EntityLink[] = edges.map((e) => ({
      type: e.type,
      targetUri: e.toId,
      attrs: e.attrs,
    }));

    return {
      uri: (__uri as string) ?? uri,
      type: node.type,
      attrs,
      version: (__version as string) ?? node.versionToken,
      syncedAt: node.syncedAt ? new Date(node.syncedAt).toISOString() : undefined,
      links: links.length > 0 ? links : undefined,
    };
  }

  async delete(uri: string): Promise<void> {
    const nodeId = normalizeUri(uri);
    await this.db.deleteNode(nodeId);
  }

  async link(
    fromUri: string,
    toUri: string,
    type: string,
    attrs?: Record<string, unknown>
  ): Promise<void> {
    const fromId = normalizeUri(fromUri);
    const toId = normalizeUri(toUri);
    await this.db.upsertEdge({
      type,
      fromId,
      toId,
      attrs,
    });
  }

  async unlink(fromUri: string, toUri: string, type: string): Promise<void> {
    const fromId = normalizeUri(fromUri);
    const toId = normalizeUri(toUri);
    await this.db.deleteEdge(fromId, toId, type);
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<Entity[]> {
    const nodes = await this.db.queryViewNodes(cypher, params);
    return nodes.map((node) => {
      const { __uri, __scheme, __version, ...attrs } = node.attrs as Record<string, unknown>;
      return {
        uri: (__uri as string) ?? node.id,
        type: node.type,
        attrs,
        version: (__version as string) ?? node.versionToken,
        syncedAt: node.syncedAt ? new Date(node.syncedAt).toISOString() : undefined,
      };
    });
  }

  async traverse(uri: string, depth: number = 2): Promise<Entity[]> {
    const nodeId = normalizeUri(uri);
    const visited = new Set<string>();
    const result: Entity[] = [];
    const queue: { id: string; level: number }[] = [{ id: nodeId, level: 0 }];

    while (queue.length > 0) {
      const { id, level } = queue.shift()!;
      if (visited.has(id) || level > depth) continue;
      visited.add(id);

      const entity = await this.get(id);
      if (entity) {
        result.push(entity);

        if (level < depth) {
          const outEdges = await this.db.getEdges(id);
          const inEdges = await this.db.getEdges(undefined, id);
          
          for (const edge of outEdges) {
            if (!visited.has(edge.toId)) {
              queue.push({ id: edge.toId, level: level + 1 });
            }
          }
          for (const edge of inEdges) {
            if (!visited.has(edge.fromId)) {
              queue.push({ id: edge.fromId, level: level + 1 });
            }
          }
        }
      }
    }

    return result;
  }

  async inferSchema(type: string): Promise<Record<string, unknown>> {
    const nodes = await this.db.queryNodes(type);
    if (nodes.length === 0) {
      return { type: "object", properties: {} };
    }

    const properties: Record<string, unknown> = {};
    const seen = new Map<string, Set<string>>();

    for (const node of nodes) {
      for (const [key, value] of Object.entries(node.attrs)) {
        if (key.startsWith("__")) continue;

        if (!seen.has(key)) {
          seen.set(key, new Set());
        }
        seen.get(key)!.add(this.inferType(value));
      }
    }

    for (const [key, types] of seen) {
      const typeArray = Array.from(types);
      properties[key] = {
        type: typeArray.length === 1 ? typeArray[0] : typeArray,
      };
    }

    return {
      type: "object",
      properties,
      title: type,
    };
  }

  private extractTextContent(attrs: Record<string, unknown>): string {
    const textFields = ["body", "content", "description", "text", "message", "title"];
    const parts: string[] = [];

    for (const field of textFields) {
      const value = attrs[field];
      if (typeof value === "string") {
        parts.push(value);
      }
    }

    return parts.join("\n");
  }

  private inferType(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "array";
    if (typeof value === "number") {
      return Number.isInteger(value) ? "integer" : "number";
    }
    return typeof value;
  }
}
