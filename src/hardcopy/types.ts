import type { Change, ConflictInfo } from "../types";

export interface HardcopyOptions {
  root: string;
}

export interface SyncStats {
  nodes: number;
  edges: number;
  errors: string[];
}

export interface StatusInfo {
  totalNodes: number;
  totalEdges: number;
  nodesByType: Record<string, number>;
  changedFiles: ChangedFile[];
  conflicts: ConflictInfo[];
}

export interface ChangedFile {
  path: string;
  fullPath: string;
  nodeId: string;
  nodeType: string;
  status: "new" | "modified" | "deleted";
  mtime: number;
  syncedAt: number;
}

export interface RefreshResult {
  rendered: number;
  orphaned: string[];
  cleaned: boolean;
}

export interface DiffResult {
  nodeId: string;
  nodeType: string;
  filePath: string;
  changes: Change[];
}

export interface PushStats {
  pushed: number;
  skipped: number;
  conflicts: number;
  errors: string[];
}
