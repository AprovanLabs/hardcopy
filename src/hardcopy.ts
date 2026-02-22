import { join, relative } from "path";
import {
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  readdir,
  stat,
} from "fs/promises";
import { minimatch } from "minimatch";
import matter from "gray-matter";
import { Database } from "./db";
import { CRDTStore, getDocContent, setDocContent, setDocAttrs } from "./crdt";
import {
  autoMergeField,
  detectConflicts,
  hasUnresolvableConflicts,
  parseConflictMarkers,
} from "./conflict";
import { ConflictStore } from "./conflict-store";
import {
  loadConfig,
  type Config,
  type SourceConfig,
  type ViewConfig,
  type RenderConfig,
} from "./config";
import { getProvider, type Provider } from "./provider";
import { renderNode, parseFile, registerFormat, getFormat } from "./format";
import { githubIssueFormat } from "./formats/github-issue";
import { parseQuery, filterNodes } from "./query";
import type {
  Node,
  IndexState,
  FetchResult,
  Change,
  ConflictInfo,
  FieldConflict,
} from "./types";
import "./providers";

registerFormat(githubIssueFormat);

export interface HardcopyOptions {
  root: string;
}

export class Hardcopy {
  readonly root: string;
  readonly dataDir: string;
  private db: Database | null = null;
  private crdt: CRDTStore | null = null;
  private config: Config | null = null;
  private providers = new Map<string, Provider>();
  private conflictStore: ConflictStore | null = null;

  constructor(options: HardcopyOptions) {
    this.root = options.root;
    this.dataDir = join(options.root, ".hardcopy");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await mkdir(join(this.dataDir, "crdt"), { recursive: true });
    this.db = await Database.open(join(this.dataDir, "db.sqlite"));
    this.crdt = new CRDTStore(join(this.dataDir, "crdt"));
  }

  async loadConfig(): Promise<Config> {
    if (this.config) return this.config;
    const configPath = join(this.root, "hardcopy.yaml");
    this.config = await loadConfig(configPath);
    await this.initializeProviders();
    return this.config;
  }

  private async initializeProviders(): Promise<void> {
    if (!this.config) return;
    for (const source of this.config.sources) {
      const factory = getProvider(source.provider);
      if (factory) {
        this.providers.set(source.name, factory(source));
      }
    }
  }

  getDatabase(): Database {
    if (!this.db) throw new Error("Database not initialized");
    return this.db;
  }

  getCRDTStore(): CRDTStore {
    if (!this.crdt) throw new Error("CRDT store not initialized");
    return this.crdt;
  }

  private getConflictStore(): ConflictStore {
    if (!this.conflictStore) {
      this.conflictStore = new ConflictStore(join(this.dataDir, "conflicts"));
    }
    return this.conflictStore;
  }

  async getViews(): Promise<string[]> {
    const config = await this.loadConfig();
    return config.views.map((v) => v.path);
  }

  async sync(): Promise<SyncStats> {
    const config = await this.loadConfig();
    const db = this.getDatabase();
    const stats: SyncStats = { nodes: 0, edges: 0, errors: [] };

    for (const source of config.sources) {
      const provider = this.providers.get(source.name);
      if (!provider) {
        stats.errors.push(`Provider not found: ${source.provider}`);
        continue;
      }

      try {
        const result = await provider.fetch({ query: {} });
        if (!result.cached) {
          await db.upsertNodes(
            result.nodes.map((n) => ({
              ...n,
              syncedAt: Date.now(),
              versionToken: result.versionToken ?? undefined,
            })),
          );
          await db.upsertEdges(result.edges);
          stats.nodes += result.nodes.length;
          stats.edges += result.edges.length;
        }
      } catch (err) {
        stats.errors.push(`Error syncing ${source.name}: ${err}`);
      }
    }

    return stats;
  }

