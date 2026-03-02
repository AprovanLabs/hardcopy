import type { ProviderContrib } from "../../provider";
import type { WebhookInferrer } from "../../events/types";

export const stripeWebhookInferrer: WebhookInferrer = {
  provider: "stripe",
  inferType(body: unknown, _headers: Record<string, string>): string | null {
    const data = body as Record<string, unknown>;
    const stripeType = data.type;
    if (typeof stripeType === "string") {
      return `stripe.${stripeType}`;
    }
    return null;
  },
  inferSubject(body: unknown): string | undefined {
    const data = body as Record<string, unknown>;
    const eventData = data.data as Record<string, unknown> | undefined;
    const object = eventData?.object as Record<string, unknown> | undefined;
    if (object?.id && typeof object.id === "string") {
      const objectType = object.object || "object";
      return `stripe:${objectType}:${object.id}`;
    }
    return undefined;
  },
};

export function getStripeContrib(): ProviderContrib {
  return {
    name: "stripe",
    createProvider: () => {
      throw new Error("Stripe provider not implemented - use webhook inference only");
    },
    webhookInferrers: [stripeWebhookInferrer],
  };
}
