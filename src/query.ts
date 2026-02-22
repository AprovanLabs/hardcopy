import type { Node } from "./types";

export interface ParsedQuery {
  nodeType?: string;
  conditions: Condition[];
}

export interface Condition {
  path: string;
  operator: "=" | "!=" | "contains" | "in";
  value: unknown;
}

export function parseQuery(query: string): ParsedQuery {
  const result: ParsedQuery = { conditions: [] };

  // Extract node type from MATCH clause: MATCH (x:github.Issue)
  const matchRegex = /MATCH\s*\(\w+:(\S+)\)/i;
  const matchResult = matchRegex.exec(query);
  if (matchResult?.[1]) {
    result.nodeType = matchResult[1];
  }

  // Extract WHERE conditions: WHERE x.attrs->>'state' = 'open'
  const whereRegex = /WHERE\s+(.+?)(?:RETURN|$)/is;
  const whereResult = whereRegex.exec(query);
  if (whereResult?.[1]) {
    const whereClause = whereResult[1].trim();
    result.conditions = parseConditions(whereClause);
  }

  return result;
}

function parseConditions(whereClause: string): Condition[] {
  const conditions: Condition[] = [];

  // Handle basic equality: x.attrs->>'field' = 'value' or attrs.field = 'value'
  const eqRegex = /(\w+(?:\.\w+)*(?:->>'\w+')?)\s*=\s*'([^']+)'/g;
  let match;
  while ((match = eqRegex.exec(whereClause)) !== null) {
    const pathMatch = match[1];
    const valueMatch = match[2];
    if (pathMatch && valueMatch) {
      conditions.push({
        path: normalizeJsonPath(pathMatch),
        operator: "=",
        value: valueMatch,
      });
    }
  }

  // Handle inequality: field != 'value'
  const neqRegex = /(\w+(?:\.\w+)*(?:->>'\w+')?)\s*!=\s*'([^']+)'/g;
  while ((match = neqRegex.exec(whereClause)) !== null) {
    const pathMatch = match[1];
    const valueMatch = match[2];
    if (pathMatch && valueMatch) {
      conditions.push({
        path: normalizeJsonPath(pathMatch),
        operator: "!=",
        value: valueMatch,
      });
    }
  }

  return conditions;
}

function normalizeJsonPath(path: string): string {
  // Convert SQLite JSON path like attrs->>'state' to attrs.state
  return path.replace(/->>'(\w+)'/g, ".$1").replace(/\w+\.attrs\./, "attrs.");
}

export function filterNodes(nodes: Node[], query: ParsedQuery): Node[] {
  return nodes.filter((node) => {
    // Type filter
    if (query.nodeType && node.type !== query.nodeType) {
      return false;
    }

    // Condition filters
    for (const condition of query.conditions) {
      const nodeData = { ...node, attrs: node.attrs } as Record<
        string,
        unknown
      >;
      const value = getNestedValue(nodeData, condition.path);
      if (!matchCondition(value, condition)) {
        return false;
      }
    }

    return true;
  });
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

function matchCondition(value: unknown, condition: Condition): boolean {
  switch (condition.operator) {
    case "=":
      return value === condition.value;
    case "!=":
      return value !== condition.value;
    case "contains":
      if (Array.isArray(value)) {
        return value.includes(condition.value);
      }
      if (typeof value === "string") {
        return value.includes(String(condition.value));
      }
      return false;
    case "in":
      if (Array.isArray(condition.value)) {
        return condition.value.includes(value as string);
      }
      return false;
    default:
      return true;
  }
}