  async refreshView(
    viewPath: string,
    options: { clean?: boolean } = {},
  ): Promise<RefreshResult> {
    const config = await this.loadConfig();
    const view = config.views.find((v) => v.path === viewPath);
    if (!view) throw new Error(`View not found: ${viewPath}`);

    const viewDir = join(this.root, view.path);
    await mkdir(viewDir, { recursive: true });

    const db = this.getDatabase();
    const allNodes = await db.queryNodes();

    // Filter nodes using the view's query
    const parsedQuery = parseQuery(view.query);
    const nodes = filterNodes(allNodes, parsedQuery);

    const indexState: IndexState = {
      loaded: nodes.length,
      pageSize: 10,
      lastFetch: new Date().toISOString(),
      ttl: 300,
    };

    await writeFile(
      join(viewDir, ".index"),
      JSON.stringify(indexState, null, 2),
    );

    // Track which files we render
    const expectedFiles = new Set<string>();

    for (const node of nodes) {
      const renderedPaths = await this.renderNodeToFile(node, view, viewDir);
      for (const p of renderedPaths) {
        expectedFiles.add(p);
      }
    }

    // Find orphaned files
    const existingFiles = await this.listViewFiles(viewDir);
    const orphanedFiles = existingFiles.filter((f) => !expectedFiles.has(f));

    // Clean up orphaned files if requested
    if (options.clean && orphanedFiles.length > 0) {
      await this.cleanupOrphanedFiles(viewDir, orphanedFiles);
    }

    return {
      rendered: expectedFiles.size,
      orphaned: orphanedFiles,
      cleaned: options.clean ?? false,
    };
  }

  private async cleanupOrphanedFiles(
    viewDir: string,
    orphanedFiles: string[],
  ): Promise<void> {
    for (const relPath of orphanedFiles) {
      const fullPath = join(viewDir, relPath);

      // Check for local changes and sync them first
      await this.syncFileBeforeDelete(fullPath);

      // Delete the orphaned file
      try {
        await rm(fullPath);
        console.log(`Deleted orphaned file: ${relPath}`);
      } catch (err) {
        console.error(`Failed to delete ${relPath}: ${err}`);
      }
    }
  }

