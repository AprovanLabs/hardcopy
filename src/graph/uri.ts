import type { ParsedUri } from "./types";

const URI_REGEX = /^([a-zA-Z][a-zA-Z0-9+.-]*):(.+?)(?:#([^@]+))?(?:@(.+))?$/;

export function parseUri(uri: string): ParsedUri | null {
  const match = uri.match(URI_REGEX);
  if (!match) return null;

  const [, scheme, pathAndFragment, fragment, version] = match;
  let path = pathAndFragment!;
  let actualFragment = fragment;

  if (!actualFragment && path.includes("#")) {
    const hashIdx = path.indexOf("#");
    actualFragment = path.slice(hashIdx + 1);
    path = path.slice(0, hashIdx);
  }

  return {
    scheme: scheme!,
    path,
    fragment: actualFragment,
    version,
    raw: uri,
  };
}

export function buildUri(
  scheme: string,
  path: string,
  fragment?: string,
  version?: string
): string {
  let uri = `${scheme}:${path}`;
  if (fragment) uri += `#${fragment}`;
  if (version) uri += `@${version}`;
  return uri;
}

export function normalizeUri(uri: string): string {
  const parsed = parseUri(uri);
  if (!parsed) return uri;
  return buildUri(parsed.scheme, parsed.path, parsed.fragment);
}

export function withVersion(uri: string, version: string): string {
  const parsed = parseUri(uri);
  if (!parsed) return uri;
  return buildUri(parsed.scheme, parsed.path, parsed.fragment, version);
}

export function stripVersion(uri: string): string {
  const parsed = parseUri(uri);
  if (!parsed) return uri;
  return buildUri(parsed.scheme, parsed.path, parsed.fragment);
}

export function getScheme(uri: string): string | null {
  const parsed = parseUri(uri);
  return parsed?.scheme ?? null;
}

export function isValidUri(uri: string): boolean {
  return parseUri(uri) !== null;
}

export function matchesPattern(uri: string, pattern: string): boolean {
  const parsed = parseUri(uri);
  if (!parsed) return false;

  const patternParsed = parseUri(pattern.replace(/\*/g, "__WILDCARD__"));
  if (!patternParsed) {
    const regexPattern = pattern
      .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\\\*/g, ".*");
    return new RegExp(`^${regexPattern}$`).test(uri);
  }

  if (patternParsed.scheme !== parsed.scheme && !patternParsed.scheme.includes("__WILDCARD__")) {
    return false;
  }

  const pathPattern = patternParsed.path
    .replace(/__WILDCARD__/g, ".*")
    .replace(/[.*+?^${}()|[\]\\]/g, (m) => (m === ".*" ? m : "\\" + m));
  
  if (!new RegExp(`^${pathPattern}$`).test(parsed.path)) {
    return false;
  }

  return true;
}

type UriPatternSet = Record<string, RegExp>;
type UriComponentExtractor = (uri: string) => Record<string, string> | null;

const uriPatterns = new Map<string, UriPatternSet>();
const uriComponentExtractors = new Map<string, UriComponentExtractor>();

const corePatterns: Record<string, UriPatternSet> = {
  file: {
    local: /^file:(.+)$/,
  },
  skill: {
    definition: /^skill:(.+)$/,
  },
  service: {
    namespace: /^service:([^/]+)$/,
    procedure: /^service:([^/]+)\/(.+)$/,
  },
};

for (const [scheme, patterns] of Object.entries(corePatterns)) {
  uriPatterns.set(scheme, patterns);
}

export function registerUriPatterns(scheme: string, patterns: UriPatternSet): void {
  uriPatterns.set(scheme, patterns);
}

export function getUriPatterns(scheme: string): UriPatternSet | undefined {
  return uriPatterns.get(scheme);
}

export function getAllUriPatterns(): Record<string, UriPatternSet> {
  const result: Record<string, UriPatternSet> = {};
  for (const [scheme, patterns] of uriPatterns) {
    result[scheme] = patterns;
  }
  return result;
}

export function registerUriComponentExtractor(scheme: string, extractor: UriComponentExtractor): void {
  uriComponentExtractors.set(scheme, extractor);
}

export function extractUriComponents(uri: string): Record<string, string> | null {
  const parsed = parseUri(uri);
  if (!parsed) return null;

  const result: Record<string, string> = {
    scheme: parsed.scheme,
    path: parsed.path,
  };

  if (parsed.fragment) result.fragment = parsed.fragment;
  if (parsed.version) result.version = parsed.version;

  const extractor = uriComponentExtractors.get(parsed.scheme);
  if (extractor) {
    const components = extractor(uri);
    if (components) {
      Object.assign(result, components);
    }
  }

  return result;
}

export const URI_PATTERNS = getAllUriPatterns();
