import { mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { join } from "path";
import matter from "gray-matter";
import type { ConflictInfo, FieldConflict } from "./types";
import { generateConflictMarkers } from "./conflict";

export class ConflictStore {
  private conflictsDir: string;

  constructor(conflictsDir: string) {
    this.conflictsDir = conflictsDir;
  }

  async save(info: ConflictInfo): Promise<void> {
    await mkdir(this.conflictsDir, { recursive: true });
    const filePath = this.getPath(info.nodeId);
    const body = formatConflictBody(info.fields);
    const frontmatter = {
      nodeId: info.nodeId,
      nodeType: info.nodeType,
      filePath: info.filePath,
      viewRelPath: info.viewRelPath,
      detectedAt: new Date(info.detectedAt).toISOString(),
      fields: info.fields.map((field) => ({
        field: field.field,
        status: field.status,
        canAutoMerge: field.canAutoMerge,
      })),
    };

    await writeFile(filePath, matter.stringify(body, frontmatter));
  }

  async list(): Promise<ConflictInfo[]> {
    const entries = await readdir(this.conflictsDir).catch(() => []);
    const conflicts: ConflictInfo[] = [];

    for (const entry of entries) {
      if (!entry.endsWith(".md")) continue;
      const fullPath = join(this.conflictsDir, entry);
      try {
        const content = await readFile(fullPath, "utf-8");
        const parsed = matter(content);
        const data = parsed.data as Record<string, unknown>;
        const fields = parseStoredFields(data["fields"]);
        const detectedAt = Date.parse(String(data["detectedAt"] ?? ""));

        conflicts.push({
          nodeId: String(data["nodeId"] ?? ""),
          nodeType: String(data["nodeType"] ?? ""),
          filePath: String(data["filePath"] ?? ""),
          viewRelPath: String(data["viewRelPath"] ?? ""),
          detectedAt: Number.isNaN(detectedAt) ? 0 : detectedAt,
          fields,
        });
      } catch {
        continue;
      }
    }

    return conflicts.filter((conflict) => conflict.nodeId.length > 0);
  }

  async get(nodeId: string): Promise<ConflictInfo | null> {
    const result = await this.read(nodeId);
    return result?.info ?? null;
  }

  async read(
    nodeId: string,
  ): Promise<{ info: ConflictInfo; body: string } | null> {
    const filePath = this.getPath(nodeId);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed = matter(content);
      const data = parsed.data as Record<string, unknown>;
      const fields = parseStoredFields(data["fields"]);
      const detectedAt = Date.parse(String(data["detectedAt"] ?? ""));

      const info = {
        nodeId: String(data["nodeId"] ?? nodeId),
        nodeType: String(data["nodeType"] ?? ""),
        filePath: String(data["filePath"] ?? ""),
        detectedAt: Number.isNaN(detectedAt) ? 0 : detectedAt,
        fields,
      };

      return { info, body: parsed.content };
    } catch {
      return null;
    }
  }

  async remove(nodeId: string): Promise<void> {
    const filePath = this.getPath(nodeId);
    try {
      await rm(filePath, { force: true });
    } catch {
      return;
    }
  }

  private getPath(nodeId: string): string {
    return join(this.conflictsDir, `${encodeURIComponent(nodeId)}.md`);
  }

  getArtifactPath(nodeId: string): string {
    return this.getPath(nodeId);
  }
}

function parseStoredFields(value: unknown): FieldConflict[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item): FieldConflict | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const field = String(record["field"] ?? "");
      if (!field) return null;
      return {
        field,
        status: String(record["status"] ?? "clean") as FieldConflict["status"],
        canAutoMerge: Boolean(record["canAutoMerge"]),
        base: null,
        local: null,
        remote: null,
      };
    })
    .filter((item): item is FieldConflict => item !== null);
}

function formatConflictBody(fields: FieldConflict[]): string {
  const blocks = fields
    .filter((field) => field.status === "diverged")
    .map((field) => `## ${field.field}\n${generateConflictMarkers(field)}`);

  return blocks.join("\n\n");
}
