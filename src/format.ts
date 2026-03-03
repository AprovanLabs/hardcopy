import type { Node } from "./types";
import matter from "gray-matter";

export interface ParsedFile {
  attrs: Record<string, unknown>;
  body: string;
}

export interface FormatHandler {
  type: string;
  editableFields: string[];
  render(node: Node): string;
  parse(content: string): ParsedFile;
}

const handlers = new Map<string, FormatHandler>();

export function registerFormat(handler: FormatHandler): void {
  handlers.set(handler.type, handler);
}

export function getFormat(type: string): FormatHandler | undefined {
  return handlers.get(type);
}

export function listFormats(): string[] {
  return Array.from(handlers.keys());
}

export function renderNode(node: Node, template?: string): string {
  if (template) {
    return renderTemplate(template, node);
  }
  const handler = handlers.get(node.type);
  if (!handler) {
    throw new Error(`No format handler for type: ${node.type}`);
  }
  return handler.render(node);
}

export function parseFile(content: string, type: string): ParsedFile {
  const handler = handlers.get(type);
  if (!handler) {
    return parseGeneric(content);
  }
  return handler.parse(content);
}

function parseGeneric(content: string): ParsedFile {
  const { data, content: body } = matter(content);
  return { attrs: data, body: body.trim() };
}

function renderTemplate(template: string, node: Node): string {
  return template.replace(/\{\{([^}]+)\}\}/g, (_, path: string) => {
    const value = resolvePath(
      node as unknown as Record<string, unknown>,
      path.trim(),
    );
    return value?.toString() ?? "";
  });
}

function resolvePath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
