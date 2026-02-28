import type { Database } from "../db";
import type { Entity, EntityGraph, ExtractedLink } from "./types";
import { parseUri, buildUri, stripVersion } from "./uri";
import { LinkExtractorRegistry, createDefaultExtractorRegistry } from "./extractors";

export interface EntityGraphOptions {
  autoExtractLinks?: boolean;
  linkExtractors?: LinkExtractorRegistry;
}

export class EntityGraphImpl implements EntityGraph {
  private db: Database;
  private extractors: LinkExtractorRegistry;
  private autoExtractLinks: boolean;

  constructor(db: Database, options: EntityGraphOptions = {}) {
    this.db = db;
    this.extractors = options.linkExtractors ?? createDefaultExtractorRegistry();
    this.autoExtractLinks = options.autoExtractLinks ?? true;
  }

  async upsert(entity: Entity): Promise<void> {
    const nodeId = this.uriToNodeId(entity.uri);
    const node = {
      id: nodeId,
      type: entity.type,
      attrs: {
        ...entity.attrs,
        _uri: entity.uri,
        _version: entity.version,
      },
      syncedAt: entity.syncedAt ? new Date(entity.syncedAt).getTime() : undefined,
      versionToken: entity.version,
    };

    await this.db.upsertNode(node);

    if (entity.links) {
      for (const link of entity.links) {
        await this.link(entity.uri, link.targetUri, link.type, link.attrs);
      }
    }

    if (this.autoExtractLinks) {
      await this.extractAndCreateLinks(entity);
    }
  }

  async upsertBatch(entities: Entity[]): Promise<void> {
    const nodes = entities.map((entity) => ({
      id: this.uriToNodeId(entity.uri),
      type: entity.type,
      attrs: {
        ...entity.attrs,
        _uri: entity.uri,
        _version: entity.version,
      },
      syncedAt: entity.syncedAt ? new Date(entity.syncedAt).getTime() : undefined,
      versionToken: entity.version,
    }));

    await this.db.upsertNodes(nodes);

    for (const entity of entities) {
      if (entity.links) {
        for (const link of entity.links) {
          await this.link(entity.uri, link.targetUri, link.type, link.attrs);
        }
      }

      if (this.autoExtractLinks) {
        await this.extractAndCreateLinks(entity);
      }
    }
  }

  async get(uri: string, version?: string): Promise<Entity | null> {
    const targetUri = version ? this.resolveVersion(uri, version) : uri;
    const nodeId = this.uriToNodeId(targetUri);
    const node = await this.db.getNode(nodeId);
    if (!node) return null;

    const edges = await this.db.getEdges(nodeId);
    const links = edges.map((e) => ({
      type: e.type,
      targetUri: this.nodeIdToUri(e.toId),
      attrs: e.attrs,
    }));

    const { _uri, _version, ...attrs } = node.attrs as Record<string, unknown>;

    return {
      uri: (_uri as string) ?? uri,
      type: node.type,
      attrs,
      version: (_version as string) ?? node.versionToken,
      syncedAt: node.syncedAt ? new Date(node.syncedAt).toISOString() : undefined,
      links,
    };
  }

  async delete(uri: string): Promise<void> {
    const nodeId = this.uriToNodeId(uri);
    await this.db.deleteNode(nodeId);
  }

  async link(
    fromUri: string,
    toUri: string,
    type: string,
    attrs?: Record<string, unknown>
  ): Promise<void> {
    const fromId = this.uriToNodeId(fromUri);
    const toId = this.uriToNodeId(toUri);

    const toNode = await this.db.getNode(toId);
    if (!toNode) {
      await this.db.upsertNode({
        id: toId,
        type: "entity.placeholder",
        attrs: { _uri: toUri },
      });
    }

    await this.db.upsertEdge({
      type,
      fromId,
      toId,
      attrs,
    });

    await this.db.upsertEdge({
      type: `${type}_reverse`,
      fromId: toId,
      toId: fromId,
      attrs,
    });
  }

  async unlink(fromUri: string, toUri: string, type: string): Promise<void> {
    const fromId = this.uriToNodeId(fromUri);
    const toId = this.uriToNodeId(toUri);
    await this.db.deleteEdge(fromId, toId, type);
    await this.db.deleteEdge(toId, fromId, `${type}_reverse`);
  }

  async query(cypher: string, params?: Record<string, unknown>): Promise<Entity[]> {
    const nodes = await this.db.queryViewNodes(cypher, params);
    return nodes.map((node) => {
      const { _uri, _version, ...attrs } = node.attrs as Record<string, unknown>;
      return {
        uri: (_uri as string) ?? this.nodeIdToUri(node.id),
        type: node.type,
        attrs,
        version: (_version as string) ?? node.versionToken,
        syncedAt: node.syncedAt ? new Date(node.syncedAt).toISOString() : undefined,
      };
    });
  }

