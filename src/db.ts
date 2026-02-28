import BetterSqlite3 from "better-sqlite3";
import type { Database as BetterSqlite3Database } from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Node, Edge, Event, EventFilter, EventPage } from "./types";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Re-export for consumers who need to type the raw database
export type { BetterSqlite3Database };

const SCHEMA = `
CREATE TABLE IF NOT EXISTS hc_nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  attrs TEXT NOT NULL,
  synced_at INTEGER,
  version_token TEXT,
  cursor TEXT
);

CREATE INDEX IF NOT EXISTS hc_idx_nodes_type ON hc_nodes(type);
CREATE INDEX IF NOT EXISTS hc_idx_nodes_synced ON hc_nodes(synced_at);

CREATE TABLE IF NOT EXISTS hc_edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  attrs TEXT,
  UNIQUE(type, from_id, to_id)
);

CREATE INDEX IF NOT EXISTS hc_idx_edges_from ON hc_edges(from_id);
CREATE INDEX IF NOT EXISTS hc_idx_edges_to ON hc_edges(to_id);
CREATE INDEX IF NOT EXISTS hc_idx_edges_type ON hc_edges(type);

CREATE TABLE IF NOT EXISTS hc_file_synced (
  node_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (node_id, file_path)
);

CREATE INDEX IF NOT EXISTS hc_idx_file_synced_node ON hc_file_synced(node_id);

CREATE TABLE IF NOT EXISTS hc_events (
  id TEXT PRIMARY KEY,
  stream TEXT NOT NULL,
  type TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  attrs TEXT NOT NULL,
  source_id TEXT,
  parent_id TEXT,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_events_stream ON hc_events(stream);
CREATE INDEX IF NOT EXISTS hc_idx_events_ts ON hc_events(timestamp);
CREATE INDEX IF NOT EXISTS hc_idx_events_type ON hc_events(type);
CREATE INDEX IF NOT EXISTS hc_idx_events_source ON hc_events(source_id);
CREATE INDEX IF NOT EXISTS hc_idx_events_parent ON hc_events(parent_id);
`;

const GRAPHQLITE_ENV_PATH = "GRAPHQLITE_EXTENSION_PATH";
const GRAPHQLITE_TEST_QUERY = "SELECT graphqlite_test() AS result";
let nativeModuleRepairAttempted = false;

export class HardcopyDatabase {
  private db: BetterSqlite3Database;
  private graphqliteLoaded = false;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  static async open(path: string): Promise<HardcopyDatabase> {
    try {
      const db = new BetterSqlite3(path);
      const hcdb = new HardcopyDatabase(db);
      await hcdb.initialize();
      return hcdb;
    } catch (error) {
      if (!this.shouldAttemptNativeRepair(error)) {
        throw error;
      }

      const repaired = this.rebuildBetterSqlite3();
      if (!repaired) {
        throw this.wrapNativeLoadError(error);
      }

      try {
        const db = new BetterSqlite3(path);
        const hcdb = new HardcopyDatabase(db);
        await hcdb.initialize();
        return hcdb;
      } catch (retryError) {
        throw this.wrapNativeLoadError(retryError);
      }
    }
  }

  private static shouldAttemptNativeRepair(error: unknown): boolean {
    if (nativeModuleRepairAttempted) return false;
    if (!(error instanceof Error)) return false;
    const code = (error as { code?: string }).code;
    if (code !== "ERR_DLOPEN_FAILED") return false;
    const message = error.message || "";
    return (
      message.includes("better_sqlite3.node") &&
      message.includes("compiled against a different Node.js version")
    );
  }

  private static rebuildBetterSqlite3(): boolean {
    nativeModuleRepairAttempted = true;
    const packageRoot = join(__dirname, "..");
    const result = spawnSync("pnpm", ["rebuild", "better-sqlite3"], {
      cwd: packageRoot,
      stdio: "ignore",
      env: process.env,
    });
    return result.status === 0;
  }

  private static wrapNativeLoadError(error: unknown): Error {
    const details = error instanceof Error ? error.message : String(error);
    return new Error(
      `Failed to load better-sqlite3 native module for Node ${process.versions.node}. ` +
        `Hardcopy attempted an automatic rebuild, but loading still failed. ` +
        `Run 'cd ~/Documents/JacobSampson/hardcopy && pnpm rebuild better-sqlite3' and retry.\n\n` +
        details,
    );
  }

