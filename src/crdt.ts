import { Loro, LoroDoc, LoroMap } from "loro-crdt";
import { readFile, writeFile, mkdir, access, rm } from "fs/promises";
import { dirname, join } from "path";

export class CRDTStore {
  private basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  private getPath(nodeId: string): string {
    const encoded = encodeURIComponent(nodeId);
    return join(this.basePath, `${encoded}.loro`);
  }

  async exists(nodeId: string): Promise<boolean> {
    try {
      await access(this.getPath(nodeId));
      return true;
    } catch {
      return false;
    }
  }

  async load(nodeId: string): Promise<LoroDoc | null> {
    const path = this.getPath(nodeId);
    try {
      const data = await readFile(path);
      const doc = new LoroDoc();
      doc.import(new Uint8Array(data));
      return doc;
    } catch {
      return null;
    }
  }

  async save(nodeId: string, doc: LoroDoc): Promise<void> {
    const path = this.getPath(nodeId);
    await mkdir(dirname(path), { recursive: true });
    const snapshot = doc.export({ mode: "snapshot" });
    await writeFile(path, Buffer.from(snapshot));
  }

  async create(nodeId: string): Promise<LoroDoc> {
    const doc = new LoroDoc();
    await this.save(nodeId, doc);
    return doc;
  }

  async loadOrCreate(nodeId: string): Promise<LoroDoc> {
    const existing = await this.load(nodeId);
    if (existing) return existing;
    return this.create(nodeId);
  }

  async delete(nodeId: string): Promise<void> {
    try {
      await rm(this.getPath(nodeId));
    } catch {
      // Ignore if not exists
    }
  }

  async merge(nodeId: string, remote: LoroDoc): Promise<LoroDoc> {
    const local = await this.loadOrCreate(nodeId);
    local.import(remote.export({ mode: "update" }));
    await this.save(nodeId, local);
    return local;
  }
}

export function setDocContent(doc: LoroDoc, content: string): void {
  const text = doc.getText("body");
  const current = text.toString();
  if (current !== content) {
    text.delete(0, current.length);
    text.insert(0, content);
  }
}

export function getDocContent(doc: LoroDoc): string {
  return doc.getText("body").toString();
}

export function setDocAttrs(doc: LoroDoc, attrs: Record<string, unknown>): void {
  const map = doc.getMap("attrs");
  for (const [key, value] of Object.entries(attrs)) {
    map.set(key, value);
  }
}

export function getDocAttrs(doc: LoroDoc): Record<string, unknown> {
  const map = doc.getMap("attrs");
  const result: Record<string, unknown> = {};
  for (const key of map.keys()) {
    result[key] = map.get(key);
  }
  return result;
}
