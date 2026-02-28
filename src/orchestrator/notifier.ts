import type { Session, ProgressEvent, ExternalNotifier } from "./types";

export interface GitHubNotifierConfig {
  token: string;
  owner: string;
  repo: string;
}

export class GitHubNotifier implements ExternalNotifier {
  private config: GitHubNotifierConfig;
  private baseUrl: string;

  constructor(config: GitHubNotifierConfig) {
    this.config = config;
    this.baseUrl = `https://api.github.com/repos/${config.owner}/${config.repo}`;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    const issueNumber = this.extractIssueNumber(session);
    if (!issueNumber) return;

    const body = this.formatProgressComment(session, progress);
    await this.postComment(issueNumber, body);
  }

  async sendCompletion(session: Session): Promise<void> {
    const issueNumber = this.extractIssueNumber(session);
    if (!issueNumber) return;

    const body = this.formatCompletionComment(session);
    await this.postComment(issueNumber, body);
  }

  private extractIssueNumber(session: Session): number | null {
    const events = session.events ?? [];
    for (const eventId of events) {
      const match = eventId.match(/issue[#:](\d+)/i);
      if (match) return parseInt(match[1]!, 10);
    }
    return null;
  }

  private formatProgressComment(session: Session, progress: ProgressEvent): string {
    const statusIcon = this.getStatusIcon(session.status);
    return `${statusIcon} **Skill Progress** - \`${session.skillId}\`\n\n` +
      `**Status:** ${session.status}\n` +
      `**Event:** ${progress.type}\n` +
      `**Time:** ${progress.timestamp}`;
  }

  private formatCompletionComment(session: Session): string {
    const statusIcon = this.getStatusIcon(session.status);
    let body = `${statusIcon} **Skill Execution ${session.status === "complete" ? "Complete" : "Failed"}**\n\n`;
    body += `**Skill:** \`${session.skillId}\`\n`;
    body += `**Duration:** ${this.formatDuration(session.startedAt, session.completedAt)}\n`;
    
    if (session.error) {
      body += `\n**Error:**\n\`\`\`\n${session.error}\n\`\`\``;
    }

    return body;
  }

  private getStatusIcon(status: string): string {
    switch (status) {
      case "complete": return "✅";
      case "failed": return "❌";
      case "cancelled": return "⏹️";
      case "running": return "🔄";
      default: return "⏳";
    }
  }

  private formatDuration(start: string, end?: string): string {
    if (!end) return "N/A";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (ms < 1000) return `${ms}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    return `${(ms / 60000).toFixed(1)}m`;
  }

  private async postComment(issueNumber: number, body: string): Promise<void> {
    try {
      await fetch(`${this.baseUrl}/issues/${issueNumber}/comments`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      });
    } catch {}
  }
}

export class WebhookNotifier implements ExternalNotifier {
  private webhookUrl: string;
  private headers: Record<string, string>;

  constructor(webhookUrl: string, headers: Record<string, string> = {}) {
    this.webhookUrl = webhookUrl;
    this.headers = headers;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    await this.send({
      type: "progress",
      session,
      progress,
    });
  }

  async sendCompletion(session: Session): Promise<void> {
    await this.send({
      type: "completion",
      session,
    });
  }

  private async send(payload: unknown): Promise<void> {
    try {
      await fetch(this.webhookUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...this.headers,
        },
        body: JSON.stringify(payload),
      });
    } catch {}
  }
}

export class CompositeNotifier implements ExternalNotifier {
  private notifiers: ExternalNotifier[];

  constructor(notifiers: ExternalNotifier[]) {
    this.notifiers = notifiers;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    await Promise.all(
      this.notifiers.map((n) => n.sendProgress(session, progress))
    );
  }

  async sendCompletion(session: Session): Promise<void> {
    await Promise.all(
      this.notifiers.map((n) => n.sendCompletion(session))
    );
  }
}
