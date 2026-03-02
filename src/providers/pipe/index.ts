import type { Provider, Tool } from "../../provider";
import type { Node, Change, FetchRequest, FetchResult, PushResult } from "../../types";
import { registerProvider } from "../../provider";
import type { PipeConfig } from "../../config";

export interface PipeProviderConfig {
  pipes?: PipeConfig[];
}

export function createPipeProvider(_config: PipeProviderConfig): Provider {
  return {
    name: "pipe",

    async fetch(_request: FetchRequest): Promise<FetchResult> {
      return { nodes: [], edges: [], hasMore: false, cached: true };
    },

    async push(_node: Node, _changes: Change[]): Promise<PushResult> {
      return { success: false, error: "Pipe provider is read-only" };
    },

    async fetchNode(_nodeId: string): Promise<Node | null> {
      return null;
    },

    getTools(): Tool[] {
      return [];
    },
  };
}

registerProvider("pipe", (config) => createPipeProvider(config as PipeProviderConfig));

export { createPipeProvider as default };
