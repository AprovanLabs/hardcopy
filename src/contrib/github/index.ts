import type { Provider, Tool, ProviderContrib } from "../../provider";
import type {
  Node,
  Edge,
  Change,
  FetchRequest,
  FetchResult,
  PushResult,
} from "../../types";
import type { LinkExtractor, ExtractedLink, ExtractorContext } from "../../graph/types";
import type { FormatHandler, ParsedFile } from "../../format";
import type { WebhookInferrer } from "../../events/types";
import matter from "gray-matter";

export interface GitHubConfig {
  orgs?: string[];
  repos?: string[];
  token?: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels: { name: string }[];
  assignee: { login: string } | null;
  milestone: { title: string } | null;
  created_at: string;
  updated_at: string;
  html_url: string;
  pull_request?: unknown;
}

export function createGitHubProvider(config: GitHubConfig): Provider {
  const token = config.token ?? process.env["GITHUB_TOKEN"];

  async function fetchWithAuth(
    url: string,
    options: RequestInit = {},
  ): Promise<Response> {
    const headers = new Headers(options.headers);
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }
    headers.set("Accept", "application/vnd.github.v3+json");
    return fetch(url, { ...options, headers });
  }

  function issueToNode(owner: string, name: string, issue: GitHubIssue): Node {
    const nodeId = `github:${owner}/${name}#${issue.number}`;
    return {
      id: nodeId,
      type: "github.Issue",
      attrs: {
        number: issue.number,
        title: issue.title,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map((l) => l.name),
        assignee: issue.assignee?.login,
        milestone: issue.milestone?.title,
        created_at: issue.created_at,
        updated_at: issue.updated_at,
        url: issue.html_url,
        repository: `${owner}/${name}`,
      },
    };
  }

  return {
    name: "github",
    nodeTypes: [
      "github.Issue",
      "github.Label",
      "github.User",
      "github.Milestone",
      "github.Repository",
    ],
    edgeTypes: [
      "github.ASSIGNED_TO",
      "github.HAS_LABEL",
      "github.REFERENCES",
      "github.BELONGS_TO",
    ],

    async fetch(request: FetchRequest): Promise<FetchResult> {
      const nodes: Node[] = [];
      const edges: Edge[] = [];
      let cursor = request.cursor;
      let hasMore = false;

      const repos = config.repos ?? [];

      if (config.orgs) {
        for (const org of config.orgs) {
          const response = await fetchWithAuth(
            `https://api.github.com/orgs/${org}/repos`,
          );
          if (response.ok) {
            const data = (await response.json()) as { full_name: string }[];
            repos.push(...data.map((r) => r.full_name));
          }
        }
      }

      for (const repo of repos) {
        const [owner, name] = repo.split("/");
        if (!owner || !name) continue;
        const issuesUrl = `https://api.github.com/repos/${owner}/${name}/issues?state=all&per_page=100${
          cursor ? `&page=${cursor}` : ""
        }`;

        const response = await fetchWithAuth(issuesUrl);
        if (!response.ok) continue;

        const data = (await response.json()) as GitHubIssue[];

        for (const issue of data) {
          if (issue.pull_request) continue;

          const node = issueToNode(owner, name, issue);
          nodes.push(node);

          if (issue.assignee) {
            edges.push({
              type: "github.ASSIGNED_TO",
              fromId: node.id,
              toId: `github:user:${issue.assignee.login}`,
            });
          }

          for (const label of issue.labels) {
            edges.push({
              type: "github.HAS_LABEL",
              fromId: node.id,
              toId: `github:label:${owner}/${name}:${label.name}`,
            });
          }
        }

        const linkHeader = response.headers.get("Link");
        if (linkHeader?.includes('rel="next"')) {
          hasMore = true;
          const match = linkHeader.match(/page=(\d+)>; rel="next"/);
          if (match) cursor = match[1];
        }
      }

      return { nodes, edges, cursor, hasMore, versionToken: null };
    },

    async push(node: Node, changes: Change[]): Promise<PushResult> {
      if (node.type !== "github.Issue") {
        return { success: false, error: "Only issues are pushable" };
      }

      const match = node.id.match(/^github:([^#]+)#(\d+)$/);
      if (!match) {
        return { success: false, error: "Invalid node ID format" };
      }

      const [, repo, number] = match;
      const body: Record<string, unknown> = {};

      for (const change of changes) {
        if (change.field === "title") body.title = change.newValue;
        if (change.field === "body") body.body = change.newValue;
        if (change.field === "state") body.state = change.newValue;
        if (change.field === "labels") body.labels = change.newValue;
        if (change.field === "assignee") body.assignees = [change.newValue];
        if (change.field === "milestone") body.milestone = change.newValue;
      }

      const response = await fetchWithAuth(
        `https://api.github.com/repos/${repo}/issues/${number}`,
        {
          method: "PATCH",
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
        },
      );

      if (!response.ok) {
        const error = await response.text();
        return { success: false, error };
      }

      return { success: true };
    },

    async fetchNode(nodeId: string): Promise<Node | null> {
      const match = nodeId.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
      if (!match) return null;

      const [, owner, repo, number] = match;
      if (!owner || !repo || !number) return null;
      const response = await fetchWithAuth(
        `https://api.github.com/repos/${owner}/${repo}/issues/${number}`,
      );

      if (response.status === 404) return null;
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
      }

      const issue = (await response.json()) as GitHubIssue;
      if (issue.pull_request) return null;
      return issueToNode(owner, repo, issue);
    },

    getTools(): Tool[] {
      return [
        {
          name: "github.updateIssue",
          description: "Update issue title, body, state",
        },
        { name: "github.addLabels", description: "Add labels to an issue" },
        {
          name: "github.removeLabels",
          description: "Remove labels from an issue",
        },
        { name: "github.assignIssue", description: "Assign users to an issue" },
        {
          name: "github.createComment",
          description: "Create a comment on an issue",
        },
      ];
    },
  };
}

export const githubLinkExtractor: LinkExtractor = {
  name: "github",
  patterns: [
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/g,
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g,
    /https:\/\/github\.com\/([^/]+)\/([^/]+)(?:\/tree\/[^/]+)?\/([^?\s]+)/g,
    /#(\d+)(?:\s|$|[.,;:!?\-)])/g,
  ],
  extract(content: string, context?: ExtractorContext): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const issueUrlRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/g;
    let match;
    while ((match = issueUrlRegex.exec(content)) !== null) {
      const uri = `github:${match[1]}/${match[2]}#${match[3]}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "github.REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    const prUrlRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g;
    while ((match = prUrlRegex.exec(content)) !== null) {
      const uri = `github:${match[1]}/${match[2]}#${match[3]}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "github.REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (context?.sourceUri?.startsWith("github:")) {
      const sourceMatch = context.sourceUri.match(/^github:([^/]+)\/([^#]+)/);
      if (sourceMatch) {
        const [, owner, repo] = sourceMatch;
        const shortRefRegex = /#(\d+)(?=[\s.,;:!?\-)]|$)/g;
        while ((match = shortRefRegex.exec(content)) !== null) {
          const uri = `github:${owner}/${repo}#${match[1]}`;
          if (!seen.has(uri) && uri !== context.sourceUri) {
            seen.add(uri);
            links.push({
              targetUri: uri,
              linkType: "github.REFERENCES",
              position: { start: match.index, end: match.index + match[0].length },
            });
          }
        }
      }
    }

    return links;
  },
};

export const githubIssueFormat: FormatHandler = {
  type: "github.Issue",
  editableFields: ["title", "body", "labels", "assignee", "milestone", "state"],

  render(node: Node): string {
    const attrs = node.attrs as Record<string, unknown>;
    const frontmatter: Record<string, unknown> = {
      _type: "github.Issue",
      _id: node.id,
    };

    const addIfDefined = (key: string, value: unknown) => {
      if (value !== undefined && value !== null) {
        frontmatter[key] = value;
      }
    };

    addIfDefined("number", attrs["number"]);
    addIfDefined("title", attrs["title"]);
    addIfDefined("state", attrs["state"]);
    addIfDefined("url", attrs["url"]);
    addIfDefined("labels", attrs["labels"]);
    addIfDefined("assignee", attrs["assignee"]);
    addIfDefined("milestone", attrs["milestone"]);
    addIfDefined("created_at", attrs["created_at"]);
    addIfDefined("updated_at", attrs["updated_at"]);

    if (attrs["syncedAt"]) {
      frontmatter["_synced"] = new Date(attrs["syncedAt"] as number).toISOString();
    }

    const body = (attrs["body"] as string) ?? "";
    return matter.stringify(body, frontmatter);
  },

  parse(content: string): ParsedFile {
    const { data, content: body } = matter(content);
    const attrs: Record<string, unknown> = {};

    if (data["title"]) attrs["title"] = data["title"];
    if (data["state"]) attrs["state"] = data["state"];
    if (data["labels"]) attrs["labels"] = data["labels"];
    if (data["assignee"]) attrs["assignee"] = data["assignee"];
    if (data["milestone"]) attrs["milestone"] = data["milestone"];

    return {
      attrs,
      body: body.trim(),
    };
  },
};

export const githubWebhookInferrer: WebhookInferrer = {
  provider: "github",
  inferType(body: unknown, headers: Record<string, string>): string | null {
    const event = headers["x-github-event"];
    if (!event) return null;
    const action = (body as Record<string, unknown>)?.action ?? "";
    return action ? `github.${event}.${action}` : `github.${event}`;
  },
  inferSubject(body: unknown): string | undefined {
    const data = body as Record<string, unknown>;
    const repo = data.repository as Record<string, unknown> | undefined;
    if (repo?.full_name) {
      const issue = data.issue as Record<string, unknown> | undefined;
      const pr = data.pull_request as Record<string, unknown> | undefined;
      if (issue?.number) return `github:${repo.full_name}#${issue.number}`;
      if (pr?.number) return `github:${repo.full_name}#${pr.number}`;
      return `github:${repo.full_name}`;
    }
    return undefined;
  },
};

export const githubUriPatterns = {
  issue: /^github:([^/]+)\/([^#]+)#(\d+)$/,
  pr: /^github:([^/]+)\/([^#]+)#(\d+)$/,
  repo: /^github:([^/]+)\/([^@#]+)$/,
  file: /^github:([^/]+)\/([^/]+)\/(.+)(?:@(.+))?$/,
};

export function extractGitHubUriComponents(uri: string): Record<string, string> | null {
  const match = uri.match(/^github:([^/]+)\/([^#@]+)(?:#(\d+))?(?:@(.+))?$/);
  if (!match) return null;

  const result: Record<string, string> = {
    owner: match[1]!,
    repo: match[2]!,
  };
  if (match[3]) result.number = match[3];
  if (match[4]) result.version = match[4];
  return result;
}

export function getGitHubContrib(config: GitHubConfig = {}): ProviderContrib {
  return {
    name: "github",
    createProvider: () => createGitHubProvider(config),
    linkExtractors: [githubLinkExtractor],
    formatHandlers: [githubIssueFormat],
    webhookInferrers: [githubWebhookInferrer],
    uriPatterns: {
      github: githubUriPatterns,
    },
    uriComponentExtractors: {
      github: extractGitHubUriComponents,
    },
  };
}

export { createGitHubProvider as default };
