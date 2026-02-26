import { spawn } from "node:child_process";
import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";
import type { HookConfig } from "../config";
import type { NodeChange } from "./diff";
import { matchesTrigger } from "./match";
import { renderHookTemplate } from "./template";

export class HookRunner {
  private hooks: HookConfig[];
  private dataDir: string;
  private active = new Map<string, ReturnType<typeof spawn>>();

  constructor(hooks: HookConfig[], dataDir: string) {
    this.hooks = hooks;
    this.dataDir = dataDir;
  }

  async evaluate(changes: NodeChange[], sourceName: string): Promise<void> {
    for (const change of changes) {
      for (const hook of this.hooks) {
        if (matchesTrigger(change, hook.on, sourceName)) {
          await this.execute(hook, change, sourceName);
        }
      }
    }
  }

  private async execute(hook: HookConfig, change: NodeChange, sourceName: string): Promise<void> {
    const dedupKey = `${hook.name}:${change.node.id}`;
    const background = hook.background ?? true;

    if (background && this.active.has(dedupKey)) return;

    const command = renderHookTemplate(hook.run, change, sourceName);
    const env = {
      ...process.env,
      ...hook.env,
      HC_NODE_ID: change.node.id,
      HC_NODE_TYPE: change.node.type,
      HC_CHANGE_TYPE: change.type,
      HC_SOURCE: sourceName,
    };

    if (background) {
      const logDir = join(this.dataDir, "hooks");
      await mkdir(logDir, { recursive: true });
      const logPath = join(logDir, `${hook.name}-${Date.now()}.log`);
      const logFile = await open(logPath, "w");

      const child = spawn("sh", ["-c", command], {
        cwd: hook.cwd,
        env,
        stdio: ["ignore", logFile.fd, logFile.fd],
      });

      this.active.set(dedupKey, child);
      child.on("exit", () => {
        this.active.delete(dedupKey);
        logFile.close().catch(() => {});
      });
    } else {
      await new Promise<void>((resolve, reject) => {
        const child = spawn("sh", ["-c", command], {
          cwd: hook.cwd,
          env,
          stdio: "inherit",
        });
        child.on("exit", (code) => {
          if (code !== 0) reject(new Error(`Hook ${hook.name} exited with code ${code}`));
          else resolve();
        });
        child.on("error", reject);
      });
    }
  }
}
