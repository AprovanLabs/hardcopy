import type { ProviderContrib } from "../../provider";
import type { LinkExtractor, ExtractedLink } from "../../graph/types";
import type { WebhookInferrer } from "../../events/types";

export const jiraLinkExtractor: LinkExtractor = {
  name: "jira",
  patterns: [
    /\b([A-Z][A-Z0-9]+-\d+)\b/g,
    /https:\/\/[^/]+\/browse\/([A-Z][A-Z0-9]+-\d+)/g,
  ],
  extract(content: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const ticketRegex = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
    let match;
    while ((match = ticketRegex.exec(content)) !== null) {
      const uri = `jira:${match[1]}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "jira.REFERENCES",
          position: { start: match.index, end: match.index + match[0].length },
        });
      }
    }

    return links;
  },
};

export const jiraUriPatterns = {
  issue: /^jira:([A-Z]+-\d+)$/,
};

export function extractJiraUriComponents(uri: string): Record<string, string> | null {
  const match = uri.match(/^jira:([A-Z]+)-(\d+)$/);
  if (!match) return null;
  return {
    project: match[1]!,
    number: match[2]!,
  };
}

export const jiraWebhookInferrer: WebhookInferrer = {
  provider: "jira",
  inferType(body: unknown, _headers: Record<string, string>): string | null {
    const data = body as Record<string, unknown>;
    const webhookEvent = data.webhookEvent;
    if (typeof webhookEvent === "string") {
      return `jira.${webhookEvent.replace(/:/g, ".")}`;
    }
    return null;
  },
  inferSubject(body: unknown): string | undefined {
    const data = body as Record<string, unknown>;
    const issue = data.issue as Record<string, unknown> | undefined;
    if (issue?.key && typeof issue.key === "string") {
      return `jira:${issue.key}`;
    }
    return undefined;
  },
};

export function getJiraContrib(): ProviderContrib {
  return {
    name: "jira",
    createProvider: () => {
      throw new Error("Jira provider not implemented - use link extraction only");
    },
    linkExtractors: [jiraLinkExtractor],
    webhookInferrers: [jiraWebhookInferrer],
    uriPatterns: {
      jira: jiraUriPatterns,
    },
    uriComponentExtractors: {
      jira: extractJiraUriComponents,
    },
  };
}
