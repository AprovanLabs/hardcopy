import { writeFile, mkdir, readdir, unlink, stat } from "fs/promises";
import { join, dirname, relative } from "path";
import yaml from "yaml";
import type { Entity, ViewDefinition, EntityGraph } from "./types";

export interface ViewRenderResult {
  path: string;
  entity: Entity;
  content: string;
}

export interface ViewRefreshResult {
  rendered: ViewRenderResult[];
  orphaned: string[];
  errors: string[];
}

export class ViewRenderer {
  private graph: EntityGraph;
  private outputRoot: string;
  private lastRefresh = new Map<string, number>();

  constructor(graph: EntityGraph, outputRoot: string) {
    this.graph = graph;
    this.outputRoot = outputRoot;
  }

  async render(view: ViewDefinition): Promise<ViewRefreshResult> {
    const entities = await this.graph.query(view.query);
    const rendered: ViewRenderResult[] = [];
    const errors: string[] = [];

    for (const entity of entities) {
      try {
        const filePath = this.resolvePath(view.path, entity);
        const content = this.formatContent(entity, view);
        const fullPath = join(this.outputRoot, filePath);

        await mkdir(dirname(fullPath), { recursive: true });
        await writeFile(fullPath, content, "utf-8");

        rendered.push({ path: filePath, entity, content });
      } catch (err) {
        errors.push(`Failed to render ${entity.uri}: ${err}`);
      }
    }

    const orphaned = await this.findOrphaned(view, rendered.map((r) => r.path));
    this.lastRefresh.set(view.name, Date.now());

    return { rendered, orphaned, errors };
  }

  async renderWithClean(view: ViewDefinition): Promise<ViewRefreshResult> {
    const result = await this.render(view);

    for (const orphanPath of result.orphaned) {
      try {
        const fullPath = join(this.outputRoot, orphanPath);
        await unlink(fullPath);
      } catch {}
    }

    return result;
  }

  shouldRefresh(view: ViewDefinition): boolean {
    if (!view.ttl) return true;
    const lastTime = this.lastRefresh.get(view.name);
    if (!lastTime) return true;
    return Date.now() - lastTime > view.ttl * 1000;
  }

  private resolvePath(pathTemplate: string, entity: Entity): string {
    return pathTemplate.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const parts = key.trim().split(".");
      let value: unknown = entity;
      
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }

      if (value === undefined || value === null) {
        return "unknown";
      }

      return String(value).replace(/[/\\?%*:|"<>]/g, "-");
    });
  }

  private formatContent(entity: Entity, view: ViewDefinition): string {
    if (view.template) {
      return this.applyTemplate(view.template, entity);
    }

    switch (view.format) {
      case "json":
        return JSON.stringify(entity.attrs, null, 2);
      case "yaml":
        return yaml.stringify(entity.attrs);
      case "markdown":
      default:
        return this.formatMarkdown(entity);
    }
  }

  private formatMarkdown(entity: Entity): string {
    const lines: string[] = [];
    const attrs = entity.attrs;

    if (attrs.title) {
      lines.push(`# ${attrs.title}\n`);
    } else {
      lines.push(`# ${entity.uri}\n`);
    }

    lines.push(`**Type:** ${entity.type}`);
    lines.push(`**URI:** ${entity.uri}`);
    if (entity.version) {
      lines.push(`**Version:** ${entity.version}`);
    }
    lines.push("");

    if (attrs.description || attrs.body) {
      lines.push("## Description\n");
      lines.push(String(attrs.description ?? attrs.body));
      lines.push("");
    }

    const skipFields = ["title", "description", "body", "content"];
    const otherFields = Object.entries(attrs).filter(
      ([key]) => !skipFields.includes(key) && !key.startsWith("__")
    );

    if (otherFields.length > 0) {
      lines.push("## Attributes\n");
      for (const [key, value] of otherFields) {
        const displayValue = typeof value === "object" 
          ? JSON.stringify(value, null, 2)
          : String(value);
        lines.push(`- **${key}:** ${displayValue}`);
      }
      lines.push("");
    }

    if (entity.links && entity.links.length > 0) {
      lines.push("## Links\n");
      for (const link of entity.links) {
        lines.push(`- [${link.type}] → ${link.targetUri}`);
      }
    }

    return lines.join("\n");
  }

  private applyTemplate(template: string, entity: Entity): string {
    return template.replace(/\{\{([^}]+)\}\}/g, (_, key) => {
      const parts = key.trim().split(".");
      let value: unknown = { ...entity, ...entity.attrs };
      
      for (const part of parts) {
        if (value && typeof value === "object") {
          value = (value as Record<string, unknown>)[part];
        } else {
          value = undefined;
          break;
        }
      }

      if (value === undefined || value === null) {
        return "";
      }

      return String(value);
    });
  }

  private async findOrphaned(view: ViewDefinition, renderedPaths: string[]): Promise<string[]> {
    const orphaned: string[] = [];
    const viewDir = this.getViewDir(view.path);
    
    if (!viewDir) return orphaned;

    const fullViewDir = join(this.outputRoot, viewDir);
    
    try {
      const existing = await this.walkDir(fullViewDir);
      const renderedSet = new Set(renderedPaths.map((p) => join(this.outputRoot, p)));
      
      for (const file of existing) {
        if (!renderedSet.has(file)) {
          orphaned.push(relative(this.outputRoot, file));
        }
      }
    } catch {}

    return orphaned;
  }

  private getViewDir(pathTemplate: string): string | null {
    const firstVar = pathTemplate.indexOf("{{");
    if (firstVar === -1) return dirname(pathTemplate);
    return pathTemplate.slice(0, firstVar).replace(/\/[^/]*$/, "") || null;
  }

  private async walkDir(dir: string): Promise<string[]> {
    const files: string[] = [];
    
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          files.push(...(await this.walkDir(fullPath)));
        } else if (entry.isFile()) {
          files.push(fullPath);
        }
      }
    } catch {}

    return files;
  }
}

export async function refreshView(
  graph: EntityGraph,
  outputRoot: string,
  view: ViewDefinition,
  clean: boolean = false
): Promise<ViewRefreshResult> {
  const renderer = new ViewRenderer(graph, outputRoot);
  return clean ? renderer.renderWithClean(view) : renderer.render(view);
}
