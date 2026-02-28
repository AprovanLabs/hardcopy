import { join } from "path";
import { readFile, writeFile, stat } from "fs/promises";
import matter from "gray-matter";
import { setDocContent } from "../crdt";
import {
  autoMergeField,
  detectConflicts,
  hasUnresolvableConflicts,
  parseConflictMarkers,
} from "../conflict";
import { mergeText } from "../merge";
import { parseFile, getFormat } from "../format";
import type { Provider } from "../provider";
import {
  ConflictStatus,
  type Change,
  type ConflictInfo,
  type FieldConflict,
} from "../types";
import type { Hardcopy } from "./core";
import type { PushStats, DiffResult, StatusInfo } from "./types";
import { diff } from "./diff";
import { detectChanges } from "./diff";

export async function push(
  this: Hardcopy,
  filePath?: string,
  options: { force?: boolean } = {},
): Promise<PushStats> {
  await this.loadConfig();
  const db = this.getDatabase();
  const crdt = this.getCRDTStore();
  const stats: PushStats = {
    pushed: 0,
    skipped: 0,
    conflicts: 0,
    errors: [],
  };

  const diffs = await diff.call(this, filePath);

  for (const diffResult of diffs) {
    if (diffResult.changes.length === 0) {
      stats.skipped++;
      continue;
    }

    const provider = findProviderForNode.call(this, diffResult.nodeId);
    if (!provider) {
      stats.errors.push(`No provider for ${diffResult.nodeId}`);
      continue;
    }

    const dbNode = await db.getNode(diffResult.nodeId);
    if (!dbNode) {
      stats.errors.push(`Node not found: ${diffResult.nodeId}`);
      continue;
    }

    const format = getFormat(dbNode.type);
    if (!format) {
      stats.errors.push(`No format for ${dbNode.type}`);
      continue;
    }

    try {
      const localParsed = await parseLocalFile(diffResult.filePath);
      if (!localParsed) {
        stats.errors.push(`Failed to parse ${diffResult.filePath}`);
        continue;
      }

      const remoteNode = await provider.fetchNode(diffResult.nodeId);
      let changes = diffResult.changes;

      if (remoteNode && !options.force) {
        let conflicts = detectConflicts(
          dbNode,
          localParsed,
          remoteNode,
          format.editableFields,
        );

        const semanticMerges = await trySemanticMerges.call(
          this,
          conflicts,
          diffResult.filePath,
        );
        if (semanticMerges.size > 0) {
          changes = applySemanticMerges(changes, semanticMerges);
          conflicts = conflicts.map((conflict) =>
            semanticMerges.has(conflict.field)
              ? { ...conflict, status: ConflictStatus.CLEAN }
              : conflict,
          );
        }

        if (hasUnresolvableConflicts(conflicts)) {
          await saveConflict.call(this, diffResult, conflicts, dbNode.type);
          stats.conflicts++;
          continue;
        }

        changes = applyAutoMerges(changes, conflicts);
      }

      const result = await provider.push(dbNode, changes);
      if (result.success) {
        const updatedAttrs = { ...dbNode.attrs };
        for (const change of changes) {
          updatedAttrs[change.field] = change.newValue;
        }
        await db.upsertNode({
          ...dbNode,
          attrs: updatedAttrs,
          syncedAt: Date.now(),
        });

        const doc = await crdt.loadOrCreate(diffResult.nodeId);
        const bodyChange = changes.find((c) => c.field === "body");
        if (bodyChange) {
          setDocContent(doc, bodyChange.newValue as string);
        }
        await crdt.save(diffResult.nodeId, doc);

        try {
          await updateLocalFileAfterPush(diffResult.filePath, changes);
          const fileStat = await stat(diffResult.filePath);
          await db.setFileSyncedAt(diffResult.nodeId, diffResult.viewRelPath, fileStat.mtimeMs);
        } catch (err) {
          stats.errors.push(
            `Failed to update local file ${diffResult.filePath}: ${err}`,
          );
        }

        stats.pushed++;
      } else {
        stats.errors.push(`Push failed for ${diffResult.nodeId}: ${result.error}`);
      }
    } catch (err) {
      stats.errors.push(`Error pushing ${diffResult.nodeId}: ${err}`);
    }
  }

  return stats;
}

