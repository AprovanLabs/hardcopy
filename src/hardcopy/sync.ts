import type { Hardcopy } from "./core";
import type { SyncStats } from "./types";

export async function sync(this: Hardcopy): Promise<SyncStats> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const providers = this.getProviders();
  const stats: SyncStats = { nodes: 0, edges: 0, errors: [] };

  for (const source of config.sources) {
    const provider = providers.get(source.name);
    if (!provider) {
      stats.errors.push(`Provider not found: ${source.provider}`);
      continue;
    }

    try {
      const result = await provider.fetch({ query: {} });
      if (!result.cached) {
        await db.upsertNodes(
          result.nodes.map((n) => ({
            ...n,
            syncedAt: Date.now(),
            versionToken: result.versionToken ?? undefined,
          })),
        );
        await db.upsertEdges(result.edges);
        stats.nodes += result.nodes.length;
        stats.edges += result.edges.length;
      }
    } catch (err) {
      stats.errors.push(`Error syncing ${source.name}: ${err}`);
    }
  }

  return stats;
}
