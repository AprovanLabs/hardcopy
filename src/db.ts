import { createClient, type Client, type InStatement } from "@libsql/client";
import type { Node, Edge } from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  attrs TEXT NOT NULL,
  synced_at INTEGER,
  version_token TEXT,
  cursor TEXT
);

CREATE INDEX IF NOT EXISTS idx_nodes_type ON nodes(type);
CREATE INDEX IF NOT EXISTS idx_nodes_synced ON nodes(synced_at);

CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  attrs TEXT,
  UNIQUE(type, from_id, to_id)
);

CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_id);
CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_id);
CREATE INDEX IF NOT EXISTS idx_edges_type ON edges(type);
`;

export class Database {
  private client: Client;

  constructor(client: Client) {
    this.client = client;
  }

  static async open(path: string): Promise<Database> {
    const client = createClient({ url: `file:${path}` });
    const db = new Database(client);
    await db.initialize();
    return db;
  }

  private async initialize(): Promise<void> {
    const statements = SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      await this.client.execute(sql);
    }
  }

  async upsertNode(node: Node): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO nodes (id, type, attrs, synced_at, version_token, cursor)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              type = excluded.type,
              attrs = excluded.attrs,
              synced_at = excluded.synced_at,
              version_token = excluded.version_token,
              cursor = excluded.cursor`,
      args: [
        node.id,
        node.type,
        JSON.stringify(node.attrs),
        node.syncedAt ?? null,
        node.versionToken ?? null,
        node.cursor ?? null,
      ],
    });
  }

  async upsertNodes(nodes: Node[]): Promise<void> {
    if (nodes.length === 0) return;
    const statements: InStatement[] = nodes.map((node) => ({
      sql: `INSERT INTO nodes (id, type, attrs, synced_at, version_token, cursor)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
              type = excluded.type,
              attrs = excluded.attrs,
              synced_at = excluded.synced_at,
              version_token = excluded.version_token,
              cursor = excluded.cursor`,
      args: [
        node.id,
        node.type,
        JSON.stringify(node.attrs),
        node.syncedAt ?? null,
        node.versionToken ?? null,
        node.cursor ?? null,
      ],
    }));
    await this.client.batch(statements, "write");
  }

  async getNode(id: string): Promise<Node | null> {
    const result = await this.client.execute({
      sql: "SELECT * FROM nodes WHERE id = ?",
      args: [id],
    });
    if (result.rows.length === 0) return null;
    const row = result.rows[0]!;
    return {
      id: row["id"] as string,
      type: row["type"] as string,
      attrs: JSON.parse(row["attrs"] as string),
      syncedAt: row["synced_at"] as number | undefined,
      versionToken: row["version_token"] as string | undefined,
      cursor: row["cursor"] as string | undefined,
    };
  }

  async queryNodes(type?: string): Promise<Node[]> {
    const sql = type
      ? "SELECT * FROM nodes WHERE type = ?"
      : "SELECT * FROM nodes";
    const args = type ? [type] : [];
    const result = await this.client.execute({ sql, args });
    return result.rows.map((row) => ({
      id: row["id"] as string,
      type: row["type"] as string,
      attrs: JSON.parse(row["attrs"] as string),
      syncedAt: row["synced_at"] as number | undefined,
      versionToken: row["version_token"] as string | undefined,
      cursor: row["cursor"] as string | undefined,
    }));
  }

  async deleteNode(id: string): Promise<void> {
    await this.client.batch(
      [
        {
          sql: "DELETE FROM edges WHERE from_id = ? OR to_id = ?",
          args: [id, id],
        },
        { sql: "DELETE FROM nodes WHERE id = ?", args: [id] },
      ],
      "write",
    );
  }

  async upsertEdge(edge: Edge): Promise<void> {
    await this.client.execute({
      sql: `INSERT INTO edges (type, from_id, to_id, attrs)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(type, from_id, to_id) DO UPDATE SET
              attrs = excluded.attrs`,
      args: [
        edge.type,
        edge.fromId,
        edge.toId,
        edge.attrs ? JSON.stringify(edge.attrs) : null,
      ],
    });
  }

  async upsertEdges(edges: Edge[]): Promise<void> {
    if (edges.length === 0) return;
    const statements: InStatement[] = edges.map((edge) => ({
      sql: `INSERT INTO edges (type, from_id, to_id, attrs)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(type, from_id, to_id) DO UPDATE SET
              attrs = excluded.attrs`,
      args: [
        edge.type,
        edge.fromId,
        edge.toId,
        edge.attrs ? JSON.stringify(edge.attrs) : null,
      ],
    }));
    await this.client.batch(statements, "write");
  }

  async getEdges(
    fromId?: string,
    toId?: string,
    type?: string,
  ): Promise<Edge[]> {
    const conditions: string[] = [];
    const args: (string | null)[] = [];

    if (fromId) {
      conditions.push("from_id = ?");
      args.push(fromId);
    }
    if (toId) {
      conditions.push("to_id = ?");
      args.push(toId);
    }
    if (type) {
      conditions.push("type = ?");
      args.push(type);
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const result = await this.client.execute({
      sql: `SELECT * FROM edges ${where}`,
      args,
    });

    return result.rows.map((row) => ({
      id: row["id"] as number,
      type: row["type"] as string,
      fromId: row["from_id"] as string,
      toId: row["to_id"] as string,
      attrs: row["attrs"] ? JSON.parse(row["attrs"] as string) : undefined,
    }));
  }

  async deleteEdge(fromId: string, toId: string, type: string): Promise<void> {
    await this.client.execute({
      sql: "DELETE FROM edges WHERE from_id = ? AND to_id = ? AND type = ?",
      args: [fromId, toId, type],
    });
  }

  async close(): Promise<void> {
    this.client.close();
  }
}
