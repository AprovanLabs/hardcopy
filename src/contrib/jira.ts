import type { ProviderContrib, Provider, Tool } from "../provider";
import type { LinkExtractor, ExtractedLink, ExtractorContext } from "../graph/types";
import type { WebhookInferrer } from "../events/types";
import type { Node, Change, FetchRequest, FetchResult, PushResult } from "../types";

export const jiraLinkExtractor: LinkExtractor = {
  name: "jira",
  patterns: [
    /https:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z]+-\d+)/g,
    /\b([A-Z][A-Z0-9]+-\d+)\b/g,
  ],

  extract(content: string, context?: ExtractorContext): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const urlRegex = /https:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z]+-\d+)/g;
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      const [, key] = match;
      const targetUri = `jira:${key}`;
      if (!seen.has(targetUri)) {
        seen.add(targetUri);
        links.push({
          targetUri,
          linkType: "REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    const keyRegex = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
    while ((match = keyRegex.exec(content)) !== null) {
      const [, key] = match;
      const targetUri = `jira:${key}`;
      if (!seen.has(targetUri)) {
        seen.add(targetUri);
        links.push({
          targetUri,
          linkType: "MENTIONS",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    return links;
  },
};

export const jiraWebhookInferrer: WebhookInferrer = {
  provider: "jira",

  inferType(body: unknown, headers: Record<string, string>): string | null {
    const p = body as Record<string, unknown>;
    const eventType = p.webhookEvent as string | undefined;
    if (eventType) return `jira.${eventType}`;
    return null;
  },

  inferSubject(body: unknown): string | undefined {
    const p = body as Record<string, unknown>;
    const issue = p.issue as Record<string, unknown> | undefined;
    const key = issue?.key as string | undefined;
    return key ? `jira:${key}` : undefined;
  },
};

export interface JiraConfig {
  baseUrl: string;
  email?: string;
  apiToken?: string;
  projects?: string[];
}

export function createJiraProvider(config: JiraConfig): Provider {
  const email = config.email ?? process.env["JIRA_EMAIL"];
  const apiToken = config.apiToken ?? process.env["JIRA_API_TOKEN"];

  async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (email && apiToken) {
      const auth = Buffer.from(`${email}:${apiToken}`).toString("base64");
      headers.set("Authorization", `Basic ${auth}`);
    }
    headers.set("Accept", "application/json");
    headers.set("Content-Type", "application/json");
    return fetch(url, { ...options, headers });
  }

  function issueToNode(issue: JiraIssue): Node {
    return {
      id: `jira:${issue.key}`,
      type: "jira.Issue",
      attrs: {
        key: issue.key,
        summary: issue.fields.summary,
        description: issue.fields.description,
        status: issue.fields.status?.name,
        priority: issue.fields.priority?.name,
        assignee: issue.fields.assignee?.displayName,
        reporter: issue.fields.reporter?.displayName,
        created: issue.fields.created,
        updated: issue.fields.updated,
        labels: issue.fields.labels,
        issueType: issue.fields.issuetype?.name,
        url: `${config.baseUrl}/browse/${issue.key}`,
      },
    };
  }

  return {
    name: "jira",
    nodeTypes: ["jira.Issue", "jira.Project", "jira.User", "jira.Status", "jira.Priority"],
    edgeTypes: ["jira.ASSIGNED_TO", "jira.REPORTED_BY", "jira.BLOCKS", "jira.BELONGS_TO"],

    async fetch(request: FetchRequest): Promise<FetchResult> {
      const nodes: Node[] = [];
      const edges: { type: string; fromId: string; toId: string }[] = [];
      let cursor = request.cursor;
      let hasMore = false;

      const startAt = cursor ? parseInt(cursor, 10) : 0;
      const jql = config.projects?.length
        ? `project IN (${config.projects.join(",")}) ORDER BY updated DESC`
        : "ORDER BY updated DESC";

      const response = await fetchWithAuth(
        `${config.baseUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}&startAt=${startAt}&maxResults=50`,
      );

      if (!response.ok) {
        return { nodes, edges, cursor, hasMore, versionToken: null };
      }

      const data = (await response.json()) as JiraSearchResult;

      for (const issue of data.issues) {
        nodes.push(issueToNode(issue));

        if (issue.fields.assignee) {
          edges.push({
            type: "jira.ASSIGNED_TO",
            fromId: `jira:${issue.key}`,
            toId: `jira:user:${issue.fields.assignee.accountId}`,
          });
        }
      }

      hasMore = startAt + data.issues.length < data.total;
      if (hasMore) {
        cursor = String(startAt + data.issues.length);
      }

      return { nodes, edges, cursor, hasMore, versionToken: null };
    },

    async push(node: Node, changes: Change[]): Promise<PushResult> {
      if (node.type !== "jira.Issue") {
        return { success: false, error: "Only issues are pushable" };
      }

      const match = node.id.match(/^jira:(.+)$/);
      if (!match) {
        return { success: false, error: "Invalid node ID format" };
      }

      const [, key] = match;
      const fields: Record<string, unknown> = {};

      for (const change of changes) {
        if (change.field === "summary") fields.summary = change.newValue;
        if (change.field === "description") {
          fields.description = {
            type: "doc",
            version: 1,
            content: [{ type: "paragraph", content: [{ type: "text", text: change.newValue }] }],
          };
        }
      }

      const response = await fetchWithAuth(`${config.baseUrl}/rest/api/3/issue/${key}`, {
        method: "PUT",
        body: JSON.stringify({ fields }),
      });

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error };
      }

      return { success: true };
    },

    async fetchNode(nodeId: string): Promise<Node | null> {
      const match = nodeId.match(/^jira:([A-Z]+-\d+)$/);
      if (!match) return null;

      const [, key] = match;
      const response = await fetchWithAuth(`${config.baseUrl}/rest/api/3/issue/${key}`);

      if (response.status === 404) return null;
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
      }

      const issue = (await response.json()) as JiraIssue;
      return issueToNode(issue);
    },

    getTools(): Tool[] {
      return [
        { name: "jira.updateIssue", description: "Update issue summary, description" },
        { name: "jira.transitionIssue", description: "Move issue to a new status" },
        { name: "jira.addComment", description: "Add a comment to an issue" },
        { name: "jira.assignIssue", description: "Assign an issue to a user" },
      ];
    },
  };
}

interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | null;
    status: { name: string } | null;
    priority: { name: string } | null;
    assignee: { displayName: string; accountId: string } | null;
    reporter: { displayName: string } | null;
    created: string;
    updated: string;
    labels: string[];
    issuetype: { name: string } | null;
  };
}

interface JiraSearchResult {
  issues: JiraIssue[];
  total: number;
}

const jiraUriPatterns: Record<string, RegExp> = {
  issue: /^jira:([A-Z]+-\d+)$/,
  user: /^jira:user:([^/]+)$/,
  project: /^jira:project:([A-Z]+)$/,
};

function jiraUriComponentExtractor(uri: string): Record<string, string> | null {
  for (const [type, pattern] of Object.entries(jiraUriPatterns)) {
    const match = uri.match(pattern);
    if (match) {
      if (type === "issue") return { type: "issue", key: match[1] };
      if (type === "user") return { type: "user", accountId: match[1] };
      if (type === "project") return { type: "project", key: match[1] };
    }
  }
  return null;
}

export function getJiraContrib(): ProviderContrib {
  return {
    name: "jira",
    createProvider: () => createJiraProvider({ baseUrl: process.env["JIRA_BASE_URL"] ?? "" }),
    linkExtractors: [jiraLinkExtractor],
    webhookInferrers: [jiraWebhookInferrer],
    uriPatterns: { jira: jiraUriPatterns },
    uriComponentExtractors: { jira: jiraUriComponentExtractor },
  };
}