  private async initialize(): Promise<void> {
    await this.migrateLegacySchema();
    const statements = SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      this.db.exec(sql);
    }
  }

  private async migrateLegacySchema(): Promise<void> {
    const legacyNodes = this.getTableColumns("nodes");
    const legacyEdges = this.getTableColumns("edges");

    if (legacyNodes) {
      const isLegacy =
        legacyNodes.includes("type") || legacyNodes.includes("attrs");
      if (isLegacy) {
        this.renameTableIfNeeded("nodes", "hc_nodes");
        this.dropLegacyIndexes(["idx_nodes_type", "idx_nodes_synced"]);
      }
    }

    if (legacyEdges) {
      const isLegacy =
        legacyEdges.includes("from_id") || legacyEdges.includes("to_id");
      if (isLegacy) {
        this.renameTableIfNeeded("edges", "hc_edges");
        this.dropLegacyIndexes([
          "idx_edges_from",
          "idx_edges_to",
          "idx_edges_type",
        ]);
      }
    }
  }

  private getTableColumns(table: string): string[] | null {
    const stmt = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    );
    const result = stmt.all(table) as { name: string }[];
    if (result.length === 0) return null;

    const columns = this.db.pragma(`table_info(${table})`) as {
      name: string;
    }[];
    return columns.map((row) => row.name);
  }

  private renameTableIfNeeded(from: string, to: string): void {
    const stmt = this.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name = ?",
    );
    const existing = stmt.all(to);
    if (existing.length > 0) return;
    this.db.exec(`ALTER TABLE ${from} RENAME TO ${to}`);
  }

  private dropLegacyIndexes(names: string[]): void {
    for (const name of names) {
      this.db.exec(`DROP INDEX IF EXISTS ${name}`);
    }
  }

  private resolveGraphqliteLoadPath(): string | null {
    // 1. Check environment variable
    const envPath = process.env[GRAPHQLITE_ENV_PATH];
    if (envPath) {
      return envPath;
    }

    // 2. Auto-discover in .hardcopy/extensions/
    const extensionCandidates = this.getExtensionCandidates();
    for (const candidate of extensionCandidates) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  private getExtensionCandidates(): string[] {
    const platform = process.platform;
    const arch = process.arch;

    const filenames: string[] = [];
    if (platform === "darwin" && arch === "arm64") {
      filenames.push("graphqlite-macos-arm64.dylib");
    } else if (platform === "darwin" && arch === "x64") {
      filenames.push("graphqlite-macos-x86_64.dylib");
    } else if (platform === "linux" && arch === "arm64") {
      filenames.push("graphqlite-linux-aarch64.so");
    } else if (platform === "linux" && arch === "x64") {
      filenames.push("graphqlite-linux-x86_64.so");
    } else if (platform === "win32" && arch === "x64") {
      filenames.push("graphqlite-windows-x86_64.dll");
    }

    // Search in project .hardcopy/extensions and cwd .hardcopy/extensions
    const searchDirs = [
      join(__dirname, "..", ".hardcopy", "extensions"),
      join(process.cwd(), ".hardcopy", "extensions"),
    ];

    const candidates: string[] = [];
    for (const dir of searchDirs) {
      for (const filename of filenames) {
        candidates.push(join(dir, filename));
      }
    }
    return candidates;
  }

  private ensureGraphqliteLoaded(): void {
    if (this.graphqliteLoaded) return;

    // Check if already loaded
    try {
      const stmt = this.db.prepare(GRAPHQLITE_TEST_QUERY);
      const result = stmt.all() as { result: string }[];
      const value = String(result[0]?.result ?? "");
      if (value.toLowerCase().includes("successfully")) {
        this.graphqliteLoaded = true;
        return;
      }
    } catch {
      // Extension not loaded yet.
    }

    const loadPath = this.resolveGraphqliteLoadPath();
    if (!loadPath) {
      throw new Error(
        `GraphQLite extension not found. Run \`pnpm setup:graphqlite\` or set ${GRAPHQLITE_ENV_PATH}.`,
      );
    }

    // Use native loadExtension method with explicit entry point
    // Note: better-sqlite3 types don't include the entryPoint parameter, but it's supported
    (
      this.db as unknown as {
        loadExtension: (path: string, entryPoint: string) => void;
      }
    ).loadExtension(loadPath, "sqlite3_graphqlite_init");

    // Verify it loaded
    const verifyStmt = this.db.prepare(GRAPHQLITE_TEST_QUERY);
    const verify = verifyStmt.all() as { result: string }[];
    const value = String(verify[0]?.result ?? "");
    if (!value.toLowerCase().includes("successfully")) {
      throw new Error("GraphQLite extension loaded but verification failed.");
    }
    this.graphqliteLoaded = true;
  }

  private normalizeCypher(query: string): string {
    // Convert SQL JSON path syntax to property access
    let normalized = query.replace(/->>'(\w+)'/g, ".$1");
    // Remove .attrs prefix since we flatten attributes directly on nodes
    normalized = normalized.replace(/\.attrs\.(\w+)/g, ".$1");
    // Escape dotted labels (e.g., github.Issue -> `github.Issue`)
    normalized = normalized.replace(
      /:([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)/g,
      (_match, label) => `:\`${label}\``,
    );
    return normalized;
  }

  private escapeCypherType(value: string): string {
    const escaped = value.replace(/`/g, "``");
    return `\`${escaped}\``;
  }

  private extractNodeIds(rows: Record<string, unknown>[]): string[] {
    const ids = new Set<string>();
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        // Check for node_id (our flattened property)
        if (key === "node_id" && typeof value === "string") {
          ids.add(value);
          continue;
        }
        if (key.endsWith(".node_id") && typeof value === "string") {
          ids.add(value);
          continue;
        }
        // Also check for id (legacy/fallback)
        if (key === "id" && typeof value === "string") {
          ids.add(value);
          continue;
        }
        if (key.endsWith(".id") && typeof value === "string") {
          ids.add(value);
          continue;
        }
        // Check nested objects - GraphQLite returns nodes as {id, labels, properties}
        if (value && typeof value === "object") {
          const obj = value as Record<string, unknown>;
          // Direct node_id on object
          if (typeof obj["node_id"] === "string") {
            ids.add(obj["node_id"] as string);
            continue;
          }
          // GraphQLite structure: node.properties.node_id
          const props = obj["properties"];
          if (props && typeof props === "object") {
            const propsObj = props as Record<string, unknown>;
            if (typeof propsObj["node_id"] === "string") {
              ids.add(propsObj["node_id"] as string);
              continue;
            }
          }
          // Fallback: check id
          if (typeof obj["id"] === "string") ids.add(obj["id"] as string);
        }
      }
    }
    return Array.from(ids);
  }

  private parseCypherRows(
    rows: { result: string | null }[],
  ): Record<string, unknown>[] {
    if (!rows.length) return [];
    const row = rows[0]!;
    const payload = row.result;
    if (payload === null || payload === undefined) return [];
    if (typeof payload !== "string") return [];
    try {
      const parsed = JSON.parse(payload);
      return Array.isArray(parsed) ? (parsed as Record<string, unknown>[]) : [];
    } catch {
      return [];
    }
  }

  async cypher(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<Record<string, unknown>[]> {
    this.ensureGraphqliteLoaded();
    const normalized = this.normalizeCypher(query);
    const stmt = params
      ? this.db.prepare("SELECT cypher(?, ?) AS result")
      : this.db.prepare("SELECT cypher(?) AS result");
    const args = params ? [normalized, JSON.stringify(params)] : [normalized];
    const result = stmt.all(...args) as { result: string | null }[];
    return this.parseCypherRows(result);
  }

  async queryViewNodes(
    query: string,
    params?: Record<string, unknown>,
  ): Promise<Node[]> {
    const rows = await this.cypher(query, params);
    const ids = this.extractNodeIds(rows);
    if (ids.length === 0) return [];
    return this.getNodesByIds(ids);
  }

  async getNodesByIds(ids: string[]): Promise<Node[]> {
    if (ids.length === 0) return [];
    const placeholders = ids.map(() => "?").join(", ");
    const stmt = this.db.prepare(
      `SELECT * FROM hc_nodes WHERE id IN (${placeholders})`,
    );
    const result = stmt.all(...ids) as Record<string, unknown>[];
    const byId = new Map(
      result.map((row) => [
        row["id"] as string,
        {
          id: row["id"] as string,
          type: row["type"] as string,
          attrs: JSON.parse(row["attrs"] as string),
          syncedAt: row["synced_at"] as number | undefined,
          versionToken: row["version_token"] as string | undefined,
          cursor: row["cursor"] as string | undefined,
        },
      ]),
    );
    return ids.map((id) => byId.get(id)).filter(Boolean) as Node[];
  }

  async upsertNode(node: Node): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO hc_nodes (id, type, attrs, synced_at, version_token, cursor)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         attrs = excluded.attrs,
         synced_at = excluded.synced_at,
         version_token = excluded.version_token,
         cursor = excluded.cursor`,
    );
    stmt.run(
      node.id,
      node.type,
      JSON.stringify(node.attrs),
      node.syncedAt ?? null,
      node.versionToken ?? null,
      node.cursor ?? null,
    );
    await this.upsertGraphNode(node);
  }

  async upsertNodes(nodes: Node[]): Promise<void> {
    if (nodes.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO hc_nodes (id, type, attrs, synced_at, version_token, cursor)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         type = excluded.type,
         attrs = excluded.attrs,
         synced_at = excluded.synced_at,
         version_token = excluded.version_token,
         cursor = excluded.cursor`,
    );
    const insertMany = this.db.transaction((nodes: Node[]) => {
      for (const node of nodes) {
        stmt.run(
          node.id,
          node.type,
          JSON.stringify(node.attrs),
          node.syncedAt ?? null,
          node.versionToken ?? null,
          node.cursor ?? null,
        );
      }
    });
    insertMany(nodes);
    for (const node of nodes) {
      await this.upsertGraphNode(node);
    }
  }

  async getNode(id: string): Promise<Node | null> {
    const stmt = this.db.prepare("SELECT * FROM hc_nodes WHERE id = ?");
    const result = stmt.all(id) as Record<string, unknown>[];
    if (result.length === 0) return null;
    const row = result[0]!;
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
      ? "SELECT * FROM hc_nodes WHERE type = ?"
      : "SELECT * FROM hc_nodes";
    const stmt = this.db.prepare(sql);
    const result = type ? stmt.all(type) : stmt.all();
    return (result as Record<string, unknown>[]).map((row) => ({
      id: row["id"] as string,
      type: row["type"] as string,
      attrs: JSON.parse(row["attrs"] as string),
      syncedAt: row["synced_at"] as number | undefined,
      versionToken: row["version_token"] as string | undefined,
      cursor: row["cursor"] as string | undefined,
    }));
  }

  async deleteNode(id: string): Promise<void> {
    const deleteEdgesStmt = this.db.prepare(
      "DELETE FROM hc_edges WHERE from_id = ? OR to_id = ?",
    );
    deleteEdgesStmt.run(id, id);

    const deleteNodeStmt = this.db.prepare("DELETE FROM hc_nodes WHERE id = ?");
    deleteNodeStmt.run(id);

    await this.deleteGraphNode(id);
  }

  async upsertEdge(edge: Edge): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO hc_edges (type, from_id, to_id, attrs)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(type, from_id, to_id) DO UPDATE SET
         attrs = excluded.attrs`,
    );
    stmt.run(
      edge.type,
      edge.fromId,
      edge.toId,
      edge.attrs ? JSON.stringify(edge.attrs) : null,
    );
    await this.upsertGraphEdge(edge);
  }

  async upsertEdges(edges: Edge[]): Promise<void> {
    if (edges.length === 0) return;
    const stmt = this.db.prepare(
      `INSERT INTO hc_edges (type, from_id, to_id, attrs)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(type, from_id, to_id) DO UPDATE SET
         attrs = excluded.attrs`,
    );
    const insertMany = this.db.transaction((edges: Edge[]) => {
      for (const edge of edges) {
        stmt.run(
          edge.type,
          edge.fromId,
          edge.toId,
          edge.attrs ? JSON.stringify(edge.attrs) : null,
        );
      }
    });
    insertMany(edges);
    for (const edge of edges) {
      await this.upsertGraphEdge(edge);
    }
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
    const stmt = this.db.prepare(`SELECT * FROM hc_edges ${where}`);
    const result = stmt.all(...args) as Record<string, unknown>[];

    return result.map((row) => ({
      id: row["id"] as number,
      type: row["type"] as string,
      fromId: row["from_id"] as string,
      toId: row["to_id"] as string,
      attrs: row["attrs"] ? JSON.parse(row["attrs"] as string) : undefined,
    }));
  }

  async deleteEdge(fromId: string, toId: string, type: string): Promise<void> {
    const stmt = this.db.prepare(
      "DELETE FROM hc_edges WHERE from_id = ? AND to_id = ? AND type = ?",
    );
    stmt.run(fromId, toId, type);
    await this.deleteGraphEdge(fromId, toId, type);
  }

  private escapeCypherString(value: string): string {
    // Escape backslashes and single quotes for Cypher string literals
    return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  }

  private async upsertGraphNode(node: Node): Promise<void> {
    const label = this.escapeCypherType(node.type);
    // GraphQLite doesn't support parameterized properties in MERGE patterns,
    // so we must inline the node_id with proper escaping
    const escapedNodeId = this.escapeCypherString(node.id);

    // Flatten top-level attrs for graph storage - GraphQLite doesn't support nested objects
    const flatAttrs: Record<string, string | number | boolean | null> = {
      node_id: node.id,
      node_type: node.type,
    };
    if (node.attrs && typeof node.attrs === "object") {
      for (const [key, value] of Object.entries(node.attrs)) {
        if (value === null || value === undefined) {
          flatAttrs[key] = null;
        } else if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "boolean"
        ) {
          flatAttrs[key] = value;
        } else if (Array.isArray(value)) {
          flatAttrs[key] = JSON.stringify(value);
        } else {
          flatAttrs[key] = JSON.stringify(value);
        }
      }
    }
    // Build SET clause with explicit property assignments
    const setClause = Object.keys(flatAttrs)
      .map((k) => `n.${k} = $${k}`)
      .join(", ");
    // GraphQLite doesn't support plain SET after MERGE, but ON CREATE/MATCH SET works
    // Use inline escaped value in MERGE pattern (GraphQLite limitation with params in patterns)
    await this.cypher(
      `MERGE (n:${label} {node_id: '${escapedNodeId}'}) ON CREATE SET ${setClause} ON MATCH SET ${setClause}`,
      flatAttrs,
    );
  }

  private async upsertGraphEdge(edge: Edge): Promise<void> {
    const relType = this.escapeCypherType(edge.type);
    // GraphQLite doesn't support parameterized MATCH patterns, use inline escaped values
    const escapedFromId = this.escapeCypherString(edge.fromId);
    const escapedToId = this.escapeCypherString(edge.toId);
    // Note: We match on node_id (our flattened property), not id
    await this.cypher(
      `MATCH (a {node_id: '${escapedFromId}'}), (b {node_id: '${escapedToId}'}) MERGE (a)-[r:${relType}]->(b)`,
    );
  }

  private async deleteGraphNode(id: string): Promise<void> {
    const escapedId = this.escapeCypherString(id);
    await this.cypher(`MATCH (n {node_id: '${escapedId}'}) DETACH DELETE n`);
  }

  private async deleteGraphEdge(
    fromId: string,
    toId: string,
    type: string,
  ): Promise<void> {
    const relType = this.escapeCypherType(type);
    const escapedFromId = this.escapeCypherString(fromId);
    const escapedToId = this.escapeCypherString(toId);
    await this.cypher(
      `MATCH (a {node_id: '${escapedFromId}'})-[r:${relType}]->(b {node_id: '${escapedToId}'}) DELETE r`,
    );
  }

  async insertEvents(events: Event[]): Promise<void> {
    if (events.length === 0) return;
    const now = Date.now();
    const stmt = this.db.prepare(
      `INSERT OR IGNORE INTO hc_events (id, stream, type, timestamp, attrs, source_id, parent_id, ingested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertMany = this.db.transaction((events: Event[]) => {
      for (const event of events) {
        stmt.run(
          event.id,
          event.stream,
          event.type,
          event.timestamp,
          JSON.stringify(event.attrs),
          event.sourceId ?? null,
          event.parentId ?? null,
          now,
        );
      }
    });
    insertMany(events);
  }

  async queryEvents(filter: EventFilter, limit = 100, cursor?: string): Promise<EventPage> {
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (filter.types && filter.types.length > 0) {
      const placeholders = filter.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      args.push(...filter.types);
    }
    if (filter.since !== undefined) {
      conditions.push("timestamp >= ?");
      args.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("timestamp <= ?");
      args.push(filter.until);
    }
    if (filter.sourceId) {
      conditions.push("source_id = ?");
      args.push(filter.sourceId);
    }
    if (filter.parentId) {
      conditions.push("parent_id = ?");
      args.push(filter.parentId);
    }
    if (cursor) {
      conditions.push("timestamp < ?");
      args.push(parseInt(cursor, 10));
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM hc_events ${where} ORDER BY timestamp DESC LIMIT ?`;
    args.push(limit + 1);

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.rowToEvent(row));
    const nextCursor = hasMore && events.length > 0
      ? String(events[events.length - 1]!.timestamp)
      : undefined;

    return { events, cursor: nextCursor, hasMore };
  }

  async queryStreamEvents(stream: string, filter: EventFilter, limit = 100, cursor?: string): Promise<EventPage> {
    const conditions: string[] = ["stream = ?"];
    const args: unknown[] = [stream];

    if (filter.types && filter.types.length > 0) {
      const placeholders = filter.types.map(() => "?").join(", ");
      conditions.push(`type IN (${placeholders})`);
      args.push(...filter.types);
    }
    if (filter.since !== undefined) {
      conditions.push("timestamp >= ?");
      args.push(filter.since);
    }
    if (filter.until !== undefined) {
      conditions.push("timestamp <= ?");
      args.push(filter.until);
    }
    if (filter.sourceId) {
      conditions.push("source_id = ?");
      args.push(filter.sourceId);
    }
    if (filter.parentId) {
      conditions.push("parent_id = ?");
      args.push(filter.parentId);
    }
    if (cursor) {
      conditions.push("timestamp < ?");
      args.push(parseInt(cursor, 10));
    }

    const where = `WHERE ${conditions.join(" AND ")}`;
    const sql = `SELECT * FROM hc_events ${where} ORDER BY timestamp DESC LIMIT ?`;
    args.push(limit + 1);

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.rowToEvent(row));
    const nextCursor = hasMore && events.length > 0
      ? String(events[events.length - 1]!.timestamp)
      : undefined;

    return { events, cursor: nextCursor, hasMore };
  }

  async pruneEvents(stream: string, retention: { maxAge?: number; maxCount?: number }): Promise<number> {
    let deleted = 0;

    if (retention.maxAge) {
      const cutoff = Date.now() - retention.maxAge;
      const result = this.db.prepare(
        "DELETE FROM hc_events WHERE stream = ? AND timestamp < ?",
      ).run(stream, cutoff);
      deleted += result.changes;
    }

    if (retention.maxCount) {
      const countResult = this.db.prepare(
        "SELECT COUNT(*) as cnt FROM hc_events WHERE stream = ?",
      ).get(stream) as { cnt: number };

      if (countResult.cnt > retention.maxCount) {
        const excess = countResult.cnt - retention.maxCount;
        const result = this.db.prepare(
          `DELETE FROM hc_events WHERE stream = ? AND id IN (
            SELECT id FROM hc_events WHERE stream = ? ORDER BY timestamp ASC LIMIT ?
          )`,
        ).run(stream, stream, excess);
        deleted += result.changes;
      }
    }

    return deleted;
  }

  private rowToEvent(row: Record<string, unknown>): Event {
    return {
      id: row["id"] as string,
      stream: row["stream"] as string,
      type: row["type"] as string,
      timestamp: row["timestamp"] as number,
      attrs: JSON.parse(row["attrs"] as string),
      sourceId: row["source_id"] as string | undefined,
      parentId: row["parent_id"] as string | undefined,
    };
  }

  async getFileSyncedAt(nodeId: string, filePath: string): Promise<number | null> {
    const stmt = this.db.prepare(
      "SELECT synced_at FROM hc_file_synced WHERE node_id = ? AND file_path = ?",
    );
    const result = stmt.all(nodeId, filePath) as { synced_at: number }[];
    return result.length > 0 ? result[0]!.synced_at : null;
  }

  async setFileSyncedAt(nodeId: string, filePath: string, syncedAt: number): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO hc_file_synced (node_id, file_path, synced_at)
       VALUES (?, ?, ?)
       ON CONFLICT(node_id, file_path) DO UPDATE SET
         synced_at = excluded.synced_at`,
    );
    stmt.run(nodeId, filePath, syncedAt);
  }

  async deleteFileSyncedAt(nodeId: string, filePath?: string): Promise<void> {
    if (filePath) {
      const stmt = this.db.prepare(
        "DELETE FROM hc_file_synced WHERE node_id = ? AND file_path = ?",
      );
      stmt.run(nodeId, filePath);
    } else {
      const stmt = this.db.prepare("DELETE FROM hc_file_synced WHERE node_id = ?");
      stmt.run(nodeId);
    }
  }

  async close(): Promise<void> {
    this.db.close();
  }
}

// Keep backward compatibility alias
export { HardcopyDatabase as Database };
