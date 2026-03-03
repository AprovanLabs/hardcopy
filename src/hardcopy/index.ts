import { registerFormat } from "../format";
import { githubIssueFormat } from "../formats/github-issue";
import "../providers";

import { Hardcopy } from "./core";
import { sync } from "./sync";
import { getViews, refreshView } from "./views";
import { diff, getChangedFiles } from "./diff";
import {
  push,
  status,
  listConflicts,
  getConflict,
  getConflictDetail,
  resolveConflict,
} from "./push";

registerFormat(githubIssueFormat);

// Extend Hardcopy prototype with operation methods
declare module "./core" {
  interface Hardcopy {
    sync(): Promise<import("./types").SyncStats>;
    getViews(): Promise<string[]>;
    refreshView(
      viewPath: string,
      options?: { clean?: boolean },
    ): Promise<import("./types").RefreshResult>;
    diff(
      pattern?: string,
      options?: { smart?: boolean },
    ): Promise<import("./types").DiffResult[]>;
    getChangedFiles(pattern?: string): Promise<import("./types").ChangedFile[]>;
    push(
      filePath?: string,
      options?: { force?: boolean },
    ): Promise<import("./types").PushStats>;
    status(): Promise<import("./types").StatusInfo>;
    listConflicts(): Promise<import("../types").ConflictInfo[]>;
    getConflict(nodeId: string): Promise<import("../types").ConflictInfo | null>;
    getConflictDetail(nodeId: string): Promise<{
      info: import("../types").ConflictInfo;
      body: string;
      artifactPath: string;
    } | null>;
    resolveConflict(
      nodeId: string,
      resolution: Record<string, "local" | "remote">,
    ): Promise<void>;
  }
}

Hardcopy.prototype.sync = sync;
Hardcopy.prototype.getViews = getViews;
Hardcopy.prototype.refreshView = refreshView;
Hardcopy.prototype.diff = diff;
Hardcopy.prototype.getChangedFiles = getChangedFiles;
Hardcopy.prototype.push = push;
Hardcopy.prototype.status = status;
Hardcopy.prototype.listConflicts = listConflicts;
Hardcopy.prototype.getConflict = getConflict;
Hardcopy.prototype.getConflictDetail = getConflictDetail;
Hardcopy.prototype.resolveConflict = resolveConflict;

export { Hardcopy } from "./core";
export { initHardcopy } from "./init";
export * from "./types";