  private async listViewFiles(viewDir: string): Promise<string[]> {
    const files: string[] = [];

    async function walk(dir: string, base: string): Promise<void> {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        const relPath = base ? `${base}/${entry.name}` : entry.name;

        // Skip hidden files and the .index file
        if (entry.name.startsWith(".")) continue;

        if (entry.isDirectory()) {
          await walk(join(dir, entry.name), relPath);
        } else if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(relPath);
        }
      }
    }

    await walk(viewDir, "");
    return files;
  }

  private async syncFileBeforeDelete(fullPath: string): Promise<void> {
    try {
      const content = await readFile(fullPath, "utf-8");

      // Try to find the node ID from frontmatter
      const parsed = parseFile(content, "generic");
      // The node ID is stored as _id in frontmatter by format handlers
      const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as
        | string
        | undefined;
      const nodeType = parsed.attrs._type as string | undefined;

      if (!nodeId) {
        // No node ID, can't sync
        return;
      }

      const crdt = this.getCRDTStore();
      const doc = await crdt.load(nodeId);

      if (!doc) {
        // No CRDT doc exists, nothing to sync
        return;
      }

      // Compare local content with CRDT content
      const crdtContent = getDocContent(doc);
      if (parsed.body !== crdtContent) {
        // Local changes detected - log for now
        // In the future, this should push changes to remote
        console.warn(
          `Warning: File for ${nodeId} has local changes that may be lost. ` +
            `Run 'hardcopy push' first to preserve changes.`,
        );
        // TODO: Push changes to remote provider before deleting
      }

      // Also delete the CRDT file
      await crdt.delete(nodeId);
    } catch (err) {
      // File might not be parseable, skip sync
    }
  }

  private async renderNodeToFile(
    node: Node,
    view: ViewConfig,
    viewDir: string,
  ): Promise<string[]> {
    const renderedPaths: string[] = [];
    const crdt = this.getCRDTStore();
    const db = this.getDatabase();

    for (const renderConfig of view.render) {
      const filePath = this.resolveRenderPath(renderConfig.path, node);
      const fullPath = join(viewDir, filePath);
      await mkdir(join(fullPath, ".."), { recursive: true });

      let content: string;
      if (renderConfig.template) {
        content = renderNode(node, renderConfig.template);
      } else if (renderConfig.type) {
        content = renderNode({ ...node, type: renderConfig.type });
      } else {
        content = renderNode(node);
      }

      // Update CRDT with current remote state (body content)
      const doc = await crdt.loadOrCreate(node.id);
      const body = (node.attrs["body"] as string) ?? "";
      setDocContent(doc, body);
      setDocAttrs(doc, node.attrs as Record<string, unknown>);
      await crdt.save(node.id, doc);

      await writeFile(fullPath, content);

      // Update syncedAt to match file write time (so mtime comparisons work)
      const fileStat = await stat(fullPath);
      await db.upsertNode({ ...node, syncedAt: fileStat.mtimeMs });

      renderedPaths.push(filePath);
    }

    return renderedPaths;
  }

  private resolveRenderPath(template: string, node: Node): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
      const parts = path.trim().split(".");
      let current: unknown = { ...node, ...node.attrs };
      for (const part of parts) {
        if (current === null || current === undefined) return "";
        current = (current as Record<string, unknown>)[part];
      }
      return String(current ?? "");
    });
  }

  async status(): Promise<StatusInfo> {
    const db = this.getDatabase();
    const nodes = await db.queryNodes();
    const [edges] = await Promise.all([db.getEdges()]);

    const byType = new Map<string, number>();
    for (const node of nodes) {
      byType.set(node.type, (byType.get(node.type) ?? 0) + 1);
    }

    // Get changed files using smart diff
    const changedFiles = await this.getChangedFiles();
    const conflicts = await this.listConflicts();

    return {
      totalNodes: nodes.length,
      totalEdges: edges.length,
      nodesByType: Object.fromEntries(byType),
      changedFiles,
      conflicts,
    };
  }

  async listConflicts(): Promise<ConflictInfo[]> {
    return this.getConflictStore().list();
  }

  async getConflict(nodeId: string): Promise<ConflictInfo | null> {
    return this.getConflictStore().get(nodeId);
  }

  async resolveConflict(
    nodeId: string,
    resolution: Record<string, "local" | "remote">,
  ): Promise<void> {
    const store = this.getConflictStore();
    const conflict = await store.read(nodeId);
    if (!conflict) throw new Error(`Conflict not found: ${nodeId}`);

    const blocks = this.parseConflictBlocks(conflict.body);
    if (blocks.size === 0) return;

    const fileContent = await readFile(conflict.info.filePath, "utf-8");
    const parsed = matter(fileContent);
    const attrs = parsed.data as Record<string, unknown>;
    let body = parsed.content.trim();

    const db = this.getDatabase();
    const dbNode = await db.getNode(nodeId);
    const updatedAttrs = dbNode ? { ...dbNode.attrs } : {};

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

    if (dbNode) {
      await db.upsertNode({
        ...dbNode,
        attrs: updatedAttrs,
        syncedAt: Date.now(),
      });
    }

    if (resolution["body"]) {
      const crdt = this.getCRDTStore();
      const doc = await crdt.loadOrCreate(nodeId);
      setDocContent(doc, String(updatedAttrs["body"] ?? ""));
      await crdt.save(nodeId, doc);
    }

    await store.remove(nodeId);
  }

  async getChangedFiles(pattern?: string): Promise<ChangedFile[]> {
    const config = await this.loadConfig();
    const db = this.getDatabase();
    const changedFiles: ChangedFile[] = [];

    for (const view of config.views) {
      const viewDir = join(this.root, view.path);
      const files = await this.listViewFiles(viewDir);

      for (const relPath of files) {
        const fullPath = join(viewDir, relPath);
        const viewRelPath = join(view.path, relPath);

        // Pattern matching (glob support)
        if (
          pattern &&
          !minimatch(viewRelPath, pattern) &&
          !viewRelPath.startsWith(pattern)
        ) {
          continue;
        }

        // Check file mtime vs synced_at
        const fileStat = await stat(fullPath).catch(() => null);
        if (!fileStat) continue;

        // Quick check: read just the frontmatter to get node ID
        const content = await readFile(fullPath, "utf-8");
        const parsed = parseFile(content, "generic");
        const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as
          | string
          | undefined;
        if (!nodeId) continue;

        const dbNode = await db.getNode(nodeId);
        const fileMtime = fileStat.mtimeMs;
        const syncedAt = dbNode?.syncedAt ?? 0;

        // File modified after last sync - candidate for diff
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

  async diff(
    pattern?: string,
    options: { smart?: boolean } = {},
  ): Promise<DiffResult[]> {
    const config = await this.loadConfig();
    const db = this.getDatabase();
    const results: DiffResult[] = [];

    // Use smart mode by default - only diff files that have changed based on mtime
    const useSmart = options.smart !== false;

    if (useSmart && pattern) {
      // Get candidates based on file metadata
      const candidates = await this.getChangedFiles(pattern);
      for (const candidate of candidates) {
        const result = await this.diffFile(candidate.fullPath, db);
        if (result && result.changes.length > 0) {
          results.push(result);
        }
      }
      return results;
    }

    // Fallback: check all files (or pattern match without smart detection)
    for (const view of config.views) {
      const viewDir = join(this.root, view.path);
      const files = await this.listViewFiles(viewDir);

      for (const relPath of files) {
        const fullPath = join(viewDir, relPath);
        const viewRelPath = join(view.path, relPath);

        // Pattern matching: exact path, glob, or prefix
        if (pattern) {
          const targetPath = join(this.root, pattern);
          const isExactMatch = fullPath === targetPath;
          const isGlobMatch = minimatch(viewRelPath, pattern);
          const isPrefixMatch = viewRelPath.startsWith(pattern);
          if (!isExactMatch && !isGlobMatch && !isPrefixMatch) continue;
        }

        const result = await this.diffFile(fullPath, db);
        if (result && result.changes.length > 0) {
          results.push(result);
        }
      }
    }

    return results;
  }

  private async diffFile(
    fullPath: string,
    db: Database,
  ): Promise<DiffResult | null> {
    try {
      const content = await readFile(fullPath, "utf-8");
      const parsed = parseFile(content, "generic");

      const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as
        | string
        | undefined;
      const nodeType = parsed.attrs._type as string | undefined;
      if (!nodeId) return null;

      const dbNode = await db.getNode(nodeId);
      if (!dbNode) {
        return {
          nodeId,
          nodeType: nodeType ?? "unknown",
          filePath: fullPath,
          changes: [{ field: "_new", oldValue: null, newValue: parsed.attrs }],
        };
      }

      const format = getFormat(dbNode.type);
      if (!format) return null;

      const changes = this.detectChanges(parsed, dbNode, format.editableFields);
      return {
        nodeId,
        nodeType: dbNode.type,
        filePath: fullPath,
        changes,
      };
    } catch {
      return null;
    }
  }

  private detectChanges(
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
        if (!this.valuesEqual(oldValue, newValue)) {
          changes.push({ field, oldValue, newValue });
        }
      }
    }

    return changes;
  }

  private valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (a == null && b == null) return true;
    if (Array.isArray(a) && Array.isArray(b)) {
      return (
        a.length === b.length && a.every((v, i) => this.valuesEqual(v, b[i]))
      );
    }
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async push(
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

    const diffs = await this.diff(filePath);

    for (const diff of diffs) {
      if (diff.changes.length === 0) {
        stats.skipped++;
        continue;
      }

      const provider = this.findProviderForNode(diff.nodeId);
      if (!provider) {
        stats.errors.push(`No provider for ${diff.nodeId}`);
        continue;
      }

      const dbNode = await db.getNode(diff.nodeId);
      if (!dbNode) {
        stats.errors.push(`Node not found: ${diff.nodeId}`);
        continue;
      }

      const format = getFormat(dbNode.type);
      if (!format) {
        stats.errors.push(`No format for ${dbNode.type}`);
        continue;
      }

      try {
        const localParsed = await this.parseLocalFile(diff.filePath);
        if (!localParsed) {
          stats.errors.push(`Failed to parse ${diff.filePath}`);
          continue;
        }

        const remoteNode = await provider.fetchNode(diff.nodeId);
        let changes = diff.changes;

        if (remoteNode && !options.force) {
          const conflicts = detectConflicts(
            dbNode,
            localParsed,
            remoteNode,
            format.editableFields,
          );

          if (hasUnresolvableConflicts(conflicts)) {
            await this.saveConflict(diff, conflicts, dbNode.type);
            stats.conflicts++;
            continue;
          }

          changes = this.applyAutoMerges(changes, conflicts);
        }

        const result = await provider.push(dbNode, changes);
        if (result.success) {
          // Update local node with changes
          const updatedAttrs = { ...dbNode.attrs };
          for (const change of changes) {
            updatedAttrs[change.field] = change.newValue;
          }
          await db.upsertNode({
            ...dbNode,
            attrs: updatedAttrs,
            syncedAt: Date.now(),
          });

          // Update CRDT
          const doc = await crdt.loadOrCreate(diff.nodeId);
          const bodyChange = changes.find((c) => c.field === "body");
          if (bodyChange) {
            setDocContent(doc, bodyChange.newValue as string);
          }
          await crdt.save(diff.nodeId, doc);

          stats.pushed++;
        } else {
          stats.errors.push(`Push failed for ${diff.nodeId}: ${result.error}`);
        }
      } catch (err) {
        stats.errors.push(`Error pushing ${diff.nodeId}: ${err}`);
      }
    }

    return stats;
  }

  private async parseLocalFile(
    fullPath: string,
  ): Promise<{ attrs: Record<string, unknown>; body: string } | null> {
    try {
      const content = await readFile(fullPath, "utf-8");
      return parseFile(content, "generic");
    } catch {
      return null;
    }
  }

  private async saveConflict(
    diff: DiffResult,
    conflicts: FieldConflict[],
    nodeType: string,
  ): Promise<void> {
    const store = this.getConflictStore();
    await store.save({
      nodeId: diff.nodeId,
      nodeType,
      filePath: diff.filePath,
      detectedAt: Date.now(),
      fields: conflicts,
    });
  }

  private applyAutoMerges(
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

  private parseConflictBlocks(
    content: string,
  ): Map<string, { local: string; base: string; remote: string }> {
    const blocks = new Map<
      string,
      { local: string; base: string; remote: string }
    >();
    const regex = /^##\s+(.+?)\n([\s\S]*?)(?=^##\s+|\s*$)/gm;
    for (const match of content.matchAll(regex)) {
      const field = match[1]?.trim();
      const block = match[2] ?? "";
      if (!field) continue;
      const parsed = parseConflictMarkers(block);
      if (parsed) blocks.set(field, parsed);
    }
    return blocks;
  }

  private findProviderForNode(nodeId: string): Provider | undefined {
    const [providerPrefix] = nodeId.split(":");
    for (const [name, provider] of this.providers) {
      if (provider.name === providerPrefix) return provider;
    }
    return undefined;
  }

  async close(): Promise<void> {
    if (this.db) {
      await this.db.close();
      this.db = null;
    }
  }
}

export interface SyncStats {
  nodes: number;
  edges: number;
  errors: string[];
}

export interface StatusInfo {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  changedFiles: ChangedFile[];
  conflicts: ConflictInfo[];
}

export interface ChangedFile {
  path: string;
  fullPath: string;
  nodeId: string;
  nodeType: string;
  status: "new" | "modified" | "deleted";
  mtime: number;
  syncedAt: number;
}

export interface RefreshResult {
  rendered: number;
  orphaned: string[];
  cleaned: boolean;
}

export interface DiffResult {
  nodeId: string;
  nodeType: string;
  filePath: string;
  changes: Change[];
}

export interface PushStats {
  pushed: number;
  skipped: number;
  conflicts: number;
  errors: string[];
}

export async function initHardcopy(root: string): Promise<void> {
  const dataDir = join(root, ".hardcopy");
  await mkdir(dataDir, { recursive: true });
  await mkdir(join(dataDir, "crdt"), { recursive: true });
  await mkdir(join(dataDir, "errors"), { recursive: true });

  const db = await Database.open(join(dataDir, "db.sqlite"));
  await db.close();

  const configPath = join(root, "hardcopy.yaml");
  try {
    await access(configPath);
  } catch {
    const defaultConfig = `# Hardcopy configuration
sources: []
views: []
`;
    await writeFile(configPath, defaultConfig);
  }
}
