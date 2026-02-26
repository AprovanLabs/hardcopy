import type { Hardcopy } from "./core";
import type { SyncStats } from "./types";
import type { NodeChange } from "../hooks/diff";
import { diffNodes } from "../hooks/diff";
import { getRateLimiter } from "../rate-limit";

export async function sync(this: Hardcopy): Promise<SyncStats> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const providers = this.getProviders();
  const stats: SyncStats = { nodes: 0, edges: 0, errors: [], changes: [] };

  for (const source of config.sources) {
    const provider = providers.get(source.name);
    if (!provider) {
      stats.errors.push(`Provider not found: ${source.provider}`);
      continue;
    }

    const limiter = getRateLimiter(source.provider);
    if (!limiter.acquire()) {
      stats.errors.push(`Rate limited: ${source.name}`);
      continue;
    }

    try {
      const existingNodes = await db.queryNodes(provider.nodeTypes[0]);
      const latestSync = existingNodes.reduce(
        (max, n) => Math.max(max, n.syncedAt ?? 0),
        0,
      );
      const latestToken = existingNodes.find((n) => n.versionToken)?.versionToken;

      const strategy = source.sync?.strategy ?? "full";

      const result = await provider.fetch({
        query: {},
        syncedAt: latestSync || undefined,
        versionToken: latestToken,
        strategy,
      });

      if (!result.cached) {
        const priorMap = new Map(
          (await db.getNodesByIds(result.nodes.map((n) => n.id))).map((n) => [n.id, n]),
        );
        const changes = diffNodes(priorMap, result.nodes);

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
        stats.changes.push(...changes);

        await this.getHookRunner()?.evaluate(changes, source.name);
      }
    } catch (err) {
      stats.errors.push(`Error syncing ${source.name}: ${err}`);
    }
  }

  return stats;
}

export async function syncSource(
  this: Hardcopy,
  sourceName: string,
): Promise<SyncStats> {
  const config = await this.loadConfig();
  const db = this.getDatabase();
  const providers = this.getProviders();
  const stats: SyncStats = { nodes: 0, edges: 0, errors: [], changes: [] };

  const source = config.sources.find((s) => s.name === sourceName);
  if (!source) {
    stats.errors.push(`Source not found: ${sourceName}`);
    return stats;
  }

  const provider = providers.get(source.name);
  if (!provider) {
    stats.errors.push(`Provider not found: ${source.provider}`);
    return stats;
  }

  const limiter = getRateLimiter(source.provider);
  if (!limiter.acquire()) {
    stats.errors.push(`Rate limited: ${source.name}`);
    return stats;
  }

  try {
    const existingNodes = await db.queryNodes(provider.nodeTypes[0]);
    const latestSync = existingNodes.reduce(
      (max, n) => Math.max(max, n.syncedAt ?? 0),
      0,
    );
    const latestToken = existingNodes.find((n) => n.versionToken)?.versionToken;

    const result = await provider.fetch({
      query: {},
      syncedAt: latestSync || undefined,
      versionToken: latestToken,
      strategy: source.sync?.strategy ?? "full",
    });

    if (!result.cached) {
      const priorMap = new Map(
        (await db.getNodesByIds(result.nodes.map((n) => n.id))).map((n) => [n.id, n]),
      );
      const changes = diffNodes(priorMap, result.nodes);

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
      stats.changes.push(...changes);

      await this.getHookRunner()?.evaluate(changes, source.name);
    }
  } catch (err) {
    stats.errors.push(`Error syncing ${source.name}: ${err}`);
  }

  return stats;
}
