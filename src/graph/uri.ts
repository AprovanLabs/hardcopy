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

export const URI_PATTERNS = {
  github: {
    issue: /^github:([^/]+)\/([^#]+)#(\d+)$/,
    pr: /^github:([^/]+)\/([^#]+)#(\d+)$/,
    repo: /^github:([^/]+)\/([^@#]+)$/,
    file: /^github:([^/]+)\/([^/]+)\/(.+)(?:@(.+))?$/,
  },
  jira: {
    issue: /^jira:([A-Z]+-\d+)$/,
  },
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

export function extractUriComponents(uri: string): Record<string, string> | null {
  const parsed = parseUri(uri);
  if (!parsed) return null;

  const result: Record<string, string> = {
    scheme: parsed.scheme,
    path: parsed.path,
  };

  if (parsed.fragment) result.fragment = parsed.fragment;
  if (parsed.version) result.version = parsed.version;

  if (parsed.scheme === "github") {
    const parts = parsed.path.split("/");
    if (parts.length >= 2) {
      result.owner = parts[0]!;
      result.repo = parts[1]!;
      if (parts.length > 2) {
        result.file = parts.slice(2).join("/");
      }
    }
    if (parsed.fragment) {
      result.number = parsed.fragment;
    }
  } else if (parsed.scheme === "jira") {
    const match = parsed.path.match(/^([A-Z]+)-(\d+)$/);
    if (match) {
      result.project = match[1]!;
      result.number = match[2]!;
    }
  }

  return result;
}
