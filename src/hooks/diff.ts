import type { Node, Change } from "../types";

export interface NodeChange {
  node: Node;
  prior: Node | null;
  type: "created" | "updated";
  changes: Change[];
}

export function diffNode(prior: Node | null, incoming: Node): NodeChange | null {
  if (!prior) {
    return { node: incoming, prior: null, type: "created", changes: [] };
  }

  const changes: Change[] = [];
  const keys = new Set([...Object.keys(prior.attrs), ...Object.keys(incoming.attrs)]);

  for (const key of keys) {
    const oldValue = prior.attrs[key];
    const newValue = incoming.attrs[key];
    if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
      changes.push({ field: key, oldValue, newValue });
    }
  }

  if (changes.length === 0) return null;
  return { node: incoming, prior, type: "updated", changes };
}

export function diffNodes(priorMap: Map<string, Node>, incoming: Node[]): NodeChange[] {
  const changes: NodeChange[] = [];
  for (const node of incoming) {
    const change = diffNode(priorMap.get(node.id) ?? null, node);
    if (change) changes.push(change);
  }
  return changes;
}
