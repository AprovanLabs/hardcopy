import type { Database as BetterSqlite3Database } from "better-sqlite3";
import type { Envelope, EventFilter, EventPage, QueryOptions, DeadLetterEntry } from "./types";

const EVENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS hc_envelopes (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  type TEXT NOT NULL,
  source TEXT NOT NULL,
  subject TEXT,
  data TEXT NOT NULL,
  metadata TEXT NOT NULL,
  embedding BLOB,
  ingested_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_envelopes_ts ON hc_envelopes(timestamp);
CREATE INDEX IF NOT EXISTS hc_idx_envelopes_type ON hc_envelopes(type);
CREATE INDEX IF NOT EXISTS hc_idx_envelopes_source ON hc_envelopes(source);
CREATE INDEX IF NOT EXISTS hc_idx_envelopes_subject ON hc_envelopes(subject);

CREATE VIRTUAL TABLE IF NOT EXISTS hc_envelopes_fts USING fts5(
  type,
  source,
  subject,
  data,
  content='hc_envelopes',
  content_rowid='rowid'
);

CREATE TRIGGER IF NOT EXISTS hc_envelopes_ai AFTER INSERT ON hc_envelopes BEGIN
  INSERT INTO hc_envelopes_fts(rowid, type, source, subject, data)
  VALUES (NEW.rowid, NEW.type, NEW.source, NEW.subject, NEW.data);
END;

CREATE TRIGGER IF NOT EXISTS hc_envelopes_ad AFTER DELETE ON hc_envelopes BEGIN
  INSERT INTO hc_envelopes_fts(hc_envelopes_fts, rowid, type, source, subject, data)
  VALUES ('delete', OLD.rowid, OLD.type, OLD.source, OLD.subject, OLD.data);
END;

CREATE TRIGGER IF NOT EXISTS hc_envelopes_au AFTER UPDATE ON hc_envelopes BEGIN
  INSERT INTO hc_envelopes_fts(hc_envelopes_fts, rowid, type, source, subject, data)
  VALUES ('delete', OLD.rowid, OLD.type, OLD.source, OLD.subject, OLD.data);
  INSERT INTO hc_envelopes_fts(rowid, type, source, subject, data)
  VALUES (NEW.rowid, NEW.type, NEW.source, NEW.subject, NEW.data);
END;

CREATE TABLE IF NOT EXISTS hc_dead_letter (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_id TEXT NOT NULL,
  envelope_data TEXT NOT NULL,
  error TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 1,
  last_attempt TEXT NOT NULL,
  handler_id TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS hc_idx_dead_letter_envelope ON hc_dead_letter(envelope_id);
CREATE INDEX IF NOT EXISTS hc_idx_dead_letter_handler ON hc_dead_letter(handler_id);
`;

export class EventStore {
  private db: BetterSqlite3Database;
  private initialized = false;

  constructor(db: BetterSqlite3Database) {
    this.db = db;
  }

  initialize(): void {
    if (this.initialized) return;
    const statements = EVENTS_SCHEMA.split(";")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const sql of statements) {
      this.db.exec(sql);
    }
    this.initialized = true;
  }

  insert(envelope: Envelope): void {
    this.initialize();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO hc_envelopes (id, timestamp, type, source, subject, data, metadata, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      envelope.id,
      envelope.timestamp,
      envelope.type,
      envelope.source,
      envelope.subject ?? null,
      JSON.stringify(envelope.data),
      JSON.stringify(envelope.metadata),
      Date.now()
    );
  }

  insertBatch(envelopes: Envelope[]): void {
    if (envelopes.length === 0) return;
    this.initialize();
    const stmt = this.db.prepare(`
      INSERT OR IGNORE INTO hc_envelopes (id, timestamp, type, source, subject, data, metadata, ingested_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Date.now();
    const insertMany = this.db.transaction((items: Envelope[]) => {
      for (const e of items) {
        stmt.run(
          e.id,
          e.timestamp,
          e.type,
          e.source,
          e.subject ?? null,
          JSON.stringify(e.data),
          JSON.stringify(e.metadata),
          now
        );
      }
    });
    insertMany(envelopes);
  }

  query(filter: EventFilter, options: QueryOptions = {}): EventPage {
    this.initialize();
    const { limit = 100, cursor, order = "desc" } = options;
    const conditions: string[] = [];
    const args: unknown[] = [];

    if (filter.types?.length) {
      const patterns = filter.types.map((t) => this.buildLikePattern(t));
      const typeConditions = patterns.map(() => "type LIKE ?").join(" OR ");
      conditions.push(`(${typeConditions})`);
      args.push(...patterns);
    }

    if (filter.sources?.length) {
      const patterns = filter.sources.map((s) => this.buildLikePattern(s));
      const sourceConditions = patterns.map(() => "source LIKE ?").join(" OR ");
      conditions.push(`(${sourceConditions})`);
      args.push(...patterns);
    }

    if (filter.subjects?.length) {
      const patterns = filter.subjects.map((s) => this.buildLikePattern(s));
      const subjectConditions = patterns.map(() => "subject LIKE ?").join(" OR ");
      conditions.push(`(${subjectConditions})`);
      args.push(...patterns);
    }

    if (filter.since) {
      conditions.push("timestamp >= ?");
      args.push(filter.since);
    }

    if (filter.until) {
      conditions.push("timestamp <= ?");
      args.push(filter.until);
    }

    if (filter.metadata) {
      for (const [key, value] of Object.entries(filter.metadata)) {
        conditions.push(`json_extract(metadata, '$.${key}') = ?`);
        args.push(typeof value === "string" ? value : JSON.stringify(value));
      }
    }

    if (cursor) {
      const op = order === "desc" ? "<" : ">";
      conditions.push(`timestamp ${op} ?`);
      args.push(cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const orderDir = order === "desc" ? "DESC" : "ASC";
    const sql = `SELECT * FROM hc_envelopes ${where} ORDER BY timestamp ${orderDir} LIMIT ?`;
    args.push(limit + 1);

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.rowToEnvelope(row));
    const nextCursor = hasMore && events.length > 0
      ? events[events.length - 1]!.timestamp
      : undefined;

    return { events, cursor: nextCursor, hasMore };
  }

  search(query: string, filter: EventFilter = {}, options: QueryOptions = {}): EventPage {
    this.initialize();
    const { limit = 100, cursor, order = "desc" } = options;
    const conditions: string[] = ["hc_envelopes_fts MATCH ?"];
    const args: unknown[] = [query];

    if (filter.since) {
      conditions.push("e.timestamp >= ?");
      args.push(filter.since);
    }

    if (filter.until) {
      conditions.push("e.timestamp <= ?");
      args.push(filter.until);
    }

    if (cursor) {
      const op = order === "desc" ? "<" : ">";
      conditions.push(`e.timestamp ${op} ?`);
      args.push(cursor);
    }

    const where = conditions.join(" AND ");
    const orderDir = order === "desc" ? "DESC" : "ASC";
    const sql = `
      SELECT e.* FROM hc_envelopes e
      JOIN hc_envelopes_fts ON e.rowid = hc_envelopes_fts.rowid
      WHERE ${where}
      ORDER BY e.timestamp ${orderDir}
      LIMIT ?
    `;
    args.push(limit + 1);

    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const events = rows.slice(0, limit).map((row) => this.rowToEnvelope(row));
    const nextCursor = hasMore && events.length > 0
      ? events[events.length - 1]!.timestamp
      : undefined;

    return { events, cursor: nextCursor, hasMore };
  }

  setEmbedding(id: string, embedding: Float32Array): void {
    this.initialize();
    const stmt = this.db.prepare("UPDATE hc_envelopes SET embedding = ? WHERE id = ?");
    stmt.run(Buffer.from(embedding.buffer), id);
  }

  insertDeadLetter(entry: DeadLetterEntry): void {
    this.initialize();
    const stmt = this.db.prepare(`
      INSERT INTO hc_dead_letter (envelope_id, envelope_data, error, attempts, last_attempt, handler_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      entry.envelope.id,
      JSON.stringify(entry.envelope),
      entry.error,
      entry.attempts,
      entry.lastAttempt,
      entry.handlerId,
      Date.now()
    );
  }

  getDeadLetterEntries(handlerId?: string, limit = 100): DeadLetterEntry[] {
    this.initialize();
    const sql = handlerId
      ? "SELECT * FROM hc_dead_letter WHERE handler_id = ? ORDER BY created_at DESC LIMIT ?"
      : "SELECT * FROM hc_dead_letter ORDER BY created_at DESC LIMIT ?";
    const args = handlerId ? [handlerId, limit] : [limit];
    const rows = this.db.prepare(sql).all(...args) as Record<string, unknown>[];
    return rows.map((row) => ({
      envelope: JSON.parse(row["envelope_data"] as string) as Envelope,
      error: row["error"] as string,
      attempts: row["attempts"] as number,
      lastAttempt: row["last_attempt"] as string,
      handlerId: row["handler_id"] as string,
    }));
  }

  removeDeadLetter(envelopeId: string, handlerId: string): void {
    this.initialize();
    const stmt = this.db.prepare(
      "DELETE FROM hc_dead_letter WHERE envelope_id = ? AND handler_id = ?"
    );
    stmt.run(envelopeId, handlerId);
  }

  prune(before: string): number {
    this.initialize();
    const result = this.db.prepare(
      "DELETE FROM hc_envelopes WHERE timestamp < ?"
    ).run(before);
    return result.changes;
  }

  private buildLikePattern(pattern: string): string {
    return pattern.replace(/\*/g, "%");
  }

  private rowToEnvelope(row: Record<string, unknown>): Envelope {
    return {
      id: row["id"] as string,
      timestamp: row["timestamp"] as string,
      type: row["type"] as string,
      source: row["source"] as string,
      subject: row["subject"] as string | undefined,
      data: JSON.parse(row["data"] as string),
      metadata: JSON.parse(row["metadata"] as string),
    };
  }
}
