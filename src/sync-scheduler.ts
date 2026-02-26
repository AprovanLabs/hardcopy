import type { SourceConfig } from "./config";
import type { SyncStats } from "./hardcopy/types";

interface SyncableHardcopy {
  loadConfig(): Promise<{ sources: SourceConfig[] }>;
  syncSource(sourceName: string): Promise<SyncStats>;
}

function gcd(a: number, b: number): number {
  while (b) {
    [a, b] = [b, a % b];
  }
  return a;
}

export class SyncScheduler {
  private hc: SyncableHardcopy;
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private lastSyncTimes = new Map<string, number>();

  constructor(hc: SyncableHardcopy) {
    this.hc = hc;
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    const config = await this.hc.loadConfig();
    const sources = config.sources.filter((s) => s.sync?.interval && s.sync.interval > 0);

    if (sources.length === 0) {
      this.running = false;
      return;
    }

    const intervals = sources.map((s) => s.sync!.interval!);
    const tickInterval = Math.max(intervals.reduce(gcd), 30) * 1000;

    await this.tick(sources);

    this.timer = setInterval(() => {
      this.tick(sources).catch((err) => {
        console.error("Sync scheduler tick error:", err);
      });
    }, tickInterval);
  }

  private async tick(sources: SourceConfig[]): Promise<void> {
    const now = Date.now();

    for (const source of sources) {
      const interval = (source.sync!.interval!) * 1000;
      const lastSync = this.lastSyncTimes.get(source.name) ?? 0;

      if (now - lastSync < interval) continue;

      try {
        const stats = await this.hc.syncSource(source.name);
        this.lastSyncTimes.set(source.name, Date.now());

        if (stats.nodes > 0 || stats.edges > 0) {
          console.log(`[sync] ${source.name}: ${stats.nodes} nodes, ${stats.edges} edges`);
        }

        if (stats.errors.length > 0) {
          for (const err of stats.errors) {
            console.error(`[sync] ${source.name}: ${err}`);
          }
        }
      } catch (err) {
        console.error(`[sync] ${source.name}: ${err}`);
      }
    }
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  isRunning(): boolean {
    return this.running;
  }
}
