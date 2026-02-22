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

export interface GitHubConfig {
  orgs?: string[];
  repos?: string[];
  token?: string;
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

        const etag = response.headers.get("ETag");
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

registerProvider("github", (config) =>
  createGitHubProvider(config as GitHubConfig),
);

export { createGitHubProvider as default };
