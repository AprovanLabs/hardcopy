import type { Node } from "../../types";

export function parseIssueId(
  nodeId: string,
): { owner: string; repo: string; number: number } | null {
  const match = nodeId.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return null;
  const [, owner, repo, num] = match;
  return { owner: owner!, repo: repo!, number: parseInt(num!, 10) };
}

export function createIssueId(
  owner: string,
  repo: string,
  number: number,
): string {
  return `github:${owner}/${repo}#${number}`;
}

export function issueToNode(
  owner: string,
  repo: string,
  issue: GitHubIssueData,
): Node {
  return {
    id: createIssueId(owner, repo, issue.number),
    type: "github.Issue",
    attrs: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      labels:
        issue.labels?.map((l) => (typeof l === "string" ? l : l.name)) ?? [],
      assignee: issue.assignee?.login,
      assignees: issue.assignees?.map((a) => a.login) ?? [],
      milestone: issue.milestone?.title,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      closed_at: issue.closed_at,
      url: issue.html_url,
      repository: `${owner}/${repo}`,
      author: issue.user?.login,
      comments: issue.comments,
      locked: issue.locked,
    },
  };
}

export interface GitHubIssueData {
  number: number;
  title: string;
  body: string | null;
  state: "open" | "closed";
  labels?: (string | { name: string })[];
  assignee?: { login: string } | null;
  assignees?: { login: string }[];
  milestone?: { title: string } | null;
  created_at: string;
  updated_at: string;
  closed_at?: string | null;
  html_url: string;
  user?: { login: string };
  comments?: number;
  locked?: boolean;
}
