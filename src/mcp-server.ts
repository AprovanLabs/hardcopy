#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";

import { Hardcopy } from "./hardcopy";

export function createMcpServer(root: string): Server {
  const server = new Server(
    { name: "hardcopy", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "sync",
        description: "Sync all configured remote sources to local database",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "status",
        description: "Show sync status including changed files and conflicts",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "refresh",
        description: "Refresh local files from database for a view pattern",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description:
                "View pattern to refresh (supports glob, e.g. docs/issues)",
            },
            clean: {
              type: "boolean",
              description: "Remove files that no longer match the view",
              default: false,
            },
            syncFirst: {
              type: "boolean",
              description: "Sync data from remote before refreshing",
              default: false,
            },
          },
          required: ["pattern"],
        },
      },
      {
        name: "diff",
        description:
          "Show local changes vs synced state for files matching pattern",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "File pattern to check (supports glob)",
            },
          },
        },
      },
      {
        name: "push",
        description: "Push local changes to remote sources",
        inputSchema: {
          type: "object",
          properties: {
            pattern: {
              type: "string",
              description: "File pattern to push (supports glob)",
            },
            force: {
              type: "boolean",
              description: "Push even if conflicts are detected",
              default: false,
            },
          },
        },
      },
      {
        name: "conflicts",
        description: "List all unresolved conflicts",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "resolve",
        description: "Resolve a specific conflict",
        inputSchema: {
          type: "object",
          properties: {
            nodeId: {
              type: "string",
              description: "The node ID of the conflict to resolve",
            },
            resolution: {
              type: "object",
              description:
                'Map of field names to resolution choice ("local" or "remote")',
              additionalProperties: {
                type: "string",
                enum: ["local", "remote"],
              },
            },
          },
          required: ["nodeId", "resolution"],
        },
      },
      {
        name: "streams",
        description: "List available event streams and their metadata",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "stream_query",
        description: "Query historical events from a stream",
        inputSchema: {
          type: "object",
          properties: {
            stream: { type: "string", description: "Stream name to query" },
            since: { type: "string", description: "Duration like '2h' or ISO timestamp" },
            types: { type: "array", items: { type: "string" }, description: "Filter by event types" },
            limit: { type: "number", default: 50, description: "Max events to return" },
          },
          required: ["stream"],
        },
      },
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    const hc = new Hardcopy({ root });

    try {
      await hc.initialize();
      await hc.loadConfig();

      switch (name) {
        case "sync":
          return await handleSync(hc);
        case "status":
          return await handleStatus(hc);
        case "refresh":
          return await handleRefresh(hc, args as unknown as RefreshArgs);
        case "diff":
          return await handleDiff(hc, args as unknown as DiffArgs);
        case "push":
          return await handlePush(hc, args as unknown as PushArgs);
        case "conflicts":
          return await handleConflicts(hc);
        case "resolve":
          return await handleResolve(hc, args as unknown as ResolveArgs);
        case "streams":
          return await handleStreams(hc);
        case "stream_query":
          return await handleStreamQuery(hc, args as unknown as StreamQueryArgs);
        default:
          throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
      }
    } catch (error) {
      if (error instanceof McpError) throw error;
      throw new McpError(
        ErrorCode.InternalError,
        `Failed to execute ${name}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await hc.close();
    }
  });

  return server;
}

interface RefreshArgs {
  pattern: string;
  clean?: boolean;
  syncFirst?: boolean;
}

interface DiffArgs {
  pattern?: string;
}

interface PushArgs {
  pattern?: string;
  force?: boolean;
}

interface ResolveArgs {
  nodeId: string;
  resolution: Record<string, "local" | "remote">;
}

interface StreamQueryArgs {
  stream: string;
  since?: string;
  types?: string[];
  limit?: number;
}

async function handleSync(hc: Hardcopy) {
  const stats = await hc.sync();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            synced: { nodes: stats.nodes, edges: stats.edges },
            errors: stats.errors,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleStatus(hc: Hardcopy) {
  const status = await hc.status();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            nodes: status.totalNodes,
            edges: status.totalEdges,
            byType: status.nodesByType,
            changedFiles: status.changedFiles.map((f) => ({
              path: f.path,
              status: f.status,
              nodeId: f.nodeId,
            })),
            conflicts: status.conflicts.map((c) => ({
              nodeId: c.nodeId,
              fields: c.fields.map((f) => f.field),
            })),
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleRefresh(hc: Hardcopy, args: RefreshArgs) {
  const { pattern, clean = false, syncFirst = false } = args;

  if (syncFirst) {
    await hc.sync();
  }

  const views = await hc.getViews();
  const matching = views.filter(
    (v) => v === pattern || v.startsWith(pattern) || pattern.includes("*"),
  );

  if (matching.length === 0) {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { error: `No views match pattern: ${pattern}`, available: views },
            null,
            2,
          ),
        },
      ],
    };
  }

  const results: Array<{
    view: string;
    rendered: number;
    orphaned: number;
    cleaned: boolean;
  }> = [];
  for (const view of matching) {
    const result = await hc.refreshView(view, { clean });
    results.push({
      view,
      rendered: result.rendered,
      orphaned: result.orphaned.length,
      cleaned: result.cleaned,
    });
  }

  return {
    content: [
      { type: "text" as const, text: JSON.stringify(results, null, 2) },
    ],
  };
}

async function handleDiff(hc: Hardcopy, args: DiffArgs) {
  const diffs = await hc.diff(args.pattern);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          diffs.map((d) => ({
            nodeId: d.nodeId,
            nodeType: d.nodeType,
            filePath: d.filePath,
            changes: d.changes.map((c) => ({
              field: c.field,
              old: truncate(c.oldValue),
              new: truncate(c.newValue),
            })),
          })),
          null,
          2,
        ),
      },
    ],
  };
}

async function handlePush(hc: Hardcopy, args: PushArgs) {
  const stats = await hc.push(args.pattern, { force: args.force });
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            pushed: stats.pushed,
            skipped: stats.skipped,
            conflicts: stats.conflicts,
            errors: stats.errors,
          },
          null,
          2,
        ),
      },
    ],
  };
}

async function handleConflicts(hc: Hardcopy) {
  const conflicts = await hc.listConflicts();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          conflicts.map((c) => ({
            nodeId: c.nodeId,
            nodeType: c.nodeType,
            filePath: c.filePath,
            fields: c.fields.map((f) => ({
              field: f.field,
              status: f.status,
              canAutoMerge: f.canAutoMerge,
            })),
          })),
          null,
          2,
        ),
      },
    ],
  };
}

async function handleResolve(hc: Hardcopy, args: ResolveArgs) {
  await hc.resolveConflict(args.nodeId, args.resolution);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ resolved: args.nodeId }, null, 2),
      },
    ],
  };
}

async function handleStreams(hc: Hardcopy) {
  const bus = hc.getEventBus();
  const streams = bus.getStreams();
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          streams.map((s) => ({
            name: s.name,
            provider: s.provider,
            description: s.description,
            retention: s.retention,
          })),
          null,
          2,
        ),
      },
    ],
  };
}

async function handleStreamQuery(hc: Hardcopy, args: StreamQueryArgs) {
  const bus = hc.getEventBus();
  const filter: import("./types").EventFilter = {};

  if (args.since) {
    const match = args.since.match(/^(\d+)(s|m|h|d)$/);
    if (match) {
      const value = parseInt(match[1]!, 10);
      const unit = match[2]!;
      const multipliers: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
      filter.since = Date.now() - value * multipliers[unit]!;
    } else {
      const ts = Date.parse(args.since);
      if (!isNaN(ts)) filter.since = ts;
    }
  }

  if (args.types) {
    filter.types = args.types;
  }

  const result = await bus.query(args.stream, filter, args.limit ?? 50);
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            events: result.events.map((e) => ({
              id: e.id,
              type: e.type,
              timestamp: new Date(e.timestamp).toISOString(),
              attrs: e.attrs,
              sourceId: e.sourceId,
            })),
            hasMore: result.hasMore,
            cursor: result.cursor,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function truncate(value: unknown, maxLen = 100): string {
  const str = typeof value === "string" ? value : JSON.stringify(value);
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

export async function serveMcp(root: string): Promise<void> {
  const server = createMcpServer(root);
  const transport = new StdioServerTransport();
  console.error("Hardcopy MCP Server running on stdio");
  await server.connect(transport);
}
