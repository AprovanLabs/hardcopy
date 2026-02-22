import type { Provider, Tool } from "../../provider";
import type {
  Node,
  Edge,
  Change,
  FetchRequest,
  FetchResult,
  PushResult,
} from "../../types";
import { registerProvider } from "../../provider";

export interface A2AConfig {
  endpoint?: string;
  links?: {
    edge: string;
    to: string;
    match: string;
  }[];
}

export function createA2AProvider(config: A2AConfig): Provider {
  return {
    name: "a2a",
    nodeTypes: ["a2a.Task", "a2a.Session", "a2a.Agent"],
    edgeTypes: ["a2a.TRACKS", "a2a.CREATED_BY", "a2a.PART_OF"],

    async fetch(request: FetchRequest): Promise<FetchResult> {
      const nodes: Node[] = [];
      const edges: Edge[] = [];

      if (!config.endpoint) {
        return { nodes, edges, hasMore: false };
      }

      try {
        const response = await fetch(`${config.endpoint}/tasks`, {
          headers: { Accept: "application/json" },
        });

        if (!response.ok) {
          return { nodes, edges, hasMore: false };
        }

        const tasks = (await response.json()) as A2ATask[];

        for (const task of tasks) {
          const nodeId = `a2a:${task.id}`;
          nodes.push({
            id: nodeId,
            type: "a2a.Task",
            attrs: {
              name: task.name,
              status: task.status,
              description: task.description,
              created_at: task.created_at,
              updated_at: task.updated_at,
              meta: task.meta,
            },
          });

          if (
            task.meta?.github?.issue_number &&
            task.meta?.github?.repository
          ) {
            edges.push({
              type: "a2a.TRACKS",
              fromId: nodeId,
              toId: `github:${task.meta.github.repository}#${task.meta.github.issue_number}`,
            });
          }

          if (task.agent_id) {
            edges.push({
              type: "a2a.CREATED_BY",
              fromId: nodeId,
              toId: `a2a:agent:${task.agent_id}`,
            });
          }

          if (task.session_id) {
            edges.push({
              type: "a2a.PART_OF",
              fromId: nodeId,
              toId: `a2a:session:${task.session_id}`,
            });
          }
        }
      } catch {
        // A2A endpoint not available
      }

      return { nodes, edges, hasMore: false };
    },

    async push(node: Node, changes: Change[]): Promise<PushResult> {
      if (!config.endpoint) {
        return { success: false, error: "No A2A endpoint configured" };
      }

      const match = node.id.match(/^a2a:(.+)$/);
      if (!match) {
        return { success: false, error: "Invalid A2A node ID" };
      }

      const taskId = match[1];
      const body: Record<string, unknown> = {};

      for (const change of changes) {
        body[change.field] = change.newValue;
      }

      try {
        const response = await fetch(`${config.endpoint}/tasks/${taskId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        });

        if (!response.ok) {
          return { success: false, error: await response.text() };
        }

        return { success: true };
      } catch (err) {
        return { success: false, error: String(err) };
      }
    },

    async fetchNode(_nodeId: string): Promise<Node | null> {
      return null;
    },

    getTools(): Tool[] {
      return [
        { name: "a2a.createTask", description: "Create a new agent task" },
        {
          name: "a2a.updateTask",
          description: "Update task status or metadata",
        },
        { name: "a2a.linkIssue", description: "Link task to GitHub issue" },
      ];
    },
  };
}

interface A2ATask {
  id: string;
  name: string;
  status: string;
  description?: string;
  created_at: string;
  updated_at: string;
  agent_id?: string;
  session_id?: string;
  meta?: {
    github?: {
      issue_number: number;
      repository: string;
    };
    [key: string]: unknown;
  };
}

registerProvider("a2a", (config) => createA2AProvider(config as A2AConfig));

export { createA2AProvider as default };
