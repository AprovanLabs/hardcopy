import type { Entity } from "../provider";
import type { Change } from "../types";
import { mergeText } from "../merge";
import { stringify as yamlStringify, parse as yamlParse } from "yaml";

export type MergeStrategy = "local-wins" | "remote-wins" | "manual" | "field-level";
export type ViewFormat = "markdown" | "yaml" | "json";

export interface SyncEngine {
  diff(local: Entity, remote: Entity): Change[];
  merge(local: Entity, remote: Entity, strategy: MergeStrategy): Promise<Entity>;
  renderView(entity: Entity, format: ViewFormat): string;
  parseView(content: string, format: ViewFormat): Partial<Entity>;
}

export function diff(local: Entity, remote: Entity): Change[] {
  const changes: Change[] = [];
  const localAttrs = local.attrs;
  const remoteAttrs = remote.attrs;

  const allKeys = new Set([...Object.keys(localAttrs), ...Object.keys(remoteAttrs)]);

  for (const key of allKeys) {
    const localVal = localAttrs[key];
    const remoteVal = remoteAttrs[key];

    if (!valuesEqual(localVal, remoteVal)) {
      changes.push({
        field: key,
        oldValue: localVal,
        newValue: remoteVal,
      });
    }
  }

  return changes;
}

export async function merge(
  local: Entity,
  remote: Entity,
  strategy: MergeStrategy,
  base?: Entity,
): Promise<Entity> {
  switch (strategy) {
    case "local-wins":
      return { ...remote, attrs: { ...remote.attrs, ...local.attrs } };

    case "remote-wins":
      return { ...local, attrs: { ...local.attrs, ...remote.attrs } };

    case "manual":
      throw new Error("Manual merge requires user intervention");

    case "field-level":
      return fieldLevelMerge(local, remote, base);

    default:
      return remote;
  }
}

async function fieldLevelMerge(
  local: Entity,
  remote: Entity,
  base?: Entity,
): Promise<Entity> {
  const merged: Record<string, unknown> = {};
  const localAttrs = local.attrs;
  const remoteAttrs = remote.attrs;
  const baseAttrs = base?.attrs ?? {};

  const allKeys = new Set([
    ...Object.keys(localAttrs),
    ...Object.keys(remoteAttrs),
    ...Object.keys(baseAttrs),
  ]);

  for (const key of allKeys) {
    const localVal = localAttrs[key];
    const remoteVal = remoteAttrs[key];
    const baseVal = baseAttrs[key];

    if (valuesEqual(localVal, remoteVal)) {
      merged[key] = localVal;
    } else if (valuesEqual(localVal, baseVal)) {
      merged[key] = remoteVal;
    } else if (valuesEqual(remoteVal, baseVal)) {
      merged[key] = localVal;
    } else if (typeof localVal === "string" && typeof remoteVal === "string") {
      const baseStr = typeof baseVal === "string" ? baseVal : "";
      const mergedText = await mergeText(baseStr, localVal, remoteVal, {
        filePath: `${local.uri}/${key}`,
      });
      merged[key] = mergedText ?? localVal;
    } else {
      merged[key] = localVal;
    }
  }

  return {
    ...local,
    attrs: merged,
    etag: remote.etag,
    syncedAt: Date.now(),
  };
}

export function renderView(entity: Entity, format: ViewFormat): string {
  switch (format) {
    case "json":
      return JSON.stringify(
        { uri: entity.uri, type: entity.type, ...entity.attrs },
        null,
        2,
      );

    case "yaml":
      return yamlStringify({
        uri: entity.uri,
        type: entity.type,
        ...entity.attrs,
      });

    case "markdown":
      return renderMarkdown(entity);

    default:
      return JSON.stringify(entity);
  }
}

function renderMarkdown(entity: Entity): string {
  const lines: string[] = [];
  const { uri, type, attrs } = entity;

  lines.push("---");
  lines.push(`_id: ${uri}`);
  lines.push(`_type: ${type}`);

  for (const [key, value] of Object.entries(attrs)) {
    if (key === "body") continue;
    if (value === undefined || value === null) continue;
    
    if (typeof value === "string" && value.includes("\n")) {
      lines.push(`${key}: |`);
      for (const line of value.split("\n")) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    }
  }

  lines.push("---");

  if (typeof attrs["body"] === "string") {
    lines.push("");
    lines.push(attrs["body"]);
  }

  return lines.join("\n");
}

export function parseView(content: string, format: ViewFormat): Partial<Entity> {
  switch (format) {
    case "json":
      return parseJsonView(content);

    case "yaml":
      return parseYamlView(content);

    case "markdown":
      return parseMarkdownView(content);

    default:
      return {};
  }
}

function parseJsonView(content: string): Partial<Entity> {
  try {
    const parsed = JSON.parse(content);
    const { uri, type, ...attrs } = parsed;
    return { uri, type, attrs };
  } catch {
    return {};
  }
}

function parseYamlView(content: string): Partial<Entity> {
  try {
    const parsed = yamlParse(content);
    const { uri, type, ...attrs } = parsed;
    return { uri, type, attrs };
  } catch {
    return {};
  }
}

function parseMarkdownView(content: string): Partial<Entity> {
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!frontmatterMatch) {
    return { attrs: { body: content.trim() } };
  }

  const [, frontmatter, body] = frontmatterMatch;

  try {
    const parsed = yamlParse(frontmatter!) as Record<string, unknown>;
    const uri = parsed["_id"] as string | undefined;
    const type = parsed["_type"] as string | undefined;

    const attrs: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (key !== "_id" && key !== "_type") {
        attrs[key] = value;
      }
    }

    if (body?.trim()) {
      attrs["body"] = body.trim();
    }

    return { uri, type, attrs };
  } catch {
    return { attrs: { body: content.trim() } };
  }
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => valuesEqual(v, b[i]));
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export const syncEngine: SyncEngine = {
  diff,
  merge,
  renderView,
  parseView,
};
