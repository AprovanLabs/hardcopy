import type { LinkExtractor, ExtractedLink, ExtractorContext } from "./types";

export const githubExtractor: LinkExtractor = {
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

export const jiraExtractor: LinkExtractor = {
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

export const urlExtractor: LinkExtractor = {
  name: "url",
  patterns: [/https?:\/\/[^\s<>\[\]()]+/g],
  extract(content: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    const urlRegex = /https?:\/\/[^\s<>\[\]()]+/g;
    let match;
    while ((match = urlRegex.exec(content)) !== null) {
      const url = match[0].replace(/[.,;:!?]+$/, "");
      if (!seen.has(url)) {
        seen.add(url);
        links.push({
          targetUri: `url:${url}`,
          linkType: "LINKS_TO",
          position: { start: match.index, end: match.index + url.length },
        });
      }
    }

    return links;
  },
};

const defaultExtractors: LinkExtractor[] = [githubExtractor, jiraExtractor];

export class LinkExtractorRegistry {
  private extractors = new Map<string, LinkExtractor>();

  constructor() {
    for (const extractor of defaultExtractors) {
      this.register(extractor);
    }
  }

  register(extractor: LinkExtractor): void {
    this.extractors.set(extractor.name, extractor);
  }

  unregister(name: string): void {
    this.extractors.delete(name);
  }

  get(name: string): LinkExtractor | undefined {
    return this.extractors.get(name);
  }

  list(): LinkExtractor[] {
    return Array.from(this.extractors.values());
  }

  extractAll(content: string, context?: ExtractorContext): ExtractedLink[] {
    const allLinks: ExtractedLink[] = [];
    const seen = new Set<string>();

    for (const extractor of this.extractors.values()) {
      const links = extractor.extract(content, context);
      for (const link of links) {
        const key = `${link.targetUri}:${link.linkType}`;
        if (!seen.has(key)) {
          seen.add(key);
          allLinks.push(link);
        }
      }
    }

    return allLinks;
  }
}

export function extractLinks(content: string, context?: ExtractorContext): ExtractedLink[] {
  const registry = new LinkExtractorRegistry();
  return registry.extractAll(content, context);
}
