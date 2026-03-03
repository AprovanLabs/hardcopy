import type { LinkExtractor, ExtractedLink, ExtractorContext } from "./types";

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

const globalExtractors = new Map<string, LinkExtractor>();

export function registerLinkExtractor(extractor: LinkExtractor): void {
  globalExtractors.set(extractor.name, extractor);
}

export function unregisterLinkExtractor(name: string): void {
  globalExtractors.delete(name);
}

export function getLinkExtractor(name: string): LinkExtractor | undefined {
  return globalExtractors.get(name);
}

export function listLinkExtractors(): LinkExtractor[] {
  return Array.from(globalExtractors.values());
}

export class LinkExtractorRegistry {
  private extractors = new Map<string, LinkExtractor>();

  constructor(includeGlobal = true) {
    if (includeGlobal) {
      for (const extractor of globalExtractors.values()) {
        this.extractors.set(extractor.name, extractor);
      }
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
