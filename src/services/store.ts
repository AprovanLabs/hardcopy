import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { ServiceDefinition, ServiceSummary, CacheEntry } from "./types";

const SERVICES_SCHEMA = `
CREATE TABLE IF NOT EXISTS hc_services (
  namespace TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_config TEXT NOT NULL,
  procedures TEXT NOT NULL,
  types TEXT NOT NULL,
  registered_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_services_version ON hc_services(version);
CREATE INDEX IF NOT EXISTS hc_idx_services_source ON hc_services(source_type);

CREATE VIRTUAL TABLE IF NOT EXISTS hc_services_fts USING fts5(
  namespace,
  procedures_text,
  types_text,
  content='hc_services',
  content_rowid='rowid'
);

CREATE TABLE IF NOT EXISTS hc_service_cache (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  etag TEXT,
  last_modified TEXT
);

CREATE INDEX IF NOT EXISTS hc_idx_cache_expires ON hc_service_cache(expires_at);

CREATE TABLE IF NOT EXISTS hc_service_versions (
  namespace TEXT NOT NULL,
  version TEXT NOT NULL,
  definition TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (namespace, version)
);
`;

export class ServiceStore {
  private db: BetterSqlite3Database;
  private initialized = false;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  initialize(): void {
    if (this.initialized) return;
    const statements = SERVICES_SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      this.db.exec(sql);
    }
    this.initialized = true;
  }

  upsert(service: ServiceDefinition): void {
    this.initialize();
    const now = Date.now();
    const proceduresText = service.procedures.map((p) => `${p.name} ${p.description}`).join(" ");
    const typesText = service.types.map((t) => t.name).join(" ");

    const existing = this.get(service.namespace);
    if (existing && existing.version !== service.version) {
      this.archiveVersion(existing);
    }

    const stmt = this.db.prepare(`
      INSERT INTO hc_services (namespace, version, source_type, source_config, procedures, types, registered_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(namespace) DO UPDATE SET
        version = excluded.version,
        source_type = excluded.source_type,
        source_config = excluded.source_config,
        procedures = excluded.procedures,
        types = excluded.types,
        updated_at = excluded.updated_at
    `);
    stmt.run(
      service.namespace,
      service.version,
      service.source.type,
      JSON.stringify(service.source.config),
      JSON.stringify(service.procedures),
      JSON.stringify(service.types),
      existing ? existing.registeredAt ?? now : now,
      now
    );

    this.updateFts(service.namespace, proceduresText, typesText);
  }

  private archiveVersion(service: ServiceDefinition & { registeredAt?: number }): void {
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO hc_service_versions (namespace, version, definition, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      service.namespace,
      service.version,
      JSON.stringify(service),
      service.registeredAt ?? Date.now()
    );
  }

  private updateFts(namespace: string, proceduresText: string, typesText: string): void {
    const deleteStmt = this.db.prepare(`
      DELETE FROM hc_services_fts WHERE namespace = ?
    `);
    deleteStmt.run(namespace);

    const insertStmt = this.db.prepare(`
      INSERT INTO hc_services_fts (namespace, procedures_text, types_text)
      VALUES (?, ?, ?)
    `);
    insertStmt.run(namespace, proceduresText, typesText);
  }

  get(namespace: string): (ServiceDefinition & { registeredAt?: number }) | null {
    this.initialize();
    const stmt = this.db.prepare("SELECT * FROM hc_services WHERE namespace = ?");
    const row = stmt.get(namespace) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.rowToService(row);
  }

  getVersion(namespace: string, version: string): ServiceDefinition | null {
    this.initialize();
    const stmt = this.db.prepare(
      "SELECT definition FROM hc_service_versions WHERE namespace = ? AND version = ?"
    );
    const row = stmt.get(namespace, version) as { definition: string } | undefined;
    if (!row) return null;
    return JSON.parse(row.definition);
  }

  listVersions(namespace: string): string[] {
    this.initialize();
    const stmt = this.db.prepare(
      "SELECT version FROM hc_service_versions WHERE namespace = ? ORDER BY created_at DESC"
    );
    const rows = stmt.all(namespace) as { version: string }[];
    return rows.map((r) => r.version);
  }

  delete(namespace: string): void {
    this.initialize();
    const stmt = this.db.prepare("DELETE FROM hc_services WHERE namespace = ?");
    stmt.run(namespace);
    const ftsStmt = this.db.prepare("DELETE FROM hc_services_fts WHERE namespace = ?");
    ftsStmt.run(namespace);
  }

  list(): ServiceSummary[] {
    this.initialize();
    const stmt = this.db.prepare("SELECT namespace, version, source_type, procedures FROM hc_services");
    const rows = stmt.all() as Record<string, unknown>[];
    return rows.map((row) => ({
      namespace: row["namespace"] as string,
      version: row["version"] as string,
      sourceType: row["source_type"] as string,
      procedureCount: JSON.parse(row["procedures"] as string).length,
    }));
  }

  search(query: string): ServiceDefinition[] {
    this.initialize();
    const stmt = this.db.prepare(`
      SELECT s.* FROM hc_services s
      JOIN hc_services_fts fts ON s.namespace = fts.namespace
      WHERE hc_services_fts MATCH ?
    `);
    const rows = stmt.all(query) as Record<string, unknown>[];
    return rows.map((row) => this.rowToService(row));
  }

  setCache(entry: CacheEntry): void {
    this.initialize();
    const stmt = this.db.prepare(`
      INSERT INTO hc_service_cache (key, value, expires_at, etag, last_modified)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        value = excluded.value,
        expires_at = excluded.expires_at,
        etag = excluded.etag,
        last_modified = excluded.last_modified
    `);
    stmt.run(
      entry.key,
      JSON.stringify(entry.value),
      entry.expiresAt,
      entry.etag ?? null,
      entry.lastModified ?? null
    );
  }

  getCache(key: string): CacheEntry | null {
    this.initialize();
    const stmt = this.db.prepare("SELECT * FROM hc_service_cache WHERE key = ?");
    const row = stmt.get(key) as Record<string, unknown> | undefined;
    if (!row) return null;
    if ((row["expires_at"] as number) < Date.now()) {
      this.deleteCache(key);
      return null;
    }
    return {
      key: row["key"] as string,
      value: JSON.parse(row["value"] as string),
      expiresAt: row["expires_at"] as number,
      etag: row["etag"] as string | undefined,
      lastModified: row["last_modified"] as string | undefined,
    };
  }

  deleteCache(key: string): void {
    this.initialize();
    const stmt = this.db.prepare("DELETE FROM hc_service_cache WHERE key = ?");
    stmt.run(key);
  }

  pruneCache(): number {
    this.initialize();
    const stmt = this.db.prepare("DELETE FROM hc_service_cache WHERE expires_at < ?");
    const result = stmt.run(Date.now());
    return result.changes;
  }

  private rowToService(row: Record<string, unknown>): ServiceDefinition & { registeredAt?: number } {
    return {
      namespace: row["namespace"] as string,
      version: row["version"] as string,
      source: {
        type: row["source_type"] as "mcp" | "http" | "grpc" | "local",
        config: JSON.parse(row["source_config"] as string),
      },
      procedures: JSON.parse(row["procedures"] as string),
      types: JSON.parse(row["types"] as string),
      registeredAt: row["registered_at"] as number | undefined,
    };
  }
}
