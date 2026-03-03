import { join } from "path";
import { mkdir } from "fs/promises";
import { Database } from "../db";
import { CRDTStore } from "../crdt";
import { ConflictStore } from "../conflict-store";
import { EventBus } from "../event-bus";
import { loadEnvFile } from "../env";
import { loadConfig, type Config } from "../config";
import { getProvider, type Provider } from "../provider";
import type { HardcopyOptions } from "./types";

export class Hardcopy {
  readonly root: string;
  readonly dataDir: string;
  private _db: Database | null = null;
  private _crdt: CRDTStore | null = null;
  private _config: Config | null = null;
  private _providers = new Map<string, Provider>();
  private _conflictStore: ConflictStore | null = null;
  private _eventBus: EventBus | null = null;

  constructor(options: HardcopyOptions) {
    this.root = options.root;
    this.dataDir = join(options.root, ".hardcopy");
  }

  async initialize(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    await loadEnvFile(join(this.dataDir, ".env"));
    await mkdir(join(this.dataDir, "crdt"), { recursive: true });
    this._db = await Database.open(join(this.dataDir, "db.sqlite"));
    this._crdt = new CRDTStore(join(this.dataDir, "crdt"));
  }

  async loadConfig(): Promise<Config> {
    if (this._config) return this._config;
    const configPath = join(this.root, "hardcopy.yaml");
    this._config = await loadConfig(configPath);
    await this.initializeProviders();
    return this._config;
  }

  private async initializeProviders(): Promise<void> {
    if (!this._config) return;
    for (const source of this._config.sources) {
      const factory = getProvider(source.provider);
      if (factory) {
        const provider = factory(source);
        this._providers.set(source.name, provider);
        if (provider.streams) {
          const bus = this.getEventBus();
          for (const stream of provider.streams) {
            bus.registerStream(stream);
          }
        }
      }
    }
  }

  getDatabase(): Database {
    if (!this._db) throw new Error("Database not initialized");
    return this._db;
  }

  getCRDTStore(): CRDTStore {
    if (!this._crdt) throw new Error("CRDT store not initialized");
    return this._crdt;
  }

  getConflictStore(): ConflictStore {
    if (!this._conflictStore) {
      this._conflictStore = new ConflictStore(join(this.dataDir, "conflicts"));
    }
    return this._conflictStore;
  }

  getProviders(): Map<string, Provider> {
    return this._providers;
  }

  getEventBus(): EventBus {
    if (!this._eventBus) {
      this._eventBus = new EventBus(this.getDatabase());
    }
    return this._eventBus;
  }

  async close(): Promise<void> {
    if (this._eventBus) {
      await this._eventBus.detachAll();
      this._eventBus = null;
    }
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
  }
}
