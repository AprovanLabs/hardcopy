export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export class RateLimiter {
  private tokens: number;
  private maxTokens: number;
  private windowMs: number;
  private lastRefill: number;
  private remaining: number | null = null;
  private resetAt: number | null = null;

  constructor(config: RateLimiterConfig) {
    this.maxTokens = config.maxRequests;
    this.tokens = config.maxRequests;
    this.windowMs = config.windowMs;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.windowMs) {
      this.tokens = this.maxTokens;
      this.lastRefill = now;
    } else {
      const rate = this.maxTokens / this.windowMs;
      const added = Math.floor(elapsed * rate);
      if (added > 0) {
        this.tokens = Math.min(this.maxTokens, this.tokens + added);
        this.lastRefill = now;
      }
    }
  }

  acquire(): boolean {
    if (this.resetAt && Date.now() < this.resetAt) {
      return false;
    }

    this.refill();

    if (this.remaining !== null && this.remaining <= 0) {
      return false;
    }

    if (this.tokens <= 0) {
      return false;
    }

    this.tokens--;
    return true;
  }

  updateFromHeaders(headers: Headers): void {
    const remaining = headers.get("X-RateLimit-Remaining");
    if (remaining !== null) {
      this.remaining = parseInt(remaining, 10);
    }

    const reset = headers.get("X-RateLimit-Reset");
    if (reset !== null) {
      this.resetAt = parseInt(reset, 10) * 1000;
    }

    const retryAfter = headers.get("Retry-After");
    if (retryAfter !== null) {
      this.resetAt = Date.now() + parseInt(retryAfter, 10) * 1000;
      this.remaining = 0;
    }
  }

  get headroom(): number {
    this.refill();
    if (this.remaining !== null) {
      return Math.min(this.tokens, this.remaining);
    }
    return this.tokens;
  }
}

const limiters = new Map<string, RateLimiter>();

const PROVIDER_DEFAULTS: Record<string, RateLimiterConfig> = {
  github: { maxRequests: 5000, windowMs: 3600000 },
};

export function getRateLimiter(provider: string): RateLimiter {
  let limiter = limiters.get(provider);
  if (!limiter) {
    const config = PROVIDER_DEFAULTS[provider] ?? { maxRequests: 1000, windowMs: 3600000 };
    limiter = new RateLimiter(config);
    limiters.set(provider, limiter);
  }
  return limiter;
}
