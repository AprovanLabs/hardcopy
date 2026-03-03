import type { ProviderContrib, Provider, Tool } from "../provider";
import type { WebhookInferrer } from "../events/types";
import type { Node, Change, FetchRequest, FetchResult, PushResult } from "../types";

export const stripeWebhookInferrer: WebhookInferrer = {
  provider: "stripe",

  inferType(body: unknown, headers: Record<string, string>): string | null {
    const p = body as Record<string, unknown>;
    const eventType = p.type as string | undefined;
    if (eventType) return `stripe.${eventType}`;
    return null;
  },

  inferSubject(body: unknown): string | undefined {
    const p = body as Record<string, unknown>;
    const data = p.data as Record<string, unknown> | undefined;
    const object = data?.object as Record<string, unknown> | undefined;
    const id = object?.id as string | undefined;
    return id ? `stripe:${id}` : undefined;
  },
};

export interface StripeConfig {
  apiKey?: string;
}

export function createStripeProvider(config: StripeConfig): Provider {
  const apiKey = config.apiKey ?? process.env["STRIPE_API_KEY"];

  async function fetchWithAuth(url: string, options: RequestInit = {}): Promise<Response> {
    const headers = new Headers(options.headers);
    if (apiKey) {
      headers.set("Authorization", `Bearer ${apiKey}`);
    }
    return fetch(url, { ...options, headers });
  }

  return {
    name: "stripe",
    nodeTypes: ["stripe.Customer", "stripe.Subscription", "stripe.Invoice", "stripe.PaymentIntent"],
    edgeTypes: ["stripe.HAS_SUBSCRIPTION", "stripe.HAS_INVOICE"],

    async fetch(request: FetchRequest): Promise<FetchResult> {
      const nodes: Node[] = [];
      const edges: { type: string; fromId: string; toId: string }[] = [];
      let cursor = request.cursor;
      let hasMore = false;

      const url = cursor
        ? `https://api.stripe.com/v1/customers?starting_after=${cursor}`
        : "https://api.stripe.com/v1/customers?limit=100";

      const response = await fetchWithAuth(url);

      if (!response.ok) {
        return { nodes, edges, cursor, hasMore, versionToken: null };
      }

      const data = (await response.json()) as StripeListResult;

      for (const customer of data.data) {
        nodes.push({
          id: `stripe:customer:${customer.id}`,
          type: "stripe.Customer",
          attrs: {
            email: customer.email,
            name: customer.name,
            created: new Date(customer.created * 1000).toISOString(),
            metadata: customer.metadata,
          },
        });
      }

      hasMore = data.has_more;
      if (hasMore && data.data.length > 0) {
        cursor = data.data[data.data.length - 1].id;
      }

      return { nodes, edges, cursor, hasMore, versionToken: null };
    },

    async push(node: Node, changes: Change[]): Promise<PushResult> {
      return { success: false, error: "Stripe nodes are read-only" };
    },

    async fetchNode(nodeId: string): Promise<Node | null> {
      const match = nodeId.match(/^stripe:customer:(.+)$/);
      if (!match) return null;

      const [, id] = match;
      const response = await fetchWithAuth(`https://api.stripe.com/v1/customers/${id}`);

      if (response.status === 404) return null;
      if (!response.ok) {
        const error = await response.text();
        throw new Error(error);
      }

      const customer = (await response.json()) as StripeCustomer;
      return {
        id: `stripe:customer:${customer.id}`,
        type: "stripe.Customer",
        attrs: {
          email: customer.email,
          name: customer.name,
          created: new Date(customer.created * 1000).toISOString(),
          metadata: customer.metadata,
        },
      };
    },

    getTools(): Tool[] {
      return [
        { name: "stripe.getCustomer", description: "Get customer details" },
        { name: "stripe.listSubscriptions", description: "List customer subscriptions" },
      ];
    },
  };
}

interface StripeCustomer {
  id: string;
  email: string | null;
  name: string | null;
  created: number;
  metadata: Record<string, string>;
}

interface StripeListResult {
  data: StripeCustomer[];
  has_more: boolean;
}

const stripeUriPatterns: Record<string, RegExp> = {
  customer: /^stripe:customer:(.+)$/,
  subscription: /^stripe:subscription:(.+)$/,
  invoice: /^stripe:invoice:(.+)$/,
};

function stripeUriComponentExtractor(uri: string): Record<string, string> | null {
  for (const [type, pattern] of Object.entries(stripeUriPatterns)) {
    const match = uri.match(pattern);
    if (match) {
      return { type, id: match[1] };
    }
  }
  return null;
}

export function getStripeContrib(): ProviderContrib {
  return {
    name: "stripe",
    createProvider: () => createStripeProvider({}),
    webhookInferrers: [stripeWebhookInferrer],
    uriPatterns: { stripe: stripeUriPatterns },
    uriComponentExtractors: { stripe: stripeUriComponentExtractor },
  };
}
