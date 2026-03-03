import type { Session, ProgressEvent, ExternalNotifier } from "./types";

export interface GitHubNotifierConfig {
  token: string;
  owner?: string;
  repo?: string;
}

export class GitHubNotifier implements ExternalNotifier {
  private config: GitHubNotifierConfig;

  constructor(config: GitHubNotifierConfig) {
    this.config = config;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    const target = this.extractGitHubTarget(session);
    if (!target) return;

    const message = this.formatProgressMessage(progress);
    await this.postComment(target.owner, target.repo, target.issueNumber, message);
  }

  async sendCompletion(session: Session): Promise<void> {
    const target = this.extractGitHubTarget(session);
    if (!target) return;

    const message = this.formatCompletionMessage(session);
    await this.postComment(target.owner, target.repo, target.issueNumber, message);
  }

  private extractGitHubTarget(session: Session): {
    owner: string;
    repo: string;
    issueNumber: number;
  } | null {
    const eventData = session.result as Record<string, unknown> | undefined;
    const subject = eventData?.subject as string | undefined;

    if (subject?.startsWith("github:")) {
      const match = subject.match(/^github:([^/]+)\/([^#]+)#(\d+)$/);
      if (match) {
        return {
          owner: match[1]!,
          repo: match[2]!,
          issueNumber: parseInt(match[3]!, 10),
        };
      }
    }

    if (this.config.owner && this.config.repo) {
      const issueNumber = eventData?.issueNumber as number | undefined;
      if (issueNumber) {
        return {
          owner: this.config.owner,
          repo: this.config.repo,
          issueNumber,
        };
      }
    }

    return null;
  }

  private formatProgressMessage(progress: ProgressEvent): string {
    switch (progress.type) {
      case "started":
        return `🚀 **Session started** (${progress.sessionId})\n\nProcessing...`;
      case "tool_call":
        const toolData = progress.data as { name?: string };
        return `🔧 Calling tool: \`${toolData.name ?? "unknown"}\``;
      case "complete":
        return `✅ **Session complete**`;
      case "error":
        const errorData = progress.data as { error?: string };
        return `❌ **Error**: ${errorData.error ?? "Unknown error"}`;
      default:
        return "";
    }
  }

  private formatCompletionMessage(session: Session): string {
    if (session.status === "complete") {
      const summary = this.summarizeResult(session.result);
      return `## ✅ Task Complete\n\n${summary}\n\n---\n*Session ID: ${session.id}*`;
    }

    if (session.status === "failed") {
      return `## ❌ Task Failed\n\n${session.error ?? "Unknown error"}\n\n---\n*Session ID: ${session.id}*`;
    }

    if (session.status === "cancelled") {
      return `## ⚠️ Task Cancelled\n\n---\n*Session ID: ${session.id}*`;
    }

    return "";
  }

  private summarizeResult(result: unknown): string {
    if (!result) return "No output generated.";
    if (typeof result === "string") return result;
    if (typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (obj.summary) return String(obj.summary);
      if (obj.message) return String(obj.message);
      if (obj.output) return String(obj.output);
    }
    return "Task completed successfully.";
  }

  private async postComment(
    owner: string,
    repo: string,
    issueNumber: number,
    body: string
  ): Promise<void> {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.token}`,
        Accept: "application/vnd.github.v3+json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ body }),
    });
  }
}

export interface JiraNotifierConfig {
  baseUrl: string;
  email: string;
  apiToken: string;
  projectKey?: string;
}

export class JiraNotifier implements ExternalNotifier {
  private config: JiraNotifierConfig;

  constructor(config: JiraNotifierConfig) {
    this.config = config;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    const issueKey = this.extractJiraIssueKey(session);
    if (!issueKey) return;

    const message = this.formatProgressMessage(progress);
    await this.addComment(issueKey, message);
  }

  async sendCompletion(session: Session): Promise<void> {
    const issueKey = this.extractJiraIssueKey(session);
    if (!issueKey) return;

    const message = this.formatCompletionMessage(session);
    await this.addComment(issueKey, message);
  }

  private extractJiraIssueKey(session: Session): string | null {
    const eventData = session.result as Record<string, unknown> | undefined;
    const subject = eventData?.subject as string | undefined;

    if (subject?.startsWith("jira:")) {
      return subject.slice(5);
    }

    const issueKey = eventData?.issueKey as string | undefined;
    if (issueKey) {
      return issueKey;
    }

    return null;
  }

  private formatProgressMessage(progress: ProgressEvent): string {
    switch (progress.type) {
      case "started":
        return `🚀 *Session started* (${progress.sessionId})\n\nProcessing...`;
      case "tool_call":
        const toolData = progress.data as { name?: string };
        return `🔧 Calling tool: {{${toolData.name ?? "unknown"}}}`;
      case "complete":
        return `✅ *Session complete*`;
      case "error":
        const errorData = progress.data as { error?: string };
        return `❌ *Error*: ${errorData.error ?? "Unknown error"}`;
      default:
        return "";
    }
  }

  private formatCompletionMessage(session: Session): string {
    if (session.status === "complete") {
      const summary = this.summarizeResult(session.result);
      return `h2. ✅ Task Complete\n\n${summary}\n\n----\n_Session ID: ${session.id}_`;
    }

    if (session.status === "failed") {
      return `h2. ❌ Task Failed\n\n${session.error ?? "Unknown error"}\n\n----\n_Session ID: ${session.id}_`;
    }

    if (session.status === "cancelled") {
      return `h2. ⚠️ Task Cancelled\n\n----\n_Session ID: ${session.id}_`;
    }

    return "";
  }

  private summarizeResult(result: unknown): string {
    if (!result) return "No output generated.";
    if (typeof result === "string") return result;
    if (typeof result === "object") {
      const obj = result as Record<string, unknown>;
      if (obj.summary) return String(obj.summary);
      if (obj.message) return String(obj.message);
      if (obj.output) return String(obj.output);
    }
    return "Task completed successfully.";
  }

  private async addComment(issueKey: string, body: string): Promise<void> {
    const url = `${this.config.baseUrl}/rest/api/3/issue/${issueKey}/comment`;
    const auth = Buffer.from(`${this.config.email}:${this.config.apiToken}`).toString("base64");

    await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        body: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: body }],
            },
          ],
        },
      }),
    });
  }
}

export class CompositeNotifier implements ExternalNotifier {
  private notifiers: ExternalNotifier[];

  constructor(notifiers: ExternalNotifier[]) {
    this.notifiers = notifiers;
  }

  async sendProgress(session: Session, progress: ProgressEvent): Promise<void> {
    await Promise.allSettled(
      this.notifiers.map((n) => n.sendProgress(session, progress))
    );
  }

  async sendCompletion(session: Session): Promise<void> {
    await Promise.allSettled(
      this.notifiers.map((n) => n.sendCompletion(session))
    );
  }
}