export async function status(this: Hardcopy): Promise<StatusInfo> {
  const db = this.getDatabase();
  const nodes = await db.queryNodes();
  const [edges] = await Promise.all([db.getEdges()]);

  const byType = new Map<string, number>();
  for (const node of nodes) {
    byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
  }

  const { getChangedFiles } = await import("./diff");
  const changedFiles = await getChangedFiles.call(this);
  const conflicts = await listConflicts.call(this);

  return {
    totalNodes: nodes.length,
    totalEdges: edges.length,
    nodesByType: Object.fromEntries(byType),
    changedFiles,
    conflicts,
  };
}

export async function listConflicts(this: Hardcopy): Promise<ConflictInfo[]> {
  return this.getConflictStore().list();
}

export async function getConflict(
  this: Hardcopy,
  nodeId: string,
): Promise<ConflictInfo | null> {
  return this.getConflictStore().get(nodeId);
}

export async function getConflictDetail(
  this: Hardcopy,
  nodeId: string,
): Promise<{
  info: ConflictInfo;
  body: string;
  artifactPath: string;
} | null> {
  const store = this.getConflictStore();
  const detail = await store.read(nodeId);
  if (!detail) return null;
  return {
    info: detail.info,
    body: detail.body,
    artifactPath: store.getArtifactPath(nodeId),
  };
}

export async function resolveConflict(
  this: Hardcopy,
  nodeId: string,
  resolution: Record<string, "local" | "remote">,
): Promise<void> {
  const store = this.getConflictStore();
  const conflict = await store.read(nodeId);
  if (!conflict) throw new Error(`Conflict not found: ${nodeId}`);

  const db = this.getDatabase();
  const dbNode = await db.getNode(nodeId);
  if (!dbNode) throw new Error(`Node not found: ${nodeId}`);

  const provider = findProviderForNode.call(this, nodeId);
  if (!provider) throw new Error(`No provider for ${nodeId}`);

  const format = getFormat(dbNode.type);
  if (!format) throw new Error(`No format for ${dbNode.type}`);

  const blocks = parseConflictBlocks(conflict.body);
  if (blocks.size === 0) {
    throw new Error(`No conflict markers found for ${nodeId}`);
  }

  const fileContent = await readFile(conflict.info.filePath, "utf-8");
  const parsed = matter(fileContent);
  const attrs = parsed.data as Record<string, unknown>;
  let body = parsed.content.trim();

  const updatedAttrs = { ...dbNode.attrs };

  for (const [field, choice] of Object.entries(resolution)) {
    const block = blocks.get(field);
    if (!block) continue;
    const value = choice === "local" ? block.local : block.remote;

    if (field === "body") {
      body = value;
      updatedAttrs["body"] = value;
    } else {
      attrs[field] = value;
      updatedAttrs[field] = value;
    }
  }

  const nextContent = matter.stringify(body, attrs);
  await writeFile(conflict.info.filePath, nextContent);

  const fileStat = await stat(conflict.info.filePath);
  await db.setFileSyncedAt(nodeId, conflict.info.viewRelPath, fileStat.mtimeMs);

  const parsedForChanges = { attrs, body };
  const changes = detectChanges(
    parsedForChanges,
    dbNode,
    format.editableFields,
  );

  if (changes.length > 0) {
    const result = await provider.push(dbNode, changes);
    if (!result.success) {
      throw new Error(`Push failed for ${nodeId}: ${result.error}`);
    }
  }

  await db.upsertNode({
    ...dbNode,
    attrs: updatedAttrs,
    syncedAt: Date.now(),
  });

  const crdt = this.getCRDTStore();
  const doc = await crdt.loadOrCreate(nodeId);
  if (updatedAttrs["body"] !== undefined) {
    setDocContent(doc, String(updatedAttrs["body"] ?? ""));
  }
  await crdt.save(nodeId, doc);

  await store.remove(nodeId);
}

function findProviderForNode(this: Hardcopy, nodeId: string): Provider | undefined {
  const [providerPrefix] = nodeId.split(":");
  for (const [, provider] of this.getProviders()) {
    if (provider.name === providerPrefix) return provider;
  }
  return undefined;
}

