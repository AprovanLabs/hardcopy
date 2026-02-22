import { exec } from "child_process";
import { promisify } from "util";
import { readFile, access } from "fs/promises";
import { join } from "path";
import type { Provider, Tool } from "../../provider";
import type {
  Node,
  Edge,
  Change,
  FetchRequest,
  FetchResult,
  PushResult,
} from "../../types";
import { registerProvider } from "../../provider";

const execAsync = promisify(exec);

export interface GitConfig {
  repositories?: { path: string }[];
  links?: {
    edge: string;
    to: string;
    match: string;
  }[];
}

async function execGit(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execAsync(`git ${args.join(" ")}`, { cwd });
  return stdout.trim();
}

async function getWorktrees(repoPath: string): Promise<Worktree[]> {
  const output = await execGit(repoPath, "worktree", "list", "--porcelain");
  const worktrees: Worktree[] = [];
  let current: Partial<Worktree> = {};

  for (const line of output.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (current.path) worktrees.push(current as Worktree);
      current = { path: line.slice(9) };
    } else if (line.startsWith("HEAD ")) {
      current.head = line.slice(5);
    } else if (line.startsWith("branch ")) {
      current.branch = line.slice(7).replace("refs/heads/", "");
    } else if (line === "bare") {
      current.bare = true;
    } else if (line === "detached") {
      current.detached = true;
    }
  }

  if (current.path) worktrees.push(current as Worktree);
  return worktrees;
}

async function getBranches(repoPath: string): Promise<string[]> {
  try {
    const output = await execGit(
      repoPath,
      "branch",
      "-a",
      "--format=%(refname:short)",
    );
    return output.split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

async function readWorktreeMeta(
  path: string,
): Promise<Record<string, unknown> | null> {
  const metaPath = join(path, ".a2a", "session.json");
  try {
    await access(metaPath);
    const content = await readFile(metaPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

export function createGitProvider(config: GitConfig): Provider {
  return {
    name: "git",
    nodeTypes: ["git.Branch", "git.Worktree", "git.Commit"],
    edgeTypes: ["git.TRACKS", "git.CONTAINS", "git.WORKTREE_OF"],

    async fetch(request: FetchRequest): Promise<FetchResult> {
      const nodes: Node[] = [];
      const edges: Edge[] = [];

      for (const repoConfig of config.repositories ?? []) {
        const repoPath = repoConfig.path.replace(
          /^~/,
          process.env["HOME"] ?? "",
        );

        try {
          const head = await execGit(repoPath, "rev-parse", "HEAD");
          if (request.versionToken === head) {
            return {
              nodes,
              edges,
              hasMore: false,
              cached: true,
              versionToken: head,
            };
          }

          const worktrees = await getWorktrees(repoPath);
          const branches = await getBranches(repoPath);

          for (const wt of worktrees) {
            const nodeId = `git:worktree:${wt.path}`;
            const meta = await readWorktreeMeta(wt.path);

            nodes.push({
              id: nodeId,
              type: "git.Worktree",
              attrs: {
                path: wt.path,
                branch: wt.branch,
                head: wt.head,
                bare: wt.bare,
                detached: wt.detached,
                meta,
              },
            });

            if (wt.branch) {
              edges.push({
                type: "git.WORKTREE_OF",
                fromId: `git:branch:${repoPath}:${wt.branch}`,
                toId: nodeId,
              });
            }
          }

          for (const branch of branches) {
            const branchNodeId = `git:branch:${repoPath}:${branch}`;
            const worktree = worktrees.find((wt) => wt.branch === branch);

            nodes.push({
              id: branchNodeId,
              type: "git.Branch",
              attrs: {
                name: branch,
                repository: repoPath,
                worktreePath: worktree?.path,
              },
            });

            if (config.links) {
              for (const link of config.links) {
                if (link.edge === "git.TRACKS" && worktree) {
                  const meta = await readWorktreeMeta(worktree.path);
                  if (meta?.a2a && typeof meta.a2a === "object") {
                    const a2aMeta = meta.a2a as Record<string, unknown>;
                    if (a2aMeta["task_id"]) {
                      edges.push({
                        type: "git.TRACKS",
                        fromId: branchNodeId,
                        toId: `a2a:${a2aMeta["task_id"]}`,
                      });
                    }
                  }
                }
              }
            }
          }
        } catch {
          // Skip invalid repositories
        }
      }

      return { nodes, edges, hasMore: false };
    },

    async push(node: Node, changes: Change[]): Promise<PushResult> {
      return { success: false, error: "Git push not implemented via provider" };
    },

    async fetchNode(_nodeId: string): Promise<Node | null> {
      return null;
    },

    getTools(): Tool[] {
      return [
        { name: "git.checkout", description: "Checkout branch" },
        { name: "git.push", description: "Push changes" },
        { name: "git.createBranch", description: "Create new branch" },
        {
          name: "git.createWorktree",
          description: "Create worktree for branch",
        },
      ];
    },
  };
}

interface Worktree {
  path: string;
  head?: string;
  branch?: string;
  bare?: boolean;
  detached?: boolean;
}

registerProvider("git", (config) => createGitProvider(config as GitConfig));

export { createGitProvider as default };
