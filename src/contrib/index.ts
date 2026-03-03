import { registerContrib } from "../provider";
import { registerFormat } from "../format";
import { registerLinkExtractor } from "../graph/links";
import { registerUriPatterns, registerUriComponentExtractor } from "../graph/uri";
import { registerWebhookInferrer } from "../events/types";

import { getGitHubContrib } from "./github";
import { getJiraContrib } from "./jira";
import { getStripeContrib } from "./stripe";

export function loadContrib(contrib: ReturnType<typeof getGitHubContrib>): void {
  registerContrib(contrib);

  if (contrib.linkExtractors) {
    for (const extractor of contrib.linkExtractors) {
      registerLinkExtractor(extractor);
    }
  }

  if (contrib.formatHandlers) {
    for (const handler of contrib.formatHandlers) {
      registerFormat(handler);
    }
  }

  if (contrib.webhookInferrers) {
    for (const inferrer of contrib.webhookInferrers) {
      registerWebhookInferrer(inferrer);
    }
  }

  if (contrib.uriPatterns) {
    for (const [scheme, patterns] of Object.entries(contrib.uriPatterns)) {
      registerUriPatterns(scheme, patterns);
    }
  }

  if (contrib.uriComponentExtractors) {
    for (const [scheme, extractor] of Object.entries(contrib.uriComponentExtractors)) {
      registerUriComponentExtractor(scheme, extractor);
    }
  }
}

export function loadAllContribs(): void {
  loadContrib(getGitHubContrib());
  loadContrib(getJiraContrib());
  loadContrib(getStripeContrib());
}

export { getGitHubContrib, createGitHubProvider, githubLinkExtractor, githubIssueFormat } from "./github";
export { getJiraContrib, jiraLinkExtractor } from "./jira";
export { getStripeContrib, stripeWebhookInferrer } from "./stripe";