async function parseLocalFile(
  fullPath: string,
): Promise<{ attrs: Record<string, unknown>; body: string } | null> {
  try {
    const content = await readFile(fullPath, "utf-8");
    return parseFile(content, "generic");
  } catch {
    return null;
  }
}

async function updateLocalFileAfterPush(
  fullPath: string,
  changes: Change[],
): Promise<void> {
  const content = await readFile(fullPath, "utf-8");
  const parsed = matter(content);
  const attrs = parsed.data as Record<string, unknown>;
  let body = parsed.content;

  for (const change of changes) {
    if (change.field === "body") {
      body = String(change.newValue ?? "");
      continue;
    }
    if (change.newValue === undefined || change.newValue === null) {
      delete attrs[change.field];
    } else {
      attrs[change.field] = change.newValue;
    }
  }

  const nextContent = matter.stringify(body, attrs);
  await writeFile(fullPath, nextContent);
}

async function saveConflict(
  this: Hardcopy,
  diffResult: DiffResult,
  conflicts: FieldConflict[],
  nodeType: string,
): Promise<void> {
  const store = this.getConflictStore();
  await store.save({
    nodeId: diffResult.nodeId,
    nodeType,
    filePath: diffResult.filePath,
    viewRelPath: diffResult.viewRelPath,
    detectedAt: Date.now(),
    fields: conflicts,
  });
}

function applyAutoMerges(
  changes: Change[],
  conflicts: FieldConflict[],
): Change[] {
  const mergedByField = new Map<string, unknown>();
  for (const conflict of conflicts) {
    const merged = autoMergeField(conflict);
    if (merged !== null) {
      mergedByField.set(conflict.field, merged);
    }
  }

  if (mergedByField.size === 0) return changes;

  const mergedChanges = changes.map((change) => {
    if (!mergedByField.has(change.field)) return change;
    return {
      ...change,
      newValue: mergedByField.get(change.field),
    };
  });

  for (const [field, value] of mergedByField) {
    if (!mergedChanges.find((change) => change.field === field)) {
      mergedChanges.push({ field, oldValue: undefined, newValue: value });
    }
  }

  return mergedChanges;
}

async function trySemanticMerges(
  this: Hardcopy,
  conflicts: FieldConflict[],
  filePath: string,
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const bodyConflict = conflicts.find(
    (conflict) =>
      conflict.field === "body" &&
      conflict.status === ConflictStatus.DIVERGED &&
      !conflict.canAutoMerge,
  );

  if (!bodyConflict) return result;

  const base = String(bodyConflict.base ?? "");
  const local = String(bodyConflict.local ?? "");
  const remote = String(bodyConflict.remote ?? "");

  const merged = await mergeText(base, local, remote, {
    tempDir: join(this.dataDir, "tmp", "merge"),
    filePath,
    llmOptions: {
      baseURL: process.env.OPENAI_BASE_URL,
      model: process.env.OPENAI_MODEL,
      apiKey: process.env.OPENAI_API_KEY,
    },
  });

  if (merged !== null) {
    result.set("body", merged);
  }

  return result;
}

function applySemanticMerges(
  changes: Change[],
  merged: Map<string, string>,
): Change[] {
  if (merged.size === 0) return changes;

  const next = changes.map((change) => {
    if (!merged.has(change.field)) return change;
    return { ...change, newValue: merged.get(change.field) };
  });

  for (const [field, value] of merged) {
    if (!next.find((change) => change.field === field)) {
      next.push({ field, oldValue: undefined, newValue: value });
    }
  }

  return next;
}

function parseConflictBlocks(
  content: string,
): Map<string, { local: string; base: string; remote: string }> {
  const blocks = new Map<
    string,
    { local: string; base: string; remote: string }
  >();
  const regex = /^\s*##\s+(.+?)\r?\n([\s\S]*?)(?=^\s*##\s+|\s*$)/gm;
  for (const match of content.matchAll(regex)) {
    const field = match[1]?.trim();
    const block = match[2] ?? "";
    if (!field) continue;
    const parsed = parseConflictMarkers(block);
    if (parsed) blocks.set(field, parsed);
  }

  if (blocks.size === 0) {
    const parsed = parseConflictMarkers(content);
    if (parsed) blocks.set("body", parsed);
  }
  return blocks;
}
