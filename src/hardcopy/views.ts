import { join } from "path";
import { mkdir, writeFile, readFile, rm, readdir, stat } from "fs/promises";
import { setDocContent, setDocAttrs, getDocContent } from "../crdt";
import { renderNode, parseFile } from "../format";
import type { ViewConfig } from "../config";
import type { Node, IndexState } from "../types";
import type { Hardcopy } from "./core";
import type { RefreshResult } from "./types";

export async function getViews(this: Hardcopy): Promise<string[]> {
  const config = await this.loadConfig();
  return config.views.map((v) => v.path);
}

export async function refreshView(
  this: Hardcopy,
  viewPath: string,
  options: { clean?: boolean } = {},
): Promise<RefreshResult> {
  const config = await this.loadConfig();
  const view = config.views.find((v) => v.path === viewPath);
  if (!view) throw new Error(`View not found: ${viewPath}`);

  const viewDir = join(this.root, view.path);
  await mkdir(viewDir, { recursive: true });

  const db = this.getDatabase();

  const params: Record<string, unknown> = {};
  const me = process.env["HARDCOPY_ME"] ?? process.env["GITHUB_USER"];
  if (me) params["me"] = me;

  const nodes = await db.queryViewNodes(
    view.query,
    Object.keys(params).length ? params : undefined,
  );

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

  const expectedFiles = new Set<string>();

  for (const node of nodes) {
    const renderedPaths = await renderNodeToFile.call(this, node, view, viewDir);
    for (const p of renderedPaths) {
      expectedFiles.add(p);
    }
  }

  const existingFiles = await listViewFiles(viewDir);
  const orphanedFiles = existingFiles.filter((f) => !expectedFiles.has(f));

  if (options.clean && orphanedFiles.length > 0) {
    await cleanupOrphanedFiles.call(this, viewDir, orphanedFiles);
  }

  return {
    rendered: expectedFiles.size,
    orphaned: orphanedFiles,
    cleaned: options.clean ?? false,
  };
}

async function renderNodeToFile(
  this: Hardcopy,
  node: Node,
  view: ViewConfig,
  viewDir: string,
): Promise<string[]> {
  const renderedPaths: string[] = [];
  const crdt = this.getCRDTStore();
  const db = this.getDatabase();

  for (const renderConfig of view.render) {
    const filePath = resolveRenderPath(renderConfig.path, node);
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

    const doc = await crdt.loadOrCreate(node.id);
    const body = (node.attrs["body"] as string) ?? "";
    setDocContent(doc, body);
    setDocAttrs(doc, node.attrs as Record<string, unknown>);
    await crdt.save(node.id, doc);

    await writeFile(fullPath, content);

    const fileStat = await stat(fullPath);
    await db.upsertNode({ ...node, syncedAt: fileStat.mtimeMs });

    renderedPaths.push(filePath);
  }

  return renderedPaths;
}

function resolveRenderPath(template: string, node: Node): string {
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

export async function listViewFiles(viewDir: string): Promise<string[]> {
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

async function cleanupOrphanedFiles(
  this: Hardcopy,
  viewDir: string,
  orphanedFiles: string[],
): Promise<void> {
  for (const relPath of orphanedFiles) {
    const fullPath = join(viewDir, relPath);
    await syncFileBeforeDelete.call(this, fullPath);

    try {
      await rm(fullPath);
      console.log(`Deleted orphaned file: ${relPath}`);
    } catch (err) {
      console.error(`Failed to delete ${relPath}: ${err}`);
    }
  }
}

async function syncFileBeforeDelete(
  this: Hardcopy,
  fullPath: string,
): Promise<void> {
  try {
    const content = await readFile(fullPath, "utf-8");
    const parsed = parseFile(content, "generic");
    const nodeId = (parsed.attrs._id ?? parsed.attrs.id) as string | undefined;

    if (!nodeId) return;

    const crdt = this.getCRDTStore();
    const doc = await crdt.load(nodeId);

    if (!doc) return;

    const crdtContent = getDocContent(doc);
    if (parsed.body !== crdtContent) {
      console.warn(
        `Warning: File for ${nodeId} has local changes that may be lost. ` +
          `Run 'hardcopy push' first to preserve changes.`,
      );
    }

    await crdt.delete(nodeId);
  } catch {
    // File might not be parseable, skip sync
  }
}
