import { join } from "path";
import { readFile, stat } from "fs/promises";
import { minimatch } from "minimatch";
import { parseFile, getFormat } from "../format";
import type { Node, Change } from "../types";
import type { Hardcopy } from "./core";
import type { DiffResult, ChangedFile } from "./types";
import { listViewFiles } from "./views";

export async function getChangedFiles(
  this: Hardcopy,
  pattern?: string,
): Promise<ChangedFile[]> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const changedFiles: ChangedFile[] = [];

  for (const view of config.views) {
    const viewDir = join(this.root, view.path);
    const files = await listViewFiles(viewDir);

    for (const relPath of files) {
      const fullPath = join(viewDir, relPath);
      const viewRelPath = join(view.path, relPath);

      if (
        pattern &&
        !minimatch(viewRelPath, pattern) &&
        !viewRelPath.startsWith(pattern)
      ) {
        continue;
      }

      const fileStat = await stat(fullPath).catch(() => null);
      if (!fileStat) continue;

      const content = await readFile(fullPath, "utf-8");
      const parsed = parseFile(content, "generic");
      const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as
        | string
        | undefined;
      if (!nodeId) continue;

      const dbNode = await db.getNode(nodeId);
      const fileMtime = fileStat.mtimeMs;
      const fileSyncedAt = await db.getFileSyncedAt(nodeId, viewRelPath);
      const syncedAt = fileSyncedAt ?? dbNode?.syncedAt ?? 0;

      if (fileMtime > syncedAt) {
        changedFiles.push({
          path: viewRelPath,
          fullPath,
          nodeId,
          nodeType:
            dbNode?.type ?? (parsed.attrs._type as string) ?? "unknown",
          status: dbNode ? "modified" : "new",
          mtime: fileMtime,
          syncedAt,
        });
      }
    }
  }

  return changedFiles;
}

export async function diff(
  this: Hardcopy,
  pattern?: string,
  options: { smart?: boolean } = {},
): Promise<DiffResult[]> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const results: DiffResult[] = [];

  const useSmart = options.smart !== false;

  if (useSmart && pattern) {
    const candidates = await getChangedFiles.call(this, pattern);
    for (const candidate of candidates) {
      const result = await diffFile.call(this, candidate.fullPath, candidate.path, db);
      if (result && result.changes.length > 0) {
        results.push(result);
      }
    }
    return results;
  }

  for (const view of config.views) {
    const viewDir = join(this.root, view.path);
    const files = await listViewFiles(viewDir);

    for (const relPath of files) {
      const fullPath = join(viewDir, relPath);
      const viewRelPath = join(view.path, relPath);

      if (pattern) {
        const targetPath = join(this.root, pattern);
        const isExactMatch = fullPath === targetPath;
        const isGlobMatch = minimatch(viewRelPath, pattern);
        const isPrefixMatch = viewRelPath.startsWith(pattern);
        if (!isExactMatch && !isGlobMatch && !isPrefixMatch) continue;
      }

      const result = await diffFile.call(this, fullPath, viewRelPath, db);
      if (result && result.changes.length > 0) {
        results.push(result);
      }
    }
  }

  return results;
}

async function diffFile(
  this: Hardcopy,
  fullPath: string,
  viewRelPath: string,
  db: ReturnType<Hardcopy["getDatabase"]>,
): Promise<DiffResult | null> {
  try {
    const content = await readFile(fullPath, "utf-8");
    const parsed = parseFile(content, "generic");

    const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as string | undefined;
    const nodeType = parsed.attrs._type as string | undefined;
    if (!nodeId) return null;

    const dbNode = await db.getNode(nodeId);
    if (!dbNode) {
      return {
        nodeId,
        nodeType: nodeType ?? "unknown",
        filePath: fullPath,
        viewRelPath,
        changes: [{ field: "_new", oldValue: null, newValue: parsed.attrs }],
      };
    }

    const format = getFormat(dbNode.type);
    if (!format) return null;

    const changes = detectChanges(parsed, dbNode, format.editableFields);
    return {
      nodeId,
      nodeType: dbNode.type,
      filePath: fullPath,
      viewRelPath,
      changes,
    };
  } catch {
    return null;
  }
}

export function detectChanges(
  parsed: { attrs: Record<string, unknown>; body: string },
  dbNode: Node,
  editableFields: string[],
): Change[] {
  const changes: Change[] = [];
  const dbAttrs = dbNode.attrs as Record<string, unknown>;

  for (const field of editableFields) {
    if (field === "body") {
      const oldBody = ((dbAttrs["body"] as string) ?? "").trim();
      const newBody = parsed.body.trim();
      if (newBody !== oldBody) {
        changes.push({ field: "body", oldValue: oldBody, newValue: newBody });
      }
    } else {
      const oldValue = dbAttrs[field];
      const newValue = parsed.attrs[field];
      if (!valuesEqual(oldValue, newValue)) {
        changes.push({ field, oldValue, newValue });
      }
    }
  }

  return changes;
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return (
      a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]))
    );
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
