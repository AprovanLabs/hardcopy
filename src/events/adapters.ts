import { randomUUID } from "node:crypto";
import type { Envelope } from "./types";
import type { EventBus } from "./bus";

export interface WebhookConfig {
  pathPrefix?: string;
  secretHeader?: string;
  typeExtractor?: (body: unknown, headers: Record<string, string>) => string;
  sourceExtractor?: (body: unknown, headers: Record<string, string>) => string;
  subjectExtractor?: (body: unknown, headers: Record<string, string>) => string | undefined;
}

export interface ScheduleEntry {
  name: string;
  cron: string;
  metadata?: Record<string, unknown>;
}

export class WebhookAdapter {
  private bus: EventBus;
  private config: WebhookConfig;

  constructor(bus: EventBus, config: WebhookConfig = {}) {
    this.bus = bus;
    this.config = config;
  }

  async handle(
    provider: string,
    body: unknown,
    headers: Record<string, string> = {}
  ): Promise<Envelope> {
    const type = this.config.typeExtractor
      ? this.config.typeExtractor(body, headers)
      : this.inferType(provider, body, headers);

    const source = this.config.sourceExtractor
      ? this.config.sourceExtractor(body, headers)
      : `webhook:${provider}`;

    const subject = this.config.subjectExtractor
      ? this.config.subjectExtractor(body, headers)
      : this.inferSubject(provider, body);

    const envelope: Envelope = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      source,
      subject,
      data: body,
      metadata: {
        webhook: { provider, headers },
      },
    };

    await this.bus.publish(envelope);
    return envelope;
  }

  private inferType(provider: string, body: unknown, headers: Record<string, string>): string {
    if (provider === "github") {
      const event = headers["x-github-event"] ?? "unknown";
      const action = (body as Record<string, unknown>)?.action ?? "";
      return action ? `github.${event}.${action}` : `github.${event}`;
    }
    if (provider === "stripe") {
      const stripeType = (body as Record<string, unknown>)?.type;
      return stripeType ? `stripe.${stripeType}` : "stripe.event";
    }
    return `webhook.${provider}.event`;
  }

  private inferSubject(provider: string, body: unknown): string | undefined {
    const data = body as Record<string, unknown>;
    if (provider === "github") {
      const repo = data.repository as Record<string, unknown> | undefined;
      if (repo?.full_name) {
        const issue = data.issue as Record<string, unknown> | undefined;
        const pr = data.pull_request as Record<string, unknown> | undefined;
        if (issue?.number) return `github:${repo.full_name}#${issue.number}`;
        if (pr?.number) return `github:${repo.full_name}#${pr.number}`;
        return `github:${repo.full_name}`;
      }
    }
    return undefined;
  }
}

export class ScheduleAdapter {
  private bus: EventBus;
  private schedules = new Map<string, { entry: ScheduleEntry; timer: ReturnType<typeof setInterval> }>();

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  register(entry: ScheduleEntry): void {
    if (this.schedules.has(entry.name)) {
      this.unregister(entry.name);
    }

    const interval = this.cronToMs(entry.cron);
    if (interval <= 0) {
      throw new Error(`Invalid cron expression: ${entry.cron}`);
    }

    const timer = setInterval(() => this.trigger(entry), interval);
    this.schedules.set(entry.name, { entry, timer });
  }

  unregister(name: string): void {
    const schedule = this.schedules.get(name);
    if (schedule) {
      clearInterval(schedule.timer);
      this.schedules.delete(name);
    }
  }

  async trigger(entry: ScheduleEntry): Promise<Envelope> {
    const envelope: Envelope = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type: "schedule.triggered",
      source: `schedule:${entry.name}`,
      subject: undefined,
      data: { scheduleName: entry.name, cron: entry.cron },
      metadata: {
        schedule: { name: entry.name, ...entry.metadata },
      },
    };

    await this.bus.publish(envelope);
    return envelope;
  }

  async triggerNow(name: string): Promise<Envelope | null> {
    const schedule = this.schedules.get(name);
    if (!schedule) return null;
    return this.trigger(schedule.entry);
  }

  list(): ScheduleEntry[] {
    return Array.from(this.schedules.values()).map((s) => s.entry);
  }

  stop(): void {
    for (const [name] of this.schedules) {
      this.unregister(name);
    }
  }

  private cronToMs(cron: string): number {
    const parts = cron.trim().split(/\s+/);
    if (parts.length === 1) {
      if (cron === "@hourly") return 60 * 60 * 1000;
      if (cron === "@daily") return 24 * 60 * 60 * 1000;
      if (cron === "@weekly") return 7 * 24 * 60 * 60 * 1000;
      const match = cron.match(/^@every\s+(\d+)([smhd])$/);
      if (match) {
        const value = parseInt(match[1]!, 10);
        const unit = match[2];
        if (unit === "s") return value * 1000;
        if (unit === "m") return value * 60 * 1000;
        if (unit === "h") return value * 60 * 60 * 1000;
        if (unit === "d") return value * 24 * 60 * 60 * 1000;
      }
    }
    if (parts.length === 5) {
      const minute = parts[0]!;
      if (minute === "*") return 60 * 1000;
      if (minute.startsWith("*/")) {
        const interval = parseInt(minute.slice(2), 10);
        return interval * 60 * 1000;
      }
    }
    return 60 * 60 * 1000;
  }
}

export class ManualAdapter {
  private bus: EventBus;

  constructor(bus: EventBus) {
    this.bus = bus;
  }

  async emit(
    type: string,
    data: unknown,
    options: { source?: string; subject?: string; metadata?: Record<string, unknown> } = {}
  ): Promise<Envelope> {
    const envelope: Envelope = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      type,
      source: options.source ?? "manual:cli",
      subject: options.subject,
      data,
      metadata: {
        manual: { emittedBy: "user" },
        ...options.metadata,
      },
    };

    await this.bus.publish(envelope);
    return envelope;
  }
}
