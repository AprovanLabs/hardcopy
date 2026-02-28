import type { LinkExtractor, ExtractedLink, ExtractorContext } from "./types";

export class GitHubLinkExtractor implements LinkExtractor {
  name = "github";
  patterns = [
    /https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:issues|pull)\/(\d+)/g,
    /#(\d+)(?=\s|$|[.,;:!?)])/g,
    /([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)#(\d+)/g,
  ];

  extract(content: string, context?: ExtractorContext): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    for (const match of content.matchAll(this.patterns[0]!)) {
      const [, owner, repo, number] = match;
      const uri = `github:${owner}/${repo}#${number}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "references",
          position: { start: match.index!, end: match.index! + match[0].length },
        });
      }
    }

    const ownerRepo = this.extractOwnerRepo(context?.sourceUri);
    if (ownerRepo) {
      for (const match of content.matchAll(this.patterns[1]!)) {
        const [, number] = match;
        const uri = `github:${ownerRepo}#${number}`;
        if (!seen.has(uri)) {
          seen.add(uri);
          links.push({
            targetUri: uri,
            linkType: "references",
            position: { start: match.index!, end: match.index! + match[0].length },
          });
        }
      }
    }

    for (const match of content.matchAll(this.patterns[2]!)) {
      const [, owner, repo, number] = match;
      const uri = `github:${owner}/${repo}#${number}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "references",
          position: { start: match.index!, end: match.index! + match[0].length },
        });
      }
    }

    return links;
  }

  private extractOwnerRepo(sourceUri?: string): string | null {
    if (!sourceUri) return null;
    const match = sourceUri.match(/^github:([^/]+\/[^#@]+)/);
    return match ? match[1]! : null;
  }
}

export class JiraLinkExtractor implements LinkExtractor {
  name = "jira";
  patterns = [
    /https?:\/\/[^/]+\.atlassian\.net\/browse\/([A-Z]+-\d+)/g,
    /\b([A-Z]{2,}-\d+)\b/g,
  ];

  private projectPrefixes: Set<string>;

  constructor(projectPrefixes: string[] = []) {
    this.projectPrefixes = new Set(projectPrefixes);
  }

  extract(content: string, context?: ExtractorContext): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    for (const match of content.matchAll(this.patterns[0]!)) {
      const [, key] = match;
      const uri = `jira:${key}`;
      if (!seen.has(uri)) {
        seen.add(uri);
        links.push({
          targetUri: uri,
          linkType: "references",
          position: { start: match.index!, end: match.index! + match[0].length },
        });
      }
    }

    if (this.projectPrefixes.size > 0) {
      for (const match of content.matchAll(this.patterns[1]!)) {
        const [, key] = match;
        const prefix = key!.split("-")[0]!;
        if (this.projectPrefixes.has(prefix)) {
          const uri = `jira:${key}`;
          if (!seen.has(uri)) {
            seen.add(uri);
            links.push({
              targetUri: uri,
              linkType: "references",
              position: { start: match.index!, end: match.index! + match[0].length },
            });
          }
        }
      }
    }

    return links;
  }
}

export class UrlLinkExtractor implements LinkExtractor {
  name = "url";
  patterns = [/https?:\/\/[^\s<>\[\]()'"]+/g];

  extract(content: string): ExtractedLink[] {
    const links: ExtractedLink[] = [];
    const seen = new Set<string>();

    for (const match of content.matchAll(this.patterns[0]!)) {
      const url = match[0];
      if (!seen.has(url)) {
        seen.add(url);
        links.push({
          targetUri: `url:${url}`,
          linkType: "links_to",
          position: { start: match.index!, end: match.index! + url.length },
        });
      }
    }

    return links;
  }
}

export class LinkExtractorRegistry {
  private extractors = new Map<string, LinkExtractor>();
  private typeMapping = new Map<string, string[]>();

  register(extractor: LinkExtractor): void {
    this.extractors.set(extractor.name, extractor);
  }

  setTypeMapping(contentType: string, extractorNames: string[]): void {
    this.typeMapping.set(contentType, extractorNames);
  }

  getExtractorsForType(contentType: string): LinkExtractor[] {
    const names = this.typeMapping.get(contentType) ?? Array.from(this.extractors.keys());
    return names
      .map((name) => this.extractors.get(name))
      .filter((e): e is LinkExtractor => e !== undefined);
  }

  extractAll(content: string, context?: ExtractorContext): ExtractedLink[] {
    const type = context?.sourceType ?? "*";
    const extractors = this.getExtractorsForType(type);
    const allLinks: ExtractedLink[] = [];
    const seen = new Set<string>();

    for (const extractor of extractors) {
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

export function createDefaultExtractorRegistry(): LinkExtractorRegistry {
  const registry = new LinkExtractorRegistry();
  registry.register(new GitHubLinkExtractor());
  registry.register(new JiraLinkExtractor());
  registry.register(new UrlLinkExtractor());
  return registry;
}
