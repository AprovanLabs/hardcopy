import type { ProviderContrib } from "../provider";
import type { LinkExtractor, ExtractedLink, ExtractorContext } from "../graph/types";
import type { WebhookInferrer } from "../events/types";
import type { FormatHandler, ParsedFile } from "../format";
import type { Node } from "../types";
import { createGitHubProvider as createProvider, type GitHubConfig } from "../providers/github";
import { parseUri } from "../graph/uri";

export const githubLinkExtractor: LinkExtractor = {
  name: "github",
  patterns: [
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/g,
    /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g,
    /https:\/\/github\.com\/([^/]+)\/([^/]+)/g,
    /(?:^|\s)#(\d+)(?:\s|$)/g,
  ],

  extract(content: string, context?: ExtractorContext): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const issueRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/issues\/(\d+)/g;
    let match;
    while ((match = issueRegex.exec(content)) !== null) {
      const [, owner, repo, num] = match;
      const targetUri = `github:${owner}/${repo}#${num}`;
      if (!seen.has(targetUri)) {
        seen.add(targetUri);
        links.push({
          targetUri,
          linkType: "REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    const prRegex = /https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/g;
    while ((match = prRegex.exec(content)) !== null) {
      const [, owner, repo, num] = match;
      const targetUri = `github:${owner}/${repo}#${num}`;
      if (!seen.has(targetUri)) {
        seen.add(targetUri);
        links.push({
          targetUri,
          linkType: "REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    if (context?.sourceUri) {
      const sourceParsed = parseUri(context.sourceUri);
      if (sourceParsed?.scheme === "github") {
        const relativeRegex = /(?:^|\s)#(\d+)(?:\s|$)/g;
        while ((match = relativeRegex.exec(content)) !== null) {
          const [, num] = match;
          const targetUri = `github:${sourceParsed.path}#${num}`;
          if (!seen.has(targetUri) && targetUri !== context.sourceUri) {
            seen.add(targetUri);
            links.push({
              targetUri,
              linkType: "MENTIONS",
              position: { start: match.index, end: match.index + match[0].length },
            });
          }
        }
      }
    }

    return links;
  },
};

export const githubWebhookInferrer: WebhookInferrer = {
  provider: "github",

  inferType(body: unknown, headers: Record<string, string>): string | null {
    const eventType = headers["x-github-event"];
    if (eventType) return `github.${eventType}`;

    const p = body as Record<string, unknown>;
    const action = p.action as string | undefined;
    if (p.issue) return `github.issue.${action ?? "event"}`;
    if (p.pull_request) return `github.pull_request.${action ?? "event"}`;
    if (p.pusher) return "github.push";
    if (p.release) return `github.release.${action ?? "event"}`;
    return `github.${action ?? "webhook"}`;
  },

  inferSubject(body: unknown): string | undefined {
    const p = body as Record<string, unknown>;
    const repo = p.repository as Record<string, unknown> | undefined;
    const repoName = repo?.full_name as string | undefined;

    if (p.issue) {
      const issue = p.issue as Record<string, unknown>;
      return `github:${repoName}#${issue.number}`;
    }
    if (p.pull_request) {
      const pr = p.pull_request as Record<string, unknown>;
      return `github:${repoName}#${pr.number}`;
    }
    if (repoName) return `github:${repoName}`;
    return undefined;
  },
};

export const githubIssueFormat: FormatHandler = {
  type: "github.Issue",
  editableFields: ["title", "body", "state", "labels", "assignee", "milestone"],

  render(node: Node): string {
    const attrs = node.attrs;
    const frontmatter = [
      "---",
      `number: ${attrs.number}`,
      `state: ${attrs.state}`,
      attrs.labels?.length ? `labels: [${(attrs.labels as string[]).join(", ")}]` : null,
      attrs.assignee ? `assignee: ${attrs.assignee}` : null,
      attrs.milestone ? `milestone: ${attrs.milestone}` : null,
      `created_at: ${attrs.created_at}`,
      `updated_at: ${attrs.updated_at}`,
      "---",
    ]
      .filter(Boolean)
      .join("\n");

    return `${frontmatter}\n\n# ${attrs.title}\n\n${attrs.body ?? ""}`;
  },

  parse(content: string): ParsedFile {
    const lines = content.split("\n");
    const attrs: Record<string, unknown> = {};
    let inFrontmatter = false;
    let bodyStart = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "---") {
        if (!inFrontmatter) {
          inFrontmatter = true;
        } else {
          bodyStart = i + 1;
          break;
        }
      } else if (inFrontmatter) {
        const colonIdx = line.indexOf(":");
        if (colonIdx > 0) {
          const key = line.slice(0, colonIdx).trim();
          let value: unknown = line.slice(colonIdx + 1).trim();
          if (value === "null" || value === "") value = null;
          else if (typeof value === "string" && value.startsWith("[") && value.endsWith("]")) {
            value = value
              .slice(1, -1)
              .split(",")
              .map((s) => s.trim());
          }
          attrs[key] = value;
        }
      }
    }

    const body = lines.slice(bodyStart).join("\n").trim();
    const titleMatch = body.match(/^#\s+(.+)$/m);
    let bodyContent = body;
    if (titleMatch) {
      attrs.title = titleMatch[1];
      const titleEnd = body.indexOf("\n", body.indexOf(titleMatch[0]));
      bodyContent = body.slice(titleEnd + 1).trim();
    }

    return { attrs, body: bodyContent };
  },
};

const githubUriPatterns: Record<string, RegExp> = {
  issue: /^github:([^/]+\/[^#]+)#(\d+)$/,
  repo: /^github:([^/]+\/[^#]+)$/,
  user: /^github:user:([^/]+)$/,
  label: /^github:label:([^:]+):(.+)$/,
};

function githubUriComponentExtractor(uri: string): Record<string, string> | null {
  for (const [type, pattern] of Object.entries(githubUriPatterns)) {
    const match = uri.match(pattern);
    if (match) {
      if (type === "issue") return { type: "issue", repo: match[1], number: match[2] };
      if (type === "repo") return { type: "repo", repo: match[1] };
      if (type === "user") return { type: "user", username: match[1] };
      if (type === "label") return { type: "label", repo: match[1], label: match[2] };
    }
  }
  return null;
}

export function createGitHubProvider(config?: GitHubConfig) {
  return createProvider(config ?? {});
}

export function getGitHubContrib(): ProviderContrib {
  return {
    name: "github",
    createProvider: () => createGitHubProvider(),
    linkExtractors: [githubLinkExtractor],
    formatHandlers: [githubIssueFormat],
    webhookInferrers: [githubWebhookInferrer],
    uriPatterns: { github: githubUriPatterns },
    uriComponentExtractors: { github: githubUriComponentExtractor },
  };
}
