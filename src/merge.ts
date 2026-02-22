import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { llmMergeText, type LLMMergeOptions } from "./llm-merge";

export interface SemanticMergeOptions {
  tempDir?: string;
  filePath: string;
  /** LLM merge options (URL, model, etc.) */
  llmOptions?: LLMMergeOptions;
}

/**
 * Attempts a 3-way merge using diff3, with LLM fallback for conflicts.
 * Returns the merged text if successful, or null if merge fails entirely.
 */
export async function mergeText(
  base: string,
  local: string,
  remote: string,
  options: SemanticMergeOptions,
): Promise<string | null> {
  if (local === remote) return local;
  if (local === base) return remote;
  if (remote === base) return local;

  // Try diff3 first
  const diff3Result = await tryDiff3Merge(base, local, remote, options.tempDir);
  if (diff3Result !== null) {
    return diff3Result;
  }

  // Fall back to LLM merge for conflicts
  return llmMergeText(base, local, remote, options.llmOptions);
}

async function tryDiff3Merge(
  base: string,
  local: string,
  remote: string,
  tempDir?: string,
): Promise<string | null> {
  const root = tempDir ?? join(tmpdir(), "hardcopy-merge");
  await mkdir(root, { recursive: true });
  const runDir = await mkdtemp(join(root, "merge-"));

  const basePath = join(runDir, "base");
  const localPath = join(runDir, "local");
  const remotePath = join(runDir, "remote");

  try {
    await writeFile(basePath, base);
    await writeFile(localPath, local);
    await writeFile(remotePath, remote);

    // diff3 -m: merge mode
    // Order: local, base, remote (diff3 convention)
    const result = spawnSync("diff3", ["-m", localPath, basePath, remotePath], {
      encoding: "utf-8",
    });

    // Exit code 0 = clean merge, 1 = conflicts, 2 = error
    if (result.status === 0 && typeof result.stdout === "string") {
      return result.stdout;
    }

    // Conflicts or error - return null
    return null;
  } catch {
    return null;
  } finally {
    await rm(runDir, { recursive: true, force: true });
  }
}