  async traverse(uri: string, depth = 1): Promise<Entity[]> {
    const nodeId = this.uriToNodeId(uri);
    const visited = new Set<string>();
    const result: Entity[] = [];

    await this.traverseRecursive(nodeId, depth, visited, result);
    return result;
  }

  async inferSchema(type: string): Promise<Record<string, unknown>> {
    const nodes = await this.db.queryNodes(type);
    if (nodes.length === 0) {
      return { type: "object", properties: {} };
    }

    const properties: Record<string, unknown> = {};
    const required = new Set<string>();
    let firstNode = true;

    for (const node of nodes) {
      const attrs = node.attrs as Record<string, unknown>;
      for (const [key, value] of Object.entries(attrs)) {
        if (key.startsWith("_")) continue;

        const inferredType = this.inferPropertyType(value);
        if (!properties[key]) {
          properties[key] = inferredType;
          if (firstNode) required.add(key);
        } else {
          const existing = properties[key] as Record<string, unknown>;
          if (existing.type !== inferredType.type) {
            properties[key] = { type: ["string", inferredType.type, existing.type] };
          }
        }

        if (!required.has(key) && value !== undefined) {
          required.delete(key);
        }
      }

      if (firstNode) {
        for (const key of required) {
          if (!(key in attrs)) {
            required.delete(key);
          }
        }
      }
      firstNode = false;
    }

    return {
      type: "object",
      properties,
      required: Array.from(required),
    };
  }

  private async traverseRecursive(
    nodeId: string,
    depth: number,
    visited: Set<string>,
    result: Entity[]
  ): Promise<void> {
    if (depth < 0 || visited.has(nodeId)) return;
    visited.add(nodeId);

    const node = await this.db.getNode(nodeId);
    if (!node) return;

    const { _uri, _version, ...attrs } = node.attrs as Record<string, unknown>;
    result.push({
      uri: (_uri as string) ?? this.nodeIdToUri(nodeId),
      type: node.type,
      attrs,
      version: (_version as string) ?? node.versionToken,
      syncedAt: node.syncedAt ? new Date(node.syncedAt).toISOString() : undefined,
    });

    if (depth > 0) {
      const edges = await this.db.getEdges(nodeId);
      for (const edge of edges) {
        if (!edge.type.endsWith("_reverse")) {
          await this.traverseRecursive(edge.toId, depth - 1, visited, result);
        }
      }
    }
  }

  private async extractAndCreateLinks(entity: Entity): Promise<void> {
    const content = this.extractContent(entity);
    if (!content) return;

    const links = this.extractors.extractAll(content, {
      sourceUri: entity.uri,
      sourceType: entity.type,
    });

    for (const link of links) {
      await this.link(entity.uri, link.targetUri, link.linkType);
    }
  }

  private extractContent(entity: Entity): string | null {
    const attrs = entity.attrs;
    if (typeof attrs.body === "string") return attrs.body;
    if (typeof attrs.content === "string") return attrs.content;
    if (typeof attrs.description === "string") return attrs.description;
    if (typeof attrs.text === "string") return attrs.text;
    return null;
  }

  private uriToNodeId(uri: string): string {
    return uri.replace(/[@#]/g, "-").replace(/[^a-zA-Z0-9_.-]/g, "_");
  }

  private nodeIdToUri(nodeId: string): string {
    return `entity:${nodeId}`;
  }

  private resolveVersion(uri: string, version: string): string {
    const parsed = parseUri(uri);
    if (!parsed) return uri;
    return buildUri(parsed.scheme, parsed.path, parsed.fragment, version);
  }

  private inferPropertyType(value: unknown): Record<string, unknown> {
    if (value === null || value === undefined) {
      return { type: "null" };
    }
    if (typeof value === "string") {
      if (/^\d{4}-\d{2}-\d{2}/.test(value)) {
        return { type: "string", format: "date-time" };
      }
      if (/^https?:\/\//.test(value)) {
        return { type: "string", format: "uri" };
      }
      return { type: "string" };
    }
    if (typeof value === "number") {
      return Number.isInteger(value) ? { type: "integer" } : { type: "number" };
    }
    if (typeof value === "boolean") {
      return { type: "boolean" };
    }
    if (Array.isArray(value)) {
      return { type: "array" };
    }
    return { type: "object" };
  }
}
